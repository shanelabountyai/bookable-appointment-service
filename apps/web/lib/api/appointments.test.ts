/**
 * W-004 — days, the appointment list, one appointment (API PRD §7, §6.4, §9.1).
 *
 * The list's predicate is the INSTANT overlap on the blocked range, never
 * `date(startAt)`: a fixture runs a visit across midnight and asserts it on
 * BOTH days (CLAUDE.md's 23:30 rule). Pagination is asserted to visit every
 * row exactly once across pages, with a row INSERTED between pages — the case
 * an offset pager gets wrong.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { transitionAppointment } from '@bookable/db/appointments';
import { bookAppointment } from '@bookable/db/booking';
import { resetDatabase } from '@bookable/db/testing';
import { getAppointment, getDay, listAppointments } from './appointments';
import { type Caller, keyFor, seedTwoSalons, type Salon } from './testing';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const deps = { prisma, now: () => NOW };
const READ = { scope: 'read' } as const;

let a: Salon;
let b: Salon;
let key: Caller;
let dana: string;
let cut: string;

beforeAll(async () => prisma.$connect());
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a, b } = await seedTwoSalons(prisma));
  key = await keyFor(prisma, a, ['read'], deps);
  dana = (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Dana' } })).id;
  cut = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Cut' } })).id;
});

const book = (iso: string, extra: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
  bookAppointment(prisma, { businessId: a.businessId, providerId: dana, serviceIds: [cut], startAt: toDate(instantFromIso(iso)), now: NOW, actor: staffActor(a.ownerId), audience: 'staff', ...extra });

describe('GET /v1/appointments/{id}', () => {
  it('detail with both time forms, allowedActions from the transition table, and an opaque version as ETag', async () => {
    const appt = await book('2026-06-10T15:00:00Z', { notes: 'bring the photo' });
    const r = await key.call(READ, getAppointment, { path: `/api/v1/appointments/${appt.id}`, params: { id: appt.id } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: appt.id,
      status: 'booked',
      startAt: '2026-06-10T10:00:00-05:00',
      startLocal: { date: '2026-06-10', time: '10:00', zone: 'America/Chicago' },
      providerName: 'Dana',
      note: 'bring the photo',
      isOverride: false,
    });
    const actions = (r.body.allowedActions as { action: string; to?: string }[]).map((x) => `${x.action}:${x.to ?? ''}`);
    // Booked, tomorrow: cancel (on time) and reschedule and check-in; never complete before it starts.
    expect(actions).toContain('cancel:cancelled');
    expect(actions).toContain('reschedule:');
    expect(actions).toContain('status:checked_in');
    expect(actions).not.toContain('status:completed');
    expect(r.headers.get('etag')).toBe(r.body.version);
    expect(JSON.stringify(r.body)).not.toMatch(/phone|email|\+1312/);
  });

  it('allowedActions follow the status: a completed visit offers only the APPT-06 correction to no_show', async () => {
    // Tue 2026-06-09 09:00 CDT, finished by 11:00 (the salon is closed Mondays).
    const appt = await book('2026-06-09T14:00:00Z');
    const later = toDate(instantFromIso('2026-06-09T16:00:00Z'));
    for (const to of ['checked_in', 'in_progress', 'completed'] as const) await transitionAppointment(prisma, { businessId: a.businessId, appointmentId: appt.id, to, actor: staffActor(a.ownerId), now: later });
    const r = await key.call(READ, getAppointment, { path: '/', params: { id: appt.id } });
    expect(r.body.status).toBe('completed');
    expect(r.body.allowedActions).toEqual([{ action: 'status', endpoint: `POST /v1/appointments/${appt.id}/status`, to: 'no_show' }]);
  });

  it('the version changes when the row does', async () => {
    const appt = await book('2026-06-10T15:00:00Z');
    const v1 = (await key.call(READ, getAppointment, { path: '/', params: { id: appt.id } })).body.version;
    await transitionAppointment(prisma, { businessId: a.businessId, appointmentId: appt.id, to: 'confirmed', actor: staffActor(a.ownerId), now: NOW });
    const v2 = (await key.call(READ, getAppointment, { path: '/', params: { id: appt.id } })).body.version;
    expect(v2).not.toBe(v1);
  });

  it("another business's appointment is NOT_FOUND, indistinguishable from a made-up id", async () => {
    const theirs = await key.call(READ, getAppointment, { path: '/', params: { id: b.appointmentId } });
    const madeUp = await key.call(READ, getAppointment, { path: '/', params: { id: 'nope' } });
    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual(madeUp.body);
  });
});

describe('GET /v1/days/{day}', () => {
  it("a visit that runs past midnight is on BOTH days (instant overlap, never date(startAt)); B's never appear", async () => {
    // Open late on Wednesday so a 23:30 booking is legal for the desk: an override is the simplest honest way.
    const late = await book('2026-06-11T04:30:00Z', { isOverride: true, overrideReason: 'late client' }); // Wed 23:30 CDT
    const wed = await key.call(READ, getDay, { path: '/api/v1/days/2026-06-10', params: { day: '2026-06-10' } });
    const thu = await key.call(READ, getDay, { path: '/api/v1/days/2026-06-11', params: { day: '2026-06-11' } });
    const ids = (r: typeof wed) => (r.body.data as { id: string }[]).map((x) => x.id);
    expect(wed.body).toMatchObject({ date: '2026-06-10', zone: 'America/Chicago' });
    expect(ids(wed)).toContain(late.id);
    expect(ids(thu)).toContain(late.id);
    // The seed's Thursday 09:00 belongs to Thursday only.
    expect(ids(thu)).toContain(a.appointmentId);
    expect(ids(wed)).not.toContain(a.appointmentId);
    expect(ids(thu)).not.toContain(b.appointmentId);
  });

  it('refuses a malformed day and a foreign provider', async () => {
    expect((await key.call(READ, getDay, { path: '/', params: { day: '06/10' } })).body.code).toBe('VALIDATION');
    expect((await key.call(READ, getDay, { path: `/?providerId=${b.providerIds[0]}`, params: { day: '2026-06-10' } })).body.code).toBe('NOT_FOUND');
  });
});

describe('GET /v1/appointments', () => {
  it('cursor pages visit every row exactly once — even with a row inserted between pages — and never an offset', async () => {
    // 09:00..16:00 CDT on the hour, skipping the 12:00 lunch.
    const starts = ['14:00', '15:00', '16:00', '18:00', '19:00', '20:00', '21:00'].map((t) => `2026-06-10T${t}:00Z`);
    for (const s of starts) await book(s);
    const path = (cursor?: string) => `/api/v1/appointments?from=2026-06-10 00:00&to=2026-06-11 00:00&limit=3${cursor ? `&cursor=${cursor}` : ''}`;
    const seen: string[] = [];
    let r = await key.call(READ, listAppointments, { path: path() });
    seen.push(...(r.body.data as { id: string }[]).map((x) => x.id));
    // A booking lands EARLIER than the cursor between pages: a keyset pager neither repeats nor skips because of it.
    // (08:00 is before opening, so the desk does it as an override — which a list must still see: next test.)
    await book('2026-06-10T13:00:00Z', { isOverride: true, overrideReason: 'early client' });
    while (r.body.nextCursor) {
      r = await key.call(READ, listAppointments, { path: path(r.body.nextCursor as string) });
      seen.push(...(r.body.data as { id: string }[]).map((x) => x.id));
    }
    expect(seen).toHaveLength(starts.length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('filters by status; the window is instant-overlap; >62 days, to<=from, a junk cursor and limit>100 are VALIDATION', async () => {
    const x = await book('2026-06-10T15:00:00Z');
    await book('2026-06-10T19:00:00Z');
    await transitionAppointment(prisma, { businessId: a.businessId, appointmentId: x.id, to: 'cancelled', actor: staffActor(a.ownerId), now: NOW, reason: 'r' });
    const cancelled = await key.call(READ, listAppointments, { path: '/api/v1/appointments?from=2026-06-10T00:00:00-05:00&to=2026-06-11T00:00:00-05:00&status=cancelled' });
    expect((cancelled.body.data as { id: string }[]).map((d) => d.id)).toEqual([x.id]);
    // A window that only touches the visit's BUFFER still finds it.
    const cutSvc = await prisma.service.findUniqueOrThrow({ where: { id: cut } });
    expect(cutSvc.bufferAfterMinutes).toBeGreaterThan(0);
    // x is 10:00–10:45 + buffer; a window over 10:45–10:50 touches only its buffer.
    const bufferOnly = await key.call(READ, listAppointments, { path: `/api/v1/appointments?from=2026-06-10T10:45:00-05:00&to=2026-06-10T10:50:00-05:00` });
    expect((bufferOnly.body.data as unknown[]).length).toBe(1);
    for (const q of ['from=2026-06-10 00:00&to=2026-09-10 00:00', 'from=2026-06-10 00:00&to=2026-06-10 00:00', 'from=2026-06-10 00:00&to=2026-06-11 00:00&cursor=garbage', 'from=2026-06-10 00:00&to=2026-06-11 00:00&limit=101']) {
      expect((await key.call(READ, listAppointments, { path: `/api/v1/appointments?${q}` })).body.code, q).toBe('VALIDATION');
    }
  });

  it('an OVERRIDE is listed by the time it really occupies, though its blocked range is zero-width (D-8)', async () => {
    const o = await book('2026-06-10T13:00:00Z', { isOverride: true, overrideReason: 'early client' });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: o.id } });
    expect(row.blockedEnd.getTime(), 'the premise: an override holds no blocked range').toBe(row.blockedStart.getTime());
    const r = await key.call(READ, listAppointments, { path: '/api/v1/appointments?from=2026-06-10T08:10:00-05:00&to=2026-06-10T08:20:00-05:00' });
    expect((r.body.data as { id: string; isOverride: boolean }[]).map((d) => [d.id, d.isOverride])).toEqual([[o.id, true]]);
  });

  it("a business-B key lists B's book only", async () => {
    const kb = await keyFor(prisma, b, ['read'], deps, 'b');
    const r = await kb.call(READ, listAppointments, { path: '/api/v1/appointments?from=2026-06-11 00:00&to=2026-06-12 00:00' });
    expect((r.body.data as { id: string }[]).map((d) => d.id)).toEqual([b.appointmentId]);
  });
});
