/**
 * M-007/M-008 — find_client, get_client_history, list_waitlist (PII rules)
 * and the owner-only get_week_report.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { transitionAppointment } from '@bookable/db/appointments';
import { bookAppointment } from '@bookable/db/booking';
import { resetDatabase } from '@bookable/db/testing';
import { createWaitlistEntry } from '@bookable/db/waitlist';
import { connectAs, errorOf, type CallResult, type Connected } from '../testing/connect';
import { seedTwoSalons, type Salon } from '../testing/two-salons';
import { FIND_CLIENT_LIMIT } from './clients';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z')); // Tue 09:00 CDT
const deps = { prisma, now: () => NOW };
const PHONE = '+13125550142';
const NOTE = 'SECRET allergy note';
const EMAIL = 'maria@example.test';

interface Client {
  id: string;
  name: string | null;
  phone_last4: string | null;
  reliability: { no_shows: number; late_cancels: number; desk_only: boolean };
}
interface Found {
  clients: Client[];
  truncated: boolean;
}
interface History {
  client: Client;
  upcoming: { appointment_id: string; status: string; start: { label: string } }[];
  past: { appointment_id: string; status: string }[];
}

let a: Salon;
let staff: Connected;
let owner: Connected;
let dana: string;
let cut: string;
let maria: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a } = await seedTwoSalons(prisma));
  staff = await connectAs(prisma, { businessId: a.businessId, staffUserId: a.staffId, issuedById: a.ownerId }, deps);
  owner = await connectAs(prisma, { businessId: a.businessId, staffUserId: a.ownerId, issuedById: a.ownerId }, deps);
  dana = (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Dana' } })).id;
  cut = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Cut' } })).id;
  maria = (
    await prisma.client.create({
      data: { businessId: a.businessId, name: 'Maria Gomez', phone: PHONE, email: EMAIL, notes: NOTE },
      select: { id: true },
    })
  ).id;
});

const call = (c: Connected, name: string, args: Record<string, unknown>) => c.client.callTool({ name, arguments: args });
const textOf = (r: CallResult) => (r.content as { text: string }[])[0]!.text;
const book = (startIso: string, now: Date, clientId = maria) =>
  bookAppointment(prisma, {
    businessId: a.businessId,
    providerId: dana,
    serviceIds: [cut],
    clientId,
    startAt: toDate(instantFromIso(startIso)),
    now,
    actor: staffActor(a.ownerId),
    audience: 'staff',
  });

describe('find_client', () => {
  it('matches by name and by phone digits; returns last four, reliability, and nothing else personal', async () => {
    const byName = await call(staff, 'find_client', { query: 'gomez' });
    expect(errorOf(byName)).toBeNull();
    const data = byName.structuredContent as Found;
    expect(data).toEqual({
      clients: [{ id: maria, name: 'Maria Gomez', phone_last4: '0142', reliability: { no_shows: 0, late_cancels: 0, desk_only: false } }],
      truncated: false,
    });
    const json = JSON.stringify(byName);
    expect(json).not.toContain('5550142');
    expect(json).not.toContain(NOTE);
    expect(json).not.toContain(EMAIL);
    expect(textOf(byName)).toBe('1 match for "gomez": Maria Gomez.');

    const byPhone = await call(staff, 'find_client', { query: '555 0142' });
    expect((byPhone.structuredContent as Found).clients.map((c) => c.id)).toEqual([maria]);
  });

  it(`caps at ${FIND_CLIENT_LIMIT} and says the list was cut`, async () => {
    for (let i = 0; i < FIND_CLIENT_LIMIT + 2; i++) {
      await prisma.client.create({ data: { businessId: a.businessId, name: `Ann Example ${i}`, phone: `+1312555020${i}` } });
    }
    const r = await call(staff, 'find_client', { query: 'Ann Example' });
    const data = r.structuredContent as Found;
    expect(data.clients).toHaveLength(FIND_CLIENT_LIMIT);
    expect(data.truncated).toBe(true);
    expect(textOf(r)).toMatch(/7 matches .* showing 5 — refine the query/);
  });

  it('no match points at prepare_new_client', async () => {
    const r = await call(staff, 'find_client', { query: 'Nobody Here' });
    expect(r.structuredContent).toEqual({ clients: [], truncated: false });
    expect(textOf(r)).toBe('No client matches "Nobody Here". prepare_new_client adds one.');
  });

  it('the reliability flag counts a no-show', async () => {
    const past = await book('2026-06-04T15:00:00Z', toDate(instantFromIso('2026-06-04T14:00:00Z'))); // Thu 10:00 CDT, last week
    await transitionAppointment(prisma, {
      businessId: a.businessId,
      appointmentId: past.id,
      to: 'no_show',
      actor: staffActor(a.ownerId),
      now: toDate(instantFromIso('2026-06-04T15:30:00Z')),
    });
    const r = await call(staff, 'find_client', { query: 'Maria' });
    expect((r.structuredContent as Found).clients[0]!.reliability).toEqual({ no_shows: 1, late_cancels: 0, desk_only: false });
  });
});

describe('get_client_history', () => {
  it('splits upcoming from past around now, newest past first, and carries no notes or phone', async () => {
    const past = await book('2026-06-04T15:00:00Z', toDate(instantFromIso('2026-06-04T14:00:00Z')));
    const later = await book('2026-06-11T15:00:00Z', NOW); // Thu 10:00 CDT
    const sooner = await book('2026-06-10T15:00:00Z', NOW); // Wed 10:00 CDT
    const r = await call(staff, 'get_client_history', { client_id: maria });
    expect(errorOf(r)).toBeNull();
    const data = r.structuredContent as History;
    expect(data.upcoming.map((v) => v.appointment_id)).toEqual([sooner.id, later.id]);
    expect(data.past.map((v) => v.appointment_id)).toEqual([past.id]);
    expect(data.client.phone_last4).toBe('0142');
    const json = JSON.stringify(r);
    expect(json).not.toContain(NOTE);
    expect(json).not.toContain('5550142');
    expect(textOf(r)).toBe('Maria Gomez: 1 past visit, 2 upcoming (next Wed 10 Jun, 10:00 am with Dana); 0 no-shows.');
  });

  it('an unknown client is NOT_FOUND pointing at find_client', async () => {
    expect(errorOf(await call(staff, 'get_client_history', { client_id: 'nope' }))).toMatchObject({ error: 'NOT_FOUND', field: 'client_id', next: { tool: 'find_client' } });
  });
});

describe('list_waitlist', () => {
  it('lists active entries, filters by a day inside the range, and shows no phone', async () => {
    await createWaitlistEntry(prisma, {
      businessId: a.businessId,
      clientId: maria,
      serviceIds: [cut],
      providerIds: [dana],
      fromDay: '2026-06-15',
      toDay: '2026-06-19',
      dayParts: ['afternoon'],
    });
    const all = await call(staff, 'list_waitlist', {});
    const entries = (all.structuredContent as { entries: { client_id: string; client_name: string; services: string[]; provider_ids: string[]; day_parts: string[] }[] }).entries;
    const mine = entries.find((e) => e.client_id === maria)!;
    expect(mine).toMatchObject({ client_name: 'Maria Gomez', services: ['Cut'], provider_ids: [dana], day_parts: ['afternoon'] });
    expect(JSON.stringify(all)).not.toContain('5550142');

    const inside = (await call(staff, 'list_waitlist', { day: '2026-06-17' })).structuredContent as { entries: { client_id: string }[] };
    expect(inside.entries.map((e) => e.client_id)).toContain(maria);
    const outside = (await call(staff, 'list_waitlist', { day: '2026-06-20' })).structuredContent as { entries: { client_id: string }[] };
    expect(outside.entries.map((e) => e.client_id)).not.toContain(maria);
    expect(errorOf(await call(staff, 'list_waitlist', { day: 'next week' }))).toMatchObject({ error: 'INVALID_ARGUMENT', field: 'day' });
  });
});

describe('get_week_report (owner only)', () => {
  it('the owner gets the dashboard week; a stylist does not have the tool at all', async () => {
    await book('2026-06-10T15:00:00Z', NOW);
    const r = await call(owner, 'get_week_report', { week_of: '2026-06-10' });
    expect(errorOf(r)).toBeNull();
    const data = r.structuredContent as { from_day: string; to_day: string; bookings: number; utilization: { name: string }[] };
    expect(data.from_day).toBe('2026-06-08');
    expect(data.to_day).toBe('2026-06-14');
    expect(data.bookings).toBe(2); // the seed's Thursday booking plus this one
    expect(data.utilization.map((u) => u.name).sort()).toEqual(['Dana', 'Marcus', 'Priya', 'Tess']);
    expect(textOf(r)).toBe('Week of Mon 8 Jun: 2 bookings, 0 cancellations (0 late), 0 no-shows.');

    const staffTools = (await staff.client.listTools()).tools.map((t) => t.name);
    expect(staffTools).not.toContain('get_week_report');
    expect((await owner.client.listTools()).tools.map((t) => t.name)).toContain('get_week_report');
    // Not listed AND not callable: the protocol refuses an unknown tool before any handler runs —
    // no envelope of ours, so nothing says the tool exists for somebody else.
    const refused = await call(staff, 'get_week_report', { week_of: '2026-06-10' });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
    expect(textOf(refused)).toMatch(/Tool get_week_report not found/);
  });
});
