/**
 * W-009 — outbound webhooks: fan-out, the claim, the send, backoff,
 * dead-letter, pause/disable (API PRD §8).
 *
 * THE LOG IS THE SOURCE. Nothing emits. `fanOut` reads committed published
 * events past each active endpoint's `cursorSeq` and inserts one
 * `WebhookDelivery` per (endpoint, event) — unique, so running it twice or in
 * two processes at once can never make two rows. Because `seq` is handed out
 * at commit (W-D18), "everything above my cursor" never skips a row that
 * commits late: it would have the higher number.
 *
 * THE CLAIM is A-048's: one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP
 * LOCKED) RETURNING`, so two sweeps never send one row. A row left `sending`
 * longer than `STALE_SENDING_MS` is reclaimed — the ONE double-send door, the
 * same trade the notification outbox makes: a process killed mid-send would
 * otherwise strand the delivery forever, and a receiver must dedupe on the
 * event id anyway (at-least-once, §8).
 *
 * TWO CARRIERS, one code path (W-D20, W-D23). `sweepWebhooks` runs inline
 * after a write through Next's `after()` (on Vercel that is `waitUntil`), and
 * once a day on the reminders cron. Inline is the happy path; if it never
 * runs, the daily sweep delivers the same rows, later.
 *
 * Backoff is "not before", stored in `nextAttemptAt` and asked as a predicate
 * — never a sleep (A-051). Every inline sweep (any write, any business) also
 * picks up retries that are due, so on a working day a 1-minute retry goes
 * out with the next write after a minute; on a quiet day, with the daily cron.
 */
import type { PrismaClient } from '@bookable/db';
import { type ZoneId, fromDate, instant, toDate } from '@bookable/core/time';
import type { AppointmentView } from './appointments';
import { type EventBody, type EventRow, PUBLISHED_LOG_TYPES, eventBodies, published } from './events';
import { SIGNATURE_HEADER, signatureHeader } from './webhook-signature';
import { assertDeliverable, allowPrivateWebhooks } from './webhook-url';

/** Wait before attempt 2..6 (§8, W-D20): after the 6th failure the delivery is `dead`. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
/** Consecutive failed attempts (across deliveries) that pause an endpoint. */
export const PAUSE_AFTER = 10;
export const SEND_TIMEOUT_MS = 10_000;
export const STALE_SENDING_MS = 15 * 60_000;
const EXCERPT_BYTES = 1024;

export interface WebhookDeps {
  prisma: PrismaClient;
  now: () => Date;
  fetch?: typeof fetch;
  allowPrivate?: boolean;
}

export interface SweepResult {
  queued: number;
  succeeded: number;
  failed: number;
  dead: number;
}

const contactsOf = async (db: PrismaClient, clientId: string | undefined) =>
  clientId ? db.client.findUnique({ where: { id: clientId }, select: { phone: true, email: true } }) : null;

/** Delivery rows for every committed published event past each active endpoint's cursor. */
export async function fanOut(deps: WebhookDeps, businessId?: string): Promise<number> {
  const { prisma } = deps;
  let queued = 0;
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { status: 'active', ...(businessId ? { businessId } : {}) }, select: { id: true } });
  for (const { id } of endpoints) {
    queued += await prisma.$transaction(async (tx) => {
      // SKIP LOCKED: a concurrent sweep is already fanning this endpoint out.
      const [ep] = await tx.$queryRaw<{ businessId: string; cursorSeq: number; eventTypes: string[]; timezone: string }[]>`
        SELECT e."businessId", e."cursorSeq", e."eventTypes", b.timezone
          FROM "WebhookEndpoint" e JOIN "Business" b ON b.id = e."businessId"
         WHERE e.id = ${id} AND e.status = 'active' FOR UPDATE OF e SKIP LOCKED`;
      if (!ep) return 0;
      const events: EventRow[] = await tx.appointmentEvent.findMany({
        where: { businessId: ep.businessId, seq: { gt: ep.cursorSeq }, type: { in: [...PUBLISHED_LOG_TYPES] } },
        orderBy: { seq: 'asc' },
        take: 500,
        select: { id: true, businessId: true, appointmentId: true, type: true, seq: true, payload: true, createdAt: true },
      });
      if (events.length === 0) return 0;
      const wanted = events.filter((e) => ep.eventTypes.length === 0 || ep.eventTypes.includes(published(e.type, e.payload)!.type));
      // Capture the snapshots now, the earliest the pipeline sees the event (W-D19).
      await eventBodies(tx as unknown as PrismaClient, wanted, ep.timezone as ZoneId, deps.now());
      const { count } = await tx.webhookDelivery.createMany({
        data: wanted.map((e) => ({ endpointId: id, eventId: e.id, seq: e.seq!, createdAt: deps.now(), updatedAt: deps.now() })),
        skipDuplicates: true,
      });
      await tx.webhookEndpoint.update({ where: { id }, data: { cursorSeq: events[events.length - 1]!.seq! } });
      return count;
    });
  }
  return queued;
}

interface Claimed {
  id: string;
  endpointId: string;
  eventId: string;
  attempts: number;
  replayed: boolean;
}

/** One due delivery, claimed (`sending`, attempts + 1), or null. Lowest seq first. */
export async function claimDelivery(deps: WebhookDeps, opts: { businessId?: string; skipEndpoints?: readonly string[] } = {}): Promise<Claimed | null> {
  const now = deps.now();
  const staleBefore = toDate(instant(fromDate(now) - STALE_SENDING_MS));
  const rows = await deps.prisma.$queryRaw<Claimed[]>`
    UPDATE "WebhookDelivery" AS d
       SET status = 'sending', attempts = d.attempts + 1, "firstAttemptAt" = COALESCE(d."firstAttemptAt", ${now}), "updatedAt" = ${now}
     WHERE d.id = (
             SELECT c.id
               FROM "WebhookDelivery" c JOIN "WebhookEndpoint" e ON e.id = c."endpointId"
              WHERE e.status = 'active'
                AND (${opts.businessId ?? null}::text IS NULL OR e."businessId" = ${opts.businessId ?? null})
                AND NOT (c."endpointId" = ANY(${[...(opts.skipEndpoints ?? [])]}::text[]))
                AND ((c.status IN ('pending', 'failed') AND (c."nextAttemptAt" IS NULL OR c."nextAttemptAt" <= ${now}))
                     OR (c.status = 'sending' AND c."updatedAt" < ${staleBefore}))
              ORDER BY c.seq, c.id
              LIMIT 1
                FOR UPDATE OF c SKIP LOCKED)
    RETURNING d.id, d."endpointId", d."eventId", d.attempts, d.replayed`;
  return rows[0] ?? null;
}

/** The exact bytes a delivery sends: the event's stored body, plus contacts only when the endpoint asked (§6.8, OQ-W5). */
export async function deliveryBody(db: PrismaClient, delivery: { eventId: string; replayed: boolean }, endpoint: { includeClientContact: boolean }, zone: ZoneId, now: Date): Promise<string> {
  const event = await db.appointmentEvent.findUniqueOrThrow({
    where: { id: delivery.eventId },
    select: { id: true, businessId: true, appointmentId: true, type: true, seq: true, payload: true, createdAt: true },
  });
  const [body] = await eventBodies(db, [event], zone, now, delivery.replayed);
  let out: EventBody = body!;
  if (endpoint.includeClientContact) {
    const c = await contactsOf(db, out.data.appointment.client?.id);
    if (c) out = { ...out, data: { ...out.data, appointment: { ...out.data.appointment, client: { ...out.data.appointment.client!, phone: c.phone, email: c.email } as AppointmentView['client'] } } };
  }
  return JSON.stringify(out);
}

type Outcome = { ok: true; status: number; excerpt: string } | { ok: false; status: number | null; excerpt: string | null; error: string };

async function send(deps: WebhookDeps, url: string, headers: Record<string, string>, body: string): Promise<Outcome> {
  try {
    await assertDeliverable(url, deps.allowPrivate ?? allowPrivateWebhooks());
    const res = await (deps.fetch ?? fetch)(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    const excerpt = (await res.text().catch(() => '')).slice(0, EXCERPT_BYTES);
    return res.status >= 200 && res.status < 300 ? { ok: true, status: res.status, excerpt } : { ok: false, status: res.status, excerpt, error: `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, status: null, excerpt: null, error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : 'unknown error' };
  }
}

/** Send one claimed delivery and record what happened, on the delivery and on its endpoint. */
export async function deliver(deps: WebhookDeps, claimed: Claimed): Promise<'succeeded' | 'failed' | 'dead'> {
  const { prisma } = deps;
  const now = deps.now();
  const ep = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: claimed.endpointId }, include: { business: { select: { timezone: true } } } });
  const body = await deliveryBody(prisma, claimed, ep, ep.business.timezone as ZoneId, now);
  const event = JSON.parse(body) as EventBody;
  const secrets = [ep.secret];
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'Bookable-Webhooks/1',
    [SIGNATURE_HEADER]: signatureHeader(secrets, Math.floor(now.getTime() / 1000), body),
    'Bookable-Event-Id': event.id,
    'Bookable-Event-Type': event.type,
    'Bookable-Delivery-Id': claimed.id,
    'Bookable-Attempt': String(claimed.attempts),
  };
  const outcome = await send(deps, ep.url, headers, body);

  if (outcome.ok) {
    await prisma.$transaction([
      prisma.webhookDelivery.update({
        where: { id: claimed.id },
        data: { status: 'succeeded', succeededAt: now, nextAttemptAt: null, lastResponseStatus: outcome.status, lastResponseExcerpt: outcome.excerpt, lastError: null, updatedAt: now },
      }),
      prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { consecutiveFailures: 0 } }),
    ]);
    return 'succeeded';
  }

  const dead = claimed.attempts >= MAX_ATTEMPTS;
  const failures = ep.consecutiveFailures + 1;
  // §8: a 410 says "this endpoint is gone" — disable now. Ten failures in a row pause it.
  const gone = outcome.status === 410;
  const endpointPatch = gone
    ? { consecutiveFailures: failures, status: 'disabled' as const, disabledAt: now, disabledReason: 'The receiver answered 410 Gone.' }
    : failures >= PAUSE_AFTER
      ? { consecutiveFailures: failures, status: 'paused' as const, disabledAt: now, disabledReason: `${failures} deliveries in a row failed; last: ${outcome.error}.` }
      : { consecutiveFailures: failures };
  await prisma.$transaction([
    prisma.webhookDelivery.update({
      where: { id: claimed.id },
      data: {
        status: dead ? 'dead' : 'failed',
        nextAttemptAt: dead ? null : toDate(instant(fromDate(now) + BACKOFF_MS[claimed.attempts - 1]!)),
        lastResponseStatus: outcome.status,
        lastResponseExcerpt: outcome.excerpt,
        lastError: outcome.error,
        updatedAt: now,
      },
    }),
    prisma.webhookEndpoint.update({ where: { id: ep.id }, data: endpointPatch }),
  ]);
  return dead ? 'dead' : 'failed';
}

/**
 * Fan out, then send what is due, lowest seq first. An endpoint that fails
 * once is left alone for the rest of this sweep — its backoff starts now, and
 * a dead receiver must not cost the sweep ten seconds per queued row.
 */
export async function sweepWebhooks(deps: WebhookDeps, opts: { businessId?: string; maxSends?: number } = {}): Promise<SweepResult> {
  const result: SweepResult = { queued: await fanOut(deps, opts.businessId), succeeded: 0, failed: 0, dead: 0 };
  const skip: string[] = [];
  for (let i = 0; i < (opts.maxSends ?? 50); i++) {
    const claimed = await claimDelivery(deps, { businessId: opts.businessId, skipEndpoints: skip });
    if (!claimed) break;
    const outcome = await deliver(deps, claimed);
    result[outcome]++;
    if (outcome !== 'succeeded') skip.push(claimed.endpointId);
  }
  return result;
}
