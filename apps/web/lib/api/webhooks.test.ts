/**
 * W-009 — the webhook pipeline (API PRD §8, §9.8, §9.10, §9.13).
 *
 * The receiver is a scripted `fetch`: each test says what it answers, and the
 * clock is advanced by hand past each backoff — no sleeps, no real network.
 * W-010/W-013 point the same dispatcher at the real reference receiver.
 */
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { fromDate, instant, instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { bookAppointment } from '@bookable/db/booking';
import { resetDatabase } from '@bookable/db/testing';
import { seedTwoSalons, type Salon } from './testing';
import { WebhookEndpointRejected, createWebhookEndpoint } from './webhook-endpoints';
import { isPrivateAddress } from './webhook-url';
import { BACKOFF_MS, MAX_ATTEMPTS, PAUSE_AFTER, STALE_SENDING_MS, claimDelivery, deliver, fanOut, sweepWebhooks } from './webhooks';

const prisma = new PrismaClient();
const T0 = toDate(instantFromIso('2026-06-09T14:00:00Z'));
let clock = T0;
const advance = (ms: number) => (clock = toDate(instant(fromDate(clock) + ms)));

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}
let sent: Sent[];
let answers: number[];
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: String(init!.body) });
  return new Response('ok', { status: answers.shift() ?? 200 });
}) as typeof fetch;
const deps = () => ({ prisma, now: () => clock, fetch: fakeFetch, allowPrivate: false });

let a: Salon;
let b: Salon;
let dana: string;
let cut: string;
let maria: string;

beforeAll(async () => prisma.$connect());
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  clock = T0;
  nth = 0;
  sent = [];
  answers = [];
  await resetDatabase(prisma);
  ({ a, b } = await seedTwoSalons(prisma));
  dana = (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Dana' } })).id;
  cut = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Cut' } })).id;
  maria = (await prisma.client.create({ data: { businessId: a.businessId, name: 'Maria Gomez', phone: '+13125550142', email: 'maria@example.test' }, select: { id: true } })).id;
});

// Public IP literals: no DNS, and the send-time check passes them.
const endpoint = (args: { url?: string; eventTypes?: string[]; includeClientContact?: boolean; businessId?: string } = {}) =>
  createWebhookEndpoint(prisma, { businessId: args.businessId ?? a.businessId, url: args.url ?? 'https://203.0.113.10/hook', eventTypes: args.eventTypes, includeClientContact: args.includeClientContact, allowPrivate: false });
// Salon closed Sun/Mon: one 10:00 visit per open day, so no two bookings ever compete for a slot.
const OPEN_DAYS = ['10', '11', '12', '13', '16', '17', '18', '19', '20', '23', '24', '25', '26', '27'];
let nth = 0;
const book = () =>
  bookAppointment(prisma, {
    businessId: a.businessId,
    providerId: dana,
    serviceIds: [cut],
    clientId: maria,
    startAt: toDate(instantFromIso(`2026-06-${OPEN_DAYS[nth++]}T15:00:00Z`)),
    now: T0,
    actor: staffActor(a.ownerId),
    audience: 'staff',
  });
const deliveries = () => prisma.webhookDelivery.findMany({ orderBy: { seq: 'asc' } });

describe('fan-out and the happy path', () => {
  it('a desk booking reaches the endpoint once, signed, with every §8 header', async () => {
    const ep = await endpoint();
    const appt = await book();
    const r = await sweepWebhooks(deps());
    expect(r).toMatchObject({ queued: 1, succeeded: 1 });
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]!.body);
    expect(body).toMatchObject({ type: 'appointment.booked', apiVersion: 'v1', replayed: false, data: { appointment: { id: appt.id, status: 'booked' } } });
    expect(sent[0]!.headers).toMatchObject({ 'Bookable-Event-Id': body.id, 'Bookable-Event-Type': 'appointment.booked', 'Bookable-Attempt': '1' });
    expect(sent[0]!.headers['Bookable-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(await deliveries()).toEqual([expect.objectContaining({ endpointId: ep.id, status: 'succeeded', attempts: 1, lastResponseStatus: 200 })]);
    // A second sweep finds nothing new and sends nothing.
    expect(await sweepWebhooks(deps())).toEqual({ queued: 0, succeeded: 0, failed: 0, dead: 0 });
    expect(sent).toHaveLength(1);
  });

  it('a new endpoint starts at the current seq: it is not sent the salon\'s history', async () => {
    await book();
    await endpoint();
    await sweepWebhooks(deps());
    expect(sent).toHaveLength(0);
    await book();
    await sweepWebhooks(deps());
    expect(sent).toHaveLength(1);
  });

  it('COVERAGE BY DERIVATION (§9.13): an event written by no known writer is delivered with no pipeline change', async () => {
    await endpoint();
    const appt = await book();
    await sweepWebhooks(deps());
    // A "new writer": raw SQL, no hook, no emit — only a log row.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AppointmentEvent" (id, "businessId", "appointmentId", type, actor, payload) VALUES ('ev-new-writer', $1, $2, 'status_changed', 'system', '{"from":"booked","to":"cancelled"}')`,
      a.businessId,
      appt.id,
    );
    await sweepWebhooks(deps());
    expect(sent.map((s) => JSON.parse(s.body).type)).toEqual(['appointment.booked', 'appointment.cancelled']);
    expect(JSON.parse(sent[1]!.body).id).toBe('ev-new-writer');
  });

  it('honours eventTypes, and never sends an unpublished type', async () => {
    await endpoint({ eventTypes: ['appointment.cancelled'] });
    const appt = await book();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AppointmentEvent" (id, "businessId", "appointmentId", type, actor) VALUES ('ev-x', $1, $2, 'conflict_acknowledged', 'staff')`,
      a.businessId,
      appt.id,
    );
    await sweepWebhooks(deps());
    expect(sent).toHaveLength(0);
    await expect(endpoint({ eventTypes: ['appointment.nope'] })).rejects.toBeInstanceOf(WebhookEndpointRejected);
  });

  it('fan-out run twice inserts one row per (endpoint, event)', async () => {
    await endpoint();
    await book();
    await Promise.all([fanOut(deps()), fanOut(deps())]);
    await fanOut(deps());
    expect(await prisma.webhookDelivery.count()).toBe(1);
  });

  it('TENANCY: business B\'s endpoint never receives an A event', async () => {
    await endpoint({ businessId: b.businessId, url: 'https://203.0.113.20/b' });
    await book();
    await sweepWebhooks(deps());
    expect(sent).toHaveLength(0);
  });
});

describe('retries, dead-letter, pause, disable (§9.8)', () => {
  it('500, 500, 200: one delivery, succeeded on attempt 3, each retry "not before" its backoff', async () => {
    await endpoint();
    await book();
    answers = [500, 500, 200];
    await sweepWebhooks(deps());
    let [d] = await deliveries();
    expect(d).toMatchObject({ status: 'failed', attempts: 1, lastResponseStatus: 500, nextAttemptAt: toDate(instant(fromDate(T0) + BACKOFF_MS[0])) });
    advance(BACKOFF_MS[0] - 1);
    await sweepWebhooks(deps());
    expect(sent).toHaveLength(1); // not before
    advance(1);
    await sweepWebhooks(deps());
    [d] = await deliveries();
    expect(d).toMatchObject({ status: 'failed', attempts: 2, nextAttemptAt: toDate(instant(fromDate(clock) + BACKOFF_MS[1])) });
    advance(BACKOFF_MS[1]);
    await sweepWebhooks(deps());
    [d] = await deliveries();
    expect(d).toMatchObject({ status: 'succeeded', attempts: 3, firstAttemptAt: T0, succeededAt: clock });
    expect(sent.map((s) => s.headers['Bookable-Attempt'])).toEqual(['1', '2', '3']);
    expect(new Set(sent.map((s) => s.headers['Bookable-Event-Id'])).size).toBe(1);
    expect((await prisma.webhookEndpoint.findFirstOrThrow()).consecutiveFailures).toBe(0);
  });

  it(`a receiver that always fails: dead after ${MAX_ATTEMPTS} attempts, endpoint paused at ${PAUSE_AFTER} consecutive`, async () => {
    await endpoint();
    await book();
    answers = Array(50).fill(503);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await sweepWebhooks(deps());
      advance(24 * 3_600_000);
    }
    const [d] = await deliveries();
    expect(d).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS, nextAttemptAt: null });
    expect(sent).toHaveLength(MAX_ATTEMPTS);
    let ep = await prisma.webhookEndpoint.findFirstOrThrow();
    expect(ep).toMatchObject({ status: 'active', consecutiveFailures: MAX_ATTEMPTS });
    // More events, more failures: the 10th consecutive pauses the endpoint, with a reason.
    for (let i = MAX_ATTEMPTS; i < PAUSE_AFTER; i++) {
      await book();
      await sweepWebhooks(deps());
      advance(24 * 3_600_000);
    }
    ep = await prisma.webhookEndpoint.findFirstOrThrow();
    expect(ep).toMatchObject({ status: 'paused', consecutiveFailures: PAUSE_AFTER });
    expect(ep.disabledReason).toMatch(/10 deliveries in a row failed; last: HTTP 503/);
    const before = sent.length;
    await book();
    await sweepWebhooks(deps());
    expect(sent).toHaveLength(before); // a paused endpoint is sent nothing
  });

  it('a 410 disables the endpoint at once', async () => {
    await endpoint();
    await book();
    await book();
    answers = [410];
    const r = await sweepWebhooks(deps());
    expect(r).toMatchObject({ failed: 1 });
    expect(sent).toHaveLength(1);
    expect(await prisma.webhookEndpoint.findFirstOrThrow()).toMatchObject({ status: 'disabled', disabledReason: 'The receiver answered 410 Gone.' });
    advance(24 * 3_600_000);
    await sweepWebhooks(deps());
    expect(sent).toHaveLength(1);
  });

  it('one failing endpoint does not hold up another', async () => {
    await endpoint({ url: 'https://203.0.113.10/down' });
    await endpoint({ url: 'https://203.0.113.11/up' });
    await book();
    await book();
    const fetchByUrl = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: String(init!.body) });
      return new Response('', { status: String(url).endsWith('/down') ? 500 : 200 });
    }) as typeof fetch;
    const r = await sweepWebhooks({ ...deps(), fetch: fetchByUrl });
    expect(r).toMatchObject({ succeeded: 2, failed: 1 });
    // The down endpoint was tried once this sweep, not once per queued row.
    expect(sent.filter((s) => s.url.endsWith('/down'))).toHaveLength(1);
  });
});

describe('the claim (§9.8)', () => {
  it('a row another sweep holds is skipped, and once it is `sending` nobody else takes it', async () => {
    await endpoint();
    await book();
    await fanOut(deps());
    const [d] = await deliveries();
    const holder = new PgClient({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      // The other sweep, mid-claim: it holds the row and has marked it sending.
      await holder.query('BEGIN');
      await holder.query(`UPDATE "WebhookDelivery" SET status = 'sending', attempts = 1, "updatedAt" = $2 WHERE id = $1`, [d!.id, T0]);
      expect(await claimDelivery(deps())).toBeNull(); // SKIP LOCKED: never waits, never double-claims
      await holder.query('COMMIT');
    } finally {
      await holder.end();
    }
    expect(await claimDelivery(deps())).toBeNull(); // committed `sending`, not stale
  });

  it('THE DOUBLE-SEND DOOR: a `sending` row older than the stale window is reclaimed and sent again', async () => {
    await endpoint();
    await book();
    await fanOut(deps());
    const first = (await claimDelivery(deps()))!;
    expect(first.attempts).toBe(1);
    // The process that claimed it died mid-send. Fifteen minutes later:
    advance(STALE_SENDING_MS - 1);
    expect(await claimDelivery(deps())).toBeNull();
    advance(2);
    const again = (await claimDelivery(deps()))!;
    expect(again).toMatchObject({ id: first.id, attempts: 2 });
    await deliver(deps(), again);
    // The receiver may already have it from the dead process: same event id, attempt 2 — it dedupes on the id.
    expect(sent[0]!.headers).toMatchObject({ 'Bookable-Attempt': '2' });
  });
});

describe('PII (§9.10) and where a webhook may go', () => {
  it('no body carries a phone or email unless the endpoint asked for contacts', async () => {
    await endpoint({ url: 'https://203.0.113.10/plain' });
    await endpoint({ url: 'https://203.0.113.11/contacts', includeClientContact: true });
    await book();
    await sweepWebhooks(deps());
    const plain = sent.find((s) => s.url.endsWith('/plain'))!.body;
    const withContacts = sent.find((s) => s.url.endsWith('/contacts'))!.body;
    expect(plain).not.toContain('5550142');
    expect(plain).not.toContain('maria@example.test');
    expect(JSON.parse(withContacts).data.appointment.client).toEqual({ id: maria, name: 'Maria Gomez', phone: '+13125550142', email: 'maria@example.test' });
  });

  it('refuses http, credentials and private addresses at registration', async () => {
    for (const url of ['http://203.0.113.10/x', 'https://user:pw@203.0.113.10/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://[::1]/x', 'not a url']) {
      await expect(endpoint({ url }), url).rejects.toBeInstanceOf(WebhookEndpointRejected);
    }
  });

  it('re-checks at send: an endpoint now pointing somewhere private is a failed attempt, not a request', async () => {
    await endpoint();
    await prisma.webhookEndpoint.updateMany({ data: { url: 'https://192.168.1.1/x' } });
    await book();
    await sweepWebhooks(deps());
    expect(sent).toHaveLength(0);
    expect((await deliveries())[0]).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/private/) });
  });

  it('classifies addresses', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['203.0.113.10', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});
