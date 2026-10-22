/**
 * W-007 — reschedule (with the reassign routing and If-Match), cancel, status,
 * waitlist; and PARITY (API PRD §9.5): a booking and a cancellation made
 * through the API and the same ones made at the desk produce IDENTICAL rows
 * and events except `channel` / `actorRef` — the M-013 parity test, extended.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { transitionAppointment } from '@bookable/db/appointments';
import { bookAppointment } from '@bookable/db/booking';
import { resetDatabase } from '@bookable/db/testing';
import { getAppointment } from './appointments';
import { postCancel, postReschedule, postStatus, postWaitlist } from './moves';
import { type Caller, keyFor, seedTwoSalons, type Salon } from './testing';
import { postAppointment } from './writes';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const deps = { prisma, now: () => NOW };
const WRITE = { scope: 'write' } as const;
const READ = { scope: 'read' } as const;

let a: Salon;
let b: Salon;
let key: Caller;
let byName: Record<string, string>;
let cut: string;
let maria: string;
let n = 0;

beforeAll(async () => prisma.$connect());
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a, b } = await seedTwoSalons(prisma));
  key = await keyFor(prisma, a, ['read', 'write'], deps, 'HubSpot sync');
  byName = Object.fromEntries((await prisma.provider.findMany({ where: { businessId: a.businessId } })).map((p) => [p.displayName, p.id]));
  cut = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Cut' } })).id;
  maria = (await prisma.client.create({ data: { businessId: a.businessId, name: 'Maria Gomez', phone: '+13125550142' }, select: { id: true } })).id;
});

const call = (handler: ReturnType<typeof postStatus>, id: string, body: unknown, headers: Record<string, string> = {}, k = key) =>
  k.call(WRITE, handler, { method: 'POST', path: `/api/v1/appointments/${id}/x`, params: { id }, body, headers: { 'Idempotency-Key': `k-${++n}`, ...headers } });
const deskBook = (iso: string, clientId = maria, provider = 'Dana') =>
  bookAppointment(prisma, { businessId: a.businessId, providerId: byName[provider]!, serviceIds: [cut], clientId, startAt: toDate(instantFromIso(iso)), now: NOW, actor: staffActor(a.ownerId), audience: 'staff' });
const read = async (id: string) => (await key.call(READ, getAppointment, { path: '/', params: { id } })).body;

describe('POST /v1/appointments/{id}/reschedule', () => {
  it('moves the time (a same-row UPDATE, D-6) with the API on the event', async () => {
    const appt = await deskBook('2026-06-10T15:00:00Z');
    const r = await call(postReschedule(), appt.id, { start: '2026-06-10 11:00' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: appt.id, startAt: '2026-06-10T11:00:00-05:00', providerId: byName['Dana'] });
    expect(await prisma.appointment.count({ where: { businessId: a.businessId } })).toBe(2); // the seed's + this one, never a second row
    const ev = await prisma.appointmentEvent.findFirstOrThrow({ where: { appointmentId: appt.id, type: 'rescheduled' } });
    expect(ev).toMatchObject({ channel: 'api', actorRef: key.keyId });
  });

  it('same instant + a new provider is the desk REASSIGN (M-D16), not a refused reschedule', async () => {
    const appt = await deskBook('2026-06-10T15:00:00Z');
    const r = await call(postReschedule(), appt.id, { start: '2026-06-10T10:00:00-05:00', providerId: byName['Priya'] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ startAt: '2026-06-10T10:00:00-05:00', providerId: byName['Priya'] });
    expect(await prisma.appointmentEvent.findFirst({ where: { appointmentId: appt.id, type: 'provider_changed' } })).toMatchObject({ channel: 'api' });
  });

  it('If-Match: the current version moves it; a stale one is 412 and NOTHING is written', async () => {
    const appt = await deskBook('2026-06-10T15:00:00Z');
    const v1 = (await read(appt.id)).version as string;
    await transitionAppointment(prisma, { businessId: a.businessId, appointmentId: appt.id, to: 'confirmed', actor: staffActor(a.ownerId), now: NOW });
    const stale = await call(postReschedule(), appt.id, { start: '2026-06-10 11:00' }, { 'If-Match': v1 });
    expect(stale.status).toBe(412);
    expect(stale.body).toMatchObject({ code: 'PRECONDITION_FAILED', next: { endpoint: `GET /v1/appointments/${appt.id}` } });
    expect((await read(appt.id)).startAt).toBe('2026-06-10T10:00:00-05:00');
    const fresh = await call(postReschedule(), appt.id, { start: '2026-06-10 11:00' }, { 'If-Match': (await read(appt.id)).version as string });
    expect(fresh.status).toBe(200);
  });

  it('SLOT_TAKEN onto a busy time, OUTSIDE_HOURS onto a Sunday, NOT_QUALIFIED to Tess for a colour', async () => {
    const appt = await deskBook('2026-06-10T15:00:00Z');
    await deskBook('2026-06-10T16:00:00Z', (await prisma.client.create({ data: { businessId: a.businessId, name: 'Ben' } })).id);
    expect((await call(postReschedule(), appt.id, { start: '2026-06-10 11:00' })).body.code).toBe('SLOT_TAKEN');
    expect((await call(postReschedule(), appt.id, { start: '2026-06-14 11:00' })).body.code).toBe('OUTSIDE_HOURS');
    const colour = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Colour' } })).id;
    const c = await bookAppointment(prisma, { businessId: a.businessId, providerId: byName['Marcus']!, serviceIds: [colour], clientId: maria, startAt: toDate(instantFromIso('2026-06-12T19:00:00Z')), now: NOW, actor: staffActor(a.ownerId), audience: 'staff' }); // Fri 14:00
    expect((await call(postReschedule(), c.id, { start: '2026-06-12T14:00:00-05:00', providerId: byName['Tess'] })).body.code).toBe('NOT_QUALIFIED');
  });
});

describe('POST /v1/appointments/{id}/cancel', () => {
  it('the machine decides cancelled vs cancelled_late (A-060); tellClient defaults to true (D-32); a reason is required', async () => {
    const appt = await deskBook('2026-06-10T15:00:00Z');
    expect((await call(postCancel(), appt.id, {})).body).toMatchObject({ code: 'VALIDATION', errors: [{ field: 'reason' }] });
    const before = await prisma.notificationOutbox.count({ where: { appointmentId: appt.id } });
    const r = await call(postCancel(), appt.id, { reason: 'client called' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('cancelled');
    expect(await prisma.notificationOutbox.count({ where: { appointmentId: appt.id } })).toBe(before + 1);
    // Within the cutoff: late, decided by the domain, not the caller.
    const soon = await deskBook('2026-06-09T16:00:00Z');
    expect((await call(postCancel(), soon.id, { reason: 'r', tellClient: false })).body.status).toBe('cancelled_late');
  });

  it('cancelling twice is INVALID_TRANSITION; a replay of the first cancel is the first answer', async () => {
    const appt = await deskBook('2026-06-10T15:00:00Z');
    const first = await call(postCancel(), appt.id, { reason: 'r' }, { 'Idempotency-Key': 'cancel-once' });
    const replay = await call(postCancel(), appt.id, { reason: 'r' }, { 'Idempotency-Key': 'cancel-once' });
    expect(replay.text).toBe(first.text);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect((await call(postCancel(), appt.id, { reason: 'r' })).body).toMatchObject({ code: 'INVALID_TRANSITION', status: 409 });
  });
});

describe('POST /v1/appointments/{id}/status', () => {
  it('walks booked → checked_in → in_progress → completed, each on the transition table, each channel api', async () => {
    const appt = await deskBook('2026-06-09T14:00:00Z');
    const later = { prisma, now: () => toDate(instantFromIso('2026-06-09T15:00:00Z')) };
    const k = await keyFor(prisma, a, ['read', 'write'], later, 'later');
    for (const to of ['checked_in', 'in_progress', 'completed']) {
      const r = await call(postStatus(), appt.id, { to }, {}, k);
      expect(r.status, to).toBe(200);
      expect(r.body.status).toBe(to);
    }
    const evs = await prisma.appointmentEvent.findMany({ where: { appointmentId: appt.id, type: 'status_changed' } });
    expect(evs.map((e) => e.channel)).toEqual(['api', 'api', 'api']);
  });

  it('no_show before the start is INVALID_TRANSITION; a value outside the four is VALIDATION; B’s appointment is NOT_FOUND', async () => {
    const appt = await deskBook('2026-06-10T15:00:00Z');
    expect((await call(postStatus(), appt.id, { to: 'no_show' })).body.code).toBe('INVALID_TRANSITION');
    expect((await call(postStatus(), appt.id, { to: 'cancelled' })).body.code).toBe('VALIDATION');
    expect((await call(postStatus(), b.appointmentId, { to: 'checked_in' })).body.code).toBe('NOT_FOUND');
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: b.appointmentId } })).status).toBe('booked');
  });
});

describe('POST /v1/waitlist', () => {
  it('adds an entry through createWaitlistEntry; foreign ids are NOT_FOUND; a backwards range is VALIDATION', async () => {
    const add = (body: unknown) => key.call(WRITE, postWaitlist(), { method: 'POST', path: '/api/v1/waitlist', body, headers: { 'Idempotency-Key': `w-${++n}` } });
    const r = await add({ clientId: maria, serviceIds: [cut], dayRange: { from: '2026-06-16', to: '2026-06-20' }, providerId: byName['Dana'], dayParts: ['saturday', 'morning'] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ client: { id: maria }, fromDay: '2026-06-16', toDay: '2026-06-20', providerIds: [byName['Dana']], dayParts: ['saturday', 'morning'] });
    expect((await add({ clientId: b.clientId, serviceIds: [cut], dayRange: { from: '2026-06-16', to: '2026-06-20' } })).body.code).toBe('NOT_FOUND');
    expect((await add({ clientId: maria, serviceIds: [cut], dayRange: { from: '2026-06-20', to: '2026-06-16' } })).body.code).toBe('VALIDATION');
  });
});

/** Columns that legitimately differ between any two bookings, or carry the API's bookkeeping. */
const APPOINTMENT_VARIES = new Set(['id', 'createdAt', 'updatedAt', 'idempotencyKey', 'clientId', 'cancelledAt']);
const EVENT_VARIES = new Set(['id', 'appointmentId', 'createdAt', 'channel', 'actorRef', 'seq']); // seq: the per-business commit order (W-008), different by design
const strip = (row: Record<string, unknown>, skip: Set<string>) => Object.fromEntries(Object.entries(row).filter(([k]) => !skip.has(k)));

describe('PARITY (§9.5) — the API and the desk write the same rows', () => {
  it('a booking then a cancellation via the API and via the desk: identical except channel / actorRef', async () => {
    const nadia = (await prisma.client.create({ data: { businessId: a.businessId, name: 'Nadia Khan', phone: '+13125550177' }, select: { id: true } })).id;
    const TEN = '2026-06-10T15:00:00Z';
    // API: Maria.
    const booked = await key.call(WRITE, postAppointment(), { method: 'POST', path: '/api/v1/appointments', body: { clientId: maria, serviceIds: [cut], providerId: byName['Dana'], start: '2026-06-10T10:00:00-05:00' }, headers: { 'Idempotency-Key': 'parity-book' } });
    expect(booked.status).toBe(201);
    const apiId = booked.body.id as string;
    expect((await call(postCancel(), apiId, { reason: 'parity' })).status).toBe(200);
    // Desk: Nadia, the same provider, the same (freed) slot, the owner acting.
    const desk = await deskBook(TEN, nadia);
    await transitionAppointment(prisma, { businessId: a.businessId, appointmentId: desk.id, to: 'cancelled', cancellation: 'derive', actor: staffActor(a.ownerId), now: NOW, reason: 'parity', notify: true, expectedFrom: 'booked' });

    const [apiRow, deskRow] = await Promise.all([prisma.appointment.findUniqueOrThrow({ where: { id: apiId } }), prisma.appointment.findUniqueOrThrow({ where: { id: desk.id } })]);
    expect(strip(apiRow, APPOINTMENT_VARIES)).toEqual(strip(deskRow, APPOINTMENT_VARIES));
    expect(apiRow.idempotencyKey).toMatch(/^api:/);

    const [apiEvents, deskEvents] = await Promise.all([
      prisma.appointmentEvent.findMany({ where: { appointmentId: apiId }, orderBy: { createdAt: 'asc' } }),
      prisma.appointmentEvent.findMany({ where: { appointmentId: desk.id }, orderBy: { createdAt: 'asc' } }),
    ]);
    expect(apiEvents.length).toBeGreaterThanOrEqual(2);
    expect(apiEvents.map((e) => strip(e, EVENT_VARIES))).toEqual(deskEvents.map((e) => strip(e, EVENT_VARIES)));
    expect(apiEvents.map((e) => [e.channel, e.actorRef])).toEqual(apiEvents.map(() => ['api', key.keyId]));
    expect(deskEvents.map((e) => [e.channel, e.actorRef])).toEqual(deskEvents.map(() => ['desk', a.ownerId]));

    // And the outbox: the same messages queued, to the same templates.
    const outbox = async (id: string) => (await prisma.notificationOutbox.findMany({ where: { appointmentId: id }, orderBy: { createdAt: 'asc' } })).map((o) => o.template);
    expect(await outbox(apiId)).toEqual(await outbox(desk.id));
  });
});
