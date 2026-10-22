/**
 * W-011 — what the owner's page does to endpoints and deliveries: replay
 * (one row, and from a seq), resume/disable, edit, the log's filters — and
 * SNAPSHOT HONESTY (API PRD §9.11): a replayed `booked` delivery sends the
 * booked time with `replayed: true`, not the appointment as it is now.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { fromDate, instant, instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { rescheduleAppointment } from '@bookable/db/appointments';
import { bookAppointment } from '@bookable/db/booking';
import { resetDatabase } from '@bookable/db/testing';
import { seedTwoSalons, type Salon } from './testing';
import {
  WebhookEndpointRejected,
  createWebhookEndpoint,
  listWebhookDeliveries,
  replayDelivery,
  replayFromSeq,
  setWebhookEndpointStatus,
  updateWebhookEndpoint,
} from './webhook-endpoints';
import { MAX_ATTEMPTS, sweepWebhooks } from './webhooks';

const prisma = new PrismaClient();
const T0 = toDate(instantFromIso('2026-06-09T14:00:00Z'));
let clock = T0;
const advance = (ms: number) => (clock = toDate(instant(fromDate(clock) + ms)));

let sent: { url: string; body: Record<string, unknown>; attempt: string }[];
let answers: number[];
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const h = init!.headers as Record<string, string>;
  sent.push({ url: String(url), body: JSON.parse(String(init!.body)), attempt: h['Bookable-Attempt']! });
  return new Response('', { status: answers.shift() ?? 200 });
}) as typeof fetch;
const sweep = () => sweepWebhooks({ prisma, now: () => clock, fetch: fakeFetch, allowPrivate: false });

let a: Salon;
let b: Salon;
let dana: string;
let cut: string;
const OPEN_DAYS = ['10', '11', '12', '13', '16', '17'];
let nth = 0;

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
});

const endpoint = (url = 'https://203.0.113.10/hook', businessId = a.businessId) => createWebhookEndpoint(prisma, { businessId, url, allowPrivate: false });
const book = () =>
  bookAppointment(prisma, {
    businessId: a.businessId,
    providerId: dana,
    serviceIds: [cut],
    clientId: null,
    startAt: toDate(instantFromIso(`2026-06-${OPEN_DAYS[nth++]}T15:00:00Z`)),
    now: T0,
    actor: staffActor(a.ownerId),
    audience: 'staff',
  });

describe('replay', () => {
  it('SNAPSHOT HONESTY (§9.11): replaying `booked` after a reschedule sends the BOOKED time, replayed: true, attempt 1 again', async () => {
    await endpoint();
    const appt = await book();
    await sweep();
    expect(sent[0]!.body).toMatchObject({ type: 'appointment.booked', replayed: false, data: { appointment: { startAt: '2026-06-10T10:00:00-05:00' } } });
    await rescheduleAppointment(prisma, {
      businessId: a.businessId,
      appointmentId: appt.id,
      startAt: toDate(instantFromIso('2026-06-10T18:00:00Z')),
      now: T0,
      actor: staffActor(a.ownerId),
      audience: 'staff',
    });
    await sweep(); // delivers `rescheduled`
    const booked = (await prisma.webhookDelivery.findMany({ include: { event: true } })).find((d) => d.event.type === 'booked')!;
    expect(await replayDelivery(prisma, { businessId: a.businessId, deliveryId: booked.id })).toBe(true);
    await sweep();
    const replay = sent[sent.length - 1]!;
    expect(replay.body).toMatchObject({ id: booked.eventId, type: 'appointment.booked', replayed: true, data: { appointment: { startAt: '2026-06-10T10:00:00-05:00' } } });
    expect(replay.attempt).toBe('1');
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: booked.id } })).toMatchObject({ status: 'succeeded', attempts: 1, replayed: true });
  });

  it('revives a dead delivery with six fresh attempts; another business cannot replay it', async () => {
    await endpoint();
    await book();
    answers = Array(MAX_ATTEMPTS).fill(500);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await sweep();
      advance(24 * 3_600_000);
    }
    const [dead] = await prisma.webhookDelivery.findMany();
    expect(dead).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS });
    expect(await replayDelivery(prisma, { businessId: b.businessId, deliveryId: dead!.id })).toBe(false);
    expect(await replayDelivery(prisma, { businessId: a.businessId, deliveryId: dead!.id })).toBe(true);
    await sweep();
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: dead!.id } })).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('replay from seq re-sends what it had AND fans out what it never had (events before it was registered)', async () => {
    await book(); // before the endpoint exists
    const before = (await prisma.appointmentEvent.findFirstOrThrow({ where: { businessId: a.businessId, type: 'booked' }, orderBy: { seq: 'desc' } })).seq!;
    const ep = await endpoint();
    await book();
    await sweep();
    expect(sent).toHaveLength(1);
    const requeued = await replayFromSeq(prisma, { businessId: a.businessId, endpointId: ep.id, fromSeq: before });
    expect(requeued).toBe(1);
    await sweep();
    expect(sent.slice(1).map((s) => [s.body.seq, s.body.replayed])).toEqual([
      [before, false], // never delivered before: a first delivery, fanned out by the wound-back cursor
      [sent[0]!.body.seq, true],
    ]);
    await expect(replayFromSeq(prisma, { businessId: b.businessId, endpointId: ep.id, fromSeq: 1 })).rejects.toBeInstanceOf(WebhookEndpointRejected);
  });
});

describe('endpoint status and edits', () => {
  it('disable stops sending; resume clears the count and delivers the backlog', async () => {
    const ep = await endpoint();
    await setWebhookEndpointStatus(prisma, { businessId: a.businessId, endpointId: ep.id, to: 'disabled', now: T0 });
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).toMatchObject({ status: 'disabled', disabledReason: 'Switched off by the owner.' });
    await book();
    await sweep();
    expect(sent).toHaveLength(0);
    await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { consecutiveFailures: 7 } });
    await setWebhookEndpointStatus(prisma, { businessId: a.businessId, endpointId: ep.id, to: 'active', now: T0 });
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).toMatchObject({ status: 'active', consecutiveFailures: 0, disabledReason: null, disabledAt: null });
    await sweep();
    expect(sent).toHaveLength(1);
  });

  it('edit validates like registration and keeps the secret; another business cannot edit', async () => {
    const ep = await endpoint();
    const secret = (await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).secret;
    await updateWebhookEndpoint(prisma, { businessId: a.businessId, endpointId: ep.id, url: 'https://203.0.113.99/new', eventTypes: ['appointment.cancelled'], includeClientContact: true, allowPrivate: false });
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).toMatchObject({ url: 'https://203.0.113.99/new', eventTypes: ['appointment.cancelled'], includeClientContact: true, secret });
    await expect(updateWebhookEndpoint(prisma, { businessId: a.businessId, endpointId: ep.id, url: 'https://10.0.0.1/', eventTypes: [], includeClientContact: false, allowPrivate: false })).rejects.toThrow(/private/);
    await expect(updateWebhookEndpoint(prisma, { businessId: b.businessId, endpointId: ep.id, url: 'https://203.0.113.1/', eventTypes: [], includeClientContact: false, allowPrivate: false })).rejects.toBeInstanceOf(WebhookEndpointRejected);
  });
});

describe('the delivery log', () => {
  it('newest first, filtered by endpoint, status and published type, and only this business', async () => {
    const one = await endpoint('https://203.0.113.10/one');
    await endpoint('https://203.0.113.11/two');
    await endpoint('https://203.0.113.12/b', b.businessId);
    const appt = await book();
    await book();
    answers = [500];
    await sweep();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AppointmentEvent" (id, "businessId", "appointmentId", type, actor, payload) VALUES ('ev-cancel', $1, $2, 'status_changed', 'staff', '{"from":"booked","to":"cancelled"}')`,
      a.businessId,
      appt.id,
    );
    await sweep();

    const all = await listWebhookDeliveries(prisma, a.businessId);
    expect(all).toHaveLength(6);
    expect(all.map((d) => d.seq)).toEqual([...all.map((d) => d.seq)].sort((x, y) => y - x));
    expect((await listWebhookDeliveries(prisma, a.businessId, { endpointId: one.id })).every((d) => d.endpointId === one.id)).toBe(true);
    expect(await listWebhookDeliveries(prisma, a.businessId, { status: 'failed' })).toHaveLength(1);
    expect((await listWebhookDeliveries(prisma, a.businessId, { eventType: 'appointment.cancelled' })).map((d) => d.eventId)).toEqual(['ev-cancel', 'ev-cancel']);
    expect(await listWebhookDeliveries(prisma, b.businessId)).toHaveLength(0);
  });
});
