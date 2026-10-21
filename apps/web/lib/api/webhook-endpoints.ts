/**
 * W-009 — registering a webhook endpoint (owner-only; the UI is W-011).
 *
 * A new endpoint starts at the business's CURRENT sequence: it receives what
 * happens from now on, not the salon's history. A receiver that wants the
 * past pulls it from `GET /v1/events?since=0` (§8 "Catch-up").
 */
import { fromDate, instant, toDate } from '@bookable/core/time';
import type { PrismaClient } from '@bookable/db';
import { type PublishedType, published } from './events';
import { newWebhookSecret } from './webhook-signature';
import { assertDeliverable, checkWebhookUrl } from './webhook-url';

export const PUBLISHED_TYPES: readonly PublishedType[] = [
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.reassigned',
  'appointment.cancelled',
  'appointment.status_changed',
  'appointment.status_corrected',
];

export class WebhookEndpointRejected extends Error {
  constructor(public readonly field: 'url' | 'eventTypes', why: string) {
    super(why);
    this.name = 'WebhookEndpointRejected';
  }
}

/** The secret is returned ONCE, here; the owner pastes it into the receiver. */
export async function createWebhookEndpoint(
  db: PrismaClient,
  args: { businessId: string; url: string; eventTypes?: readonly string[]; includeClientContact?: boolean; allowPrivate?: boolean },
): Promise<{ id: string; secret: string }> {
  let url: string;
  try {
    url = checkWebhookUrl(args.url, args.allowPrivate);
    await assertDeliverable(url, args.allowPrivate);
  } catch (error) {
    throw new WebhookEndpointRejected('url', error instanceof Error ? error.message : 'invalid url');
  }
  const eventTypes = [...new Set(args.eventTypes ?? [])];
  const unknown = eventTypes.filter((t) => !(PUBLISHED_TYPES as readonly string[]).includes(t));
  if (unknown.length > 0) throw new WebhookEndpointRejected('eventTypes', `not a published event type: ${unknown.join(', ')}`);
  const seq = await db.businessEventSeq.findUnique({ where: { businessId: args.businessId }, select: { last: true } });
  const secret = newWebhookSecret();
  const { id } = await db.webhookEndpoint.create({
    data: { businessId: args.businessId, url, secret, eventTypes, includeClientContact: args.includeClientContact ?? false, cursorSeq: seq?.last ?? 0 },
    select: { id: true },
  });
  return { id, secret };
}

/** §8: after a rotation the old secret keeps signing for this long. */
export const ROTATION_OVERLAP_MS = 24 * 3_600_000;

/**
 * W-010 — a new secret, returned once. The old one keeps signing until the
 * overlap ends, so the owner can update the receiver at leisure; rotating
 * again inside the overlap drops the oldest (only one previous is kept).
 */
export async function rotateWebhookSecret(db: PrismaClient, args: { businessId: string; endpointId: string; now: Date }): Promise<{ secret: string }> {
  const ep = await db.webhookEndpoint.findFirst({ where: { id: args.endpointId, businessId: args.businessId }, select: { secret: true } });
  if (!ep) throw new WebhookEndpointRejected('url', 'no such endpoint');
  const secret = newWebhookSecret();
  await db.webhookEndpoint.update({
    where: { id: args.endpointId },
    data: { secret, previousSecret: ep.secret, previousSecretExpiresAt: toDate(instant(fromDate(args.now) + ROTATION_OVERLAP_MS)) },
  });
  return { secret };
}

// ─────────────────────────── W-011: the owner's page ───────────────────────────

export async function listWebhookEndpoints(db: PrismaClient, businessId: string) {
  return db.webhookEndpoint.findMany({
    where: { businessId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      url: true,
      eventTypes: true,
      includeClientContact: true,
      status: true,
      consecutiveFailures: true,
      disabledAt: true,
      disabledReason: true,
      cursorSeq: true,
      previousSecretExpiresAt: true,
      createdAt: true,
    },
  });
}

const ownEndpoint = async (db: PrismaClient, businessId: string, endpointId: string) => {
  const ep = await db.webhookEndpoint.findFirst({ where: { id: endpointId, businessId }, select: { id: true, cursorSeq: true } });
  if (!ep) throw new WebhookEndpointRejected('url', 'That endpoint is not one of yours.');
  return ep;
};

/** Edit where it sends and what. The secret and the cursor are untouched. */
export async function updateWebhookEndpoint(
  db: PrismaClient,
  args: { businessId: string; endpointId: string; url: string; eventTypes: readonly string[]; includeClientContact: boolean; allowPrivate?: boolean },
): Promise<void> {
  await ownEndpoint(db, args.businessId, args.endpointId);
  let url: string;
  try {
    url = checkWebhookUrl(args.url, args.allowPrivate);
    await assertDeliverable(url, args.allowPrivate);
  } catch (error) {
    throw new WebhookEndpointRejected('url', error instanceof Error ? error.message : 'invalid url');
  }
  const eventTypes = [...new Set(args.eventTypes)];
  const unknown = eventTypes.filter((t) => !(PUBLISHED_TYPES as readonly string[]).includes(t));
  if (unknown.length > 0) throw new WebhookEndpointRejected('eventTypes', `not a published event type: ${unknown.join(', ')}`);
  await db.webhookEndpoint.update({ where: { id: args.endpointId }, data: { url, eventTypes, includeClientContact: args.includeClientContact } });
}

/**
 * `active` resumes (failure count cleared, reason gone) — and a resumed
 * endpoint gets the backlog its cursor never passed (W-D20); `disabled` is the
 * owner switching it off, with that said as the reason.
 */
export async function setWebhookEndpointStatus(db: PrismaClient, args: { businessId: string; endpointId: string; to: 'active' | 'disabled'; now: Date }): Promise<void> {
  await ownEndpoint(db, args.businessId, args.endpointId);
  await db.webhookEndpoint.update({
    where: { id: args.endpointId },
    data:
      args.to === 'active'
        ? { status: 'active', consecutiveFailures: 0, disabledAt: null, disabledReason: null }
        : { status: 'disabled', disabledAt: args.now, disabledReason: 'Switched off by the owner.' },
  });
}

/**
 * Send ONE delivery again: `pending` now, `replayed: true` in the body, the
 * attempt count starting over (a fresh `Bookable-Attempt`, and six more tries
 * before `dead`). The body is the event's stored snapshot — what was true
 * then, not what is true now (§9.11). A row mid-send is left alone.
 */
export async function replayDelivery(db: PrismaClient, args: { businessId: string; deliveryId: string }): Promise<boolean> {
  const { count } = await db.webhookDelivery.updateMany({
    where: { id: args.deliveryId, status: { not: 'sending' }, endpoint: { businessId: args.businessId } },
    data: { status: 'pending', replayed: true, attempts: 0, nextAttemptAt: null, lastError: null },
  });
  return count === 1;
}

/**
 * "Replay from seq" for a receiver that cannot pull `/v1/events`: every
 * delivery this endpoint already has from `fromSeq` on is re-sent (as
 * `replayDelivery`), and the cursor is wound back so events it never had a
 * row for — before it was registered, or filtered out then — are fanned out
 * on the next sweep. Returns how many existing rows were re-queued.
 */
export async function replayFromSeq(db: PrismaClient, args: { businessId: string; endpointId: string; fromSeq: number }): Promise<number> {
  const ep = await ownEndpoint(db, args.businessId, args.endpointId);
  const fromSeq = Math.max(1, Math.trunc(args.fromSeq));
  return db.$transaction(async (tx) => {
    const { count } = await tx.webhookDelivery.updateMany({
      where: { endpointId: ep.id, seq: { gte: fromSeq }, status: { not: 'sending' } },
      data: { status: 'pending', replayed: true, attempts: 0, nextAttemptAt: null, lastError: null },
    });
    if (ep.cursorSeq >= fromSeq) await tx.webhookEndpoint.update({ where: { id: ep.id }, data: { cursorSeq: fromSeq - 1 } });
    return count;
  });
}

export interface DeliveryFilter {
  endpointId?: string;
  status?: string;
  eventType?: string;
}

/**
 * The delivery log, newest first, with the event's published type. The type
 * filter runs over the newest 200 rows that match the other filters.
 * ponytail: in-memory type filter; store the published type on the delivery
 * the day a log needs more than a page of one type.
 */
export async function listWebhookDeliveries(db: PrismaClient, businessId: string, filter: DeliveryFilter = {}, limit = 50) {
  const rows = await db.webhookDelivery.findMany({
    where: {
      endpoint: { businessId },
      ...(filter.endpointId ? { endpointId: filter.endpointId } : {}),
      ...(filter.status ? { status: filter.status as 'pending' } : {}),
    },
    orderBy: [{ seq: 'desc' }, { id: 'desc' }],
    take: 200,
    include: { event: { select: { type: true, payload: true } }, endpoint: { select: { url: true } } },
  });
  return rows
    .map((r) => ({ ...r, eventType: published(r.event.type, r.event.payload)?.type ?? r.event.type }))
    .filter((r) => !filter.eventType || r.eventType === filter.eventType)
    .slice(0, limit);
}
