/**
 * W-003 — services, providers, availability (API PRD §7, §9.1, §9.6).
 *
 * The test that matters most is AVAILABILITY EQUALITY (CLAUDE.md: "one
 * operational question, two readers, assert equal"): `GET /v1/availability`
 * and the desk's offer path — `computeDaySlots` / `anyProviderTimes` with the
 * client as holder, exactly what `/staff/book` calls — must return the SAME
 * set, in a room where exactly ONE chair can seat the visit (A-083's fixture:
 * two chairs, one held by the client herself, one by a stranger). On an open
 * room the strict and the holder-aware questions agree and the test could not
 * fail; this room is interesting enough for them to differ, and the premise is
 * asserted so the day somebody "simplifies" the fixture, the test says so.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { fromDate, instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { anyProviderTimes, bookAppointment } from '@bookable/db/booking';
import { computeDaySlots } from '@bookable/db/scheduling';
import { resetDatabase } from '@bookable/db/testing';
import { getAvailability, getProviders, getServices } from './catalog';
import { type Caller, keyFor, seedTwoSalons, type Salon } from './testing';
import { isoOf } from './time';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const deps = { prisma, now: () => NOW };
const READ = { scope: 'read' } as const;

let a: Salon;
let b: Salon;
let key: Caller;
let byName: Record<string, string>;
let svc: Record<string, string>;

beforeAll(async () => prisma.$connect());
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a, b } = await seedTwoSalons(prisma));
  key = await keyFor(prisma, a, ['read'], deps);
  byName = Object.fromEntries((await prisma.provider.findMany({ where: { businessId: a.businessId } })).map((p) => [p.displayName, p.id]));
  svc = Object.fromEntries((await prisma.service.findMany({ where: { businessId: a.businessId } })).map((s) => [s.name, s.id]));
});

type Day = { date: string; providers: { providerId: string; name: string; starts: { startAt: string; freeCount?: number }[] }[] };
const avail = async (q: Record<string, string>, k = key) => k.call(READ, getAvailability, { path: `/api/v1/availability?${new URLSearchParams(q)}` });

describe('GET /v1/services', () => {
  it('lists active services with duration and segments; no price without the prices scope', async () => {
    const r = await key.call(READ, getServices, { path: '/api/v1/services' });
    expect(r.status).toBe(200);
    const data = r.body.data as Record<string, unknown>[];
    expect(data.map((s) => s.name)).toContain('Cut');
    expect(data.every((s) => !('priceCents' in s) && !('currency' in s))).toBe(true);
    expect(r.body.nextCursor).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain(b.serviceIds[0]);
  });

  it('with `prices`, every service carries priceCents and currency (W-D2)', async () => {
    const priced = await keyFor(prisma, a, ['read', 'prices'], deps, 'priced');
    const data = (await priced.call(READ, getServices, { path: '/' })).body.data as Record<string, unknown>[];
    const cut = await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Cut' } });
    expect(data.find((s) => s.name === 'Cut')).toMatchObject({ priceCents: cut.priceCents, currency: 'USD' });
  });
});

describe('GET /v1/providers', () => {
  it('lists providers with service ids, and narrows to those qualified for the whole visit', async () => {
    const all = (await key.call(READ, getProviders, { path: '/api/v1/providers' })).body.data as { name: string }[];
    expect(all.map((p) => p.name).sort()).toEqual(Object.keys(byName).sort());
    const colour = (await key.call(READ, getProviders, { path: `/api/v1/providers?serviceIds=${svc['Cut']},${svc['Colour']}` })).body.data as { name: string }[];
    expect(colour.map((p) => p.name)).not.toContain('Tess');
    expect(colour).toHaveLength(all.length - 1);
  });

  it("another business's service id is NOT_FOUND, an unknown query parameter is VALIDATION", async () => {
    const r = await key.call(READ, getProviders, { path: `/api/v1/providers?serviceIds=${b.serviceIds[0]}` });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'NOT_FOUND', next: { endpoint: 'GET /v1/services' } });
    expect((await key.call(READ, getProviders, { path: '/api/v1/providers?businessId=x' })).body.code).toBe('VALIDATION');
  });
});

describe('GET /v1/availability', () => {
  it('a named provider: instants with offsets plus local wall time and zone (§6.2); no lunch; no reasons', async () => {
    const r = await avail({ serviceIds: svc['Cut']!, providerId: byName['Dana']!, from: '2026-06-10', to: '2026-06-10' });
    expect(r.status).toBe(200);
    const days = r.body.data as Day[];
    expect(days).toHaveLength(1);
    const starts = days[0]!.providers[0]!.starts;
    expect(starts[0]).toEqual({ startAt: '2026-06-10T09:00:00-05:00', startLocal: { date: '2026-06-10', time: '09:00', zone: 'America/Chicago' } });
    expect(starts.some((s) => s.startAt.slice(11, 13) === '12')).toBe(false);
    expect(JSON.stringify(r.body)).not.toMatch(/overlaps|reason|excluded/);
  });

  it('refuses >14 days, an inverted range, a bad day; NOT_QUALIFIED for Tess on a colour; tenancy for every id', async () => {
    expect((await avail({ serviceIds: svc['Cut']!, from: '2026-06-10', to: '2026-06-24' })).body).toMatchObject({ code: 'VALIDATION', errors: [{ field: 'to' }] });
    expect((await avail({ serviceIds: svc['Cut']!, from: '2026-06-10', to: '2026-06-23' })).status).toBe(200);
    expect((await avail({ serviceIds: svc['Cut']!, from: '2026-06-10', to: '2026-06-09' })).body.code).toBe('VALIDATION');
    expect((await avail({ serviceIds: svc['Cut']!, from: 'June 10', to: '2026-06-10' })).body.code).toBe('VALIDATION');
    expect((await avail({ serviceIds: svc['Colour']!, providerId: byName['Tess']!, from: '2026-06-10', to: '2026-06-10' })).body).toMatchObject({ code: 'NOT_QUALIFIED', status: 422 });
    for (const q of [
      { serviceIds: b.serviceIds[0]! } as Record<string, string>,
      { serviceIds: svc['Cut']!, providerId: b.providerIds[0]! },
      { serviceIds: svc['Cut']!, clientId: b.clientId },
    ]) {
      expect((await avail({ from: '2026-06-10', to: '2026-06-10', ...q })).body.code).toBe('NOT_FOUND');
    }
  });

  it("a business-B key never sees business A's book", async () => {
    const kb = await keyFor(prisma, b, ['read'], deps, 'b');
    expect((await avail({ serviceIds: svc['Cut']!, from: '2026-06-10', to: '2026-06-10' }, kb)).body.code).toBe('NOT_FOUND');
  });
});

describe('AVAILABILITY EQUALITY — the API and the desk answer one question the same way (§9.6, A-082)', () => {
  const DAY = '2026-06-13';
  const NOW_SAT = toDate(instantFromIso('2026-06-13T13:00:00Z'));
  const CONTESTED = '2026-06-13T13:45:00-05:00';
  let nadia: string;

  beforeEach(async () => {
    // TWO chairs — a room that cannot bind cannot disagree with anything.
    const spare = await prisma.resource.findMany({ where: { businessId: a.businessId, active: true }, orderBy: { name: 'asc' }, skip: 2 });
    await prisma.resource.updateMany({ where: { id: { in: spare.map((r) => r.id) } }, data: { active: false } });
    const book = (provider: string, service: string, iso: string, clientId: string) =>
      bookAppointment(prisma, { businessId: a.businessId, providerId: byName[provider]!, serviceIds: [svc[service]!], clientId, startAt: toDate(instantFromIso(iso)), now: NOW_SAT, actor: staffActor(a.ownerId), audience: 'staff' });
    nadia = (await prisma.client.create({ data: { businessId: a.businessId, name: 'Nadia Okafor' } })).id;
    const ben = (await prisma.client.create({ data: { businessId: a.businessId, name: 'Ben Rios' } })).id;
    await book('Dana', 'Cut', '2026-06-13T13:00:00-05:00', nadia); // chair 1, hers
    await book('Marcus', 'Colour', CONTESTED, ben); // chair 2, a stranger's
  });

  const satDeps = { prisma, now: () => NOW_SAT };
  const apiStarts = async (q: Record<string, string>) => {
    const r = await key.call(READ, getAvailability, { path: `/api/v1/availability?${new URLSearchParams({ from: DAY, to: DAY, serviceIds: svc['Colour']!, ...q })}` });
    expect(r.status).toBe(200);
    return r.body.data as Day[];
  };

  it('the premise: in this room the client-aware and the anonymous question DIFFER at 13:45', async () => {
    const args = { businessId: a.businessId, providerId: byName['Priya']!, serviceIds: [svc['Colour']!], day: DAY, now: NOW_SAT, audience: 'staff' as const };
    const anon = await computeDaySlots(prisma, { ...args, holderKey: null });
    const hers = await computeDaySlots(prisma, { ...args, holderKey: nadia });
    const at = instantFromIso(CONTESTED);
    expect(anon.slots.map((s) => s.start), 'the fixture no longer binds — it cannot test anything').not.toContain(at);
    expect(hers.slots.map((s) => s.start)).toContain(at);
  });

  it('named provider: the API set EQUALS computeDaySlots with the same holder — with and without a client', async () => {
    key = await keyFor(prisma, a, ['read'], satDeps, 'sat');
    for (const holder of [nadia, null]) {
      const days = await apiStarts({ providerId: byName['Priya']!, ...(holder ? { clientId: holder } : {}) });
      const api = days.flatMap((d) => d.providers.flatMap((p) => p.starts.map((s) => s.startAt)));
      const desk = (
        await computeDaySlots(prisma, { businessId: a.businessId, providerId: byName['Priya']!, serviceIds: [svc['Colour']!], day: DAY, now: NOW_SAT, audience: 'staff', holderKey: holder })
      ).slots.map((s) => isoOf(s.start, 'America/Chicago' as never));
      expect(api).toEqual(desk);
      expect(api.includes('2026-06-13T13:45:00-05:00')).toBe(holder !== null);
    }
  });

  it('"any": the API set EQUALS anyProviderTimes with the same holder — instant, provider and freeCount', async () => {
    key = await keyFor(prisma, a, ['read'], satDeps, 'sat');
    for (const holder of [nadia, null]) {
      const days = await apiStarts(holder ? { clientId: holder } : {});
      const api = days.flatMap((d) => d.providers.flatMap((p) => p.starts.map((s) => `${s.startAt}|${p.providerId}|${s.freeCount}`))).sort();
      const desk = (await anyProviderTimes(prisma, { businessId: a.businessId, serviceIds: [svc['Colour']!], day: DAY, now: NOW_SAT, audience: 'staff', holderKey: holder }))
        .map((t) => `${isoOf(fromDate(t.at), 'America/Chicago' as never)}|${t.providerId}|${t.freeCount}`)
        .sort();
      expect(api).toEqual(desk);
      expect(api.length).toBeGreaterThan(0);
    }
  });
});
