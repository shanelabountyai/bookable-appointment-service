/**
 * M-005 — list_providers and find_open_times (PRD §7).
 *
 * The seed: Tue–Sat, providers 09:00–17:00 with a 12:00–13:00 break; Tess is
 * junior (Cut, Blow-dry, Fringe trim, Treatment only). NOW is Tue 2026-06-09
 * 09:00 CDT. The assertion that matters most is the EQUALITY one: the
 * named-stylist path and the "any" path are two code paths answering one
 * question, and must agree for every stylist.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { bookAppointment } from '@bookable/db/booking';
import { resetDatabase } from '@bookable/db/testing';
import { connectAs, errorOf, type CallResult, type Connected } from '../testing/connect';
import { seedTwoSalons, type Salon } from '../testing/two-salons';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const deps = { prisma, now: () => NOW };
const WED = '2026-06-10';

interface Day {
  day: string;
  label: string;
  providers: { provider_id: string; name: string; times: { label: string; iso: string; free_count?: number }[] }[];
}
interface Found {
  days: Day[];
  count: number;
}

let a: Salon;
let conn: Connected;
let byName: Map<string, string>;
let serviceId: (name: string) => string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a } = await seedTwoSalons(prisma));
  conn = await connectAs(prisma, { businessId: a.businessId, staffUserId: a.staffId, issuedById: a.ownerId }, deps);
  const providers = await prisma.provider.findMany({ where: { businessId: a.businessId }, select: { id: true, displayName: true } });
  byName = new Map(providers.map((p) => [p.displayName, p.id]));
  const services = await prisma.service.findMany({ where: { businessId: a.businessId }, select: { id: true, name: true } });
  const sByName = new Map(services.map((s) => [s.name, s.id]));
  serviceId = (name) => sByName.get(name)!;
});

const call = (name: string, args: Record<string, unknown>) => conn.client.callTool({ name, arguments: args });
const textOf = (r: CallResult) => (r.content as { text: string }[])[0]!.text;
const find = async (args: Record<string, unknown>) => {
  const r = await call('find_open_times', { provider_id: 'any', from_day: WED, to_day: WED, ...args });
  return { error: errorOf(r), data: r.structuredContent as Found, text: textOf(r) };
};
const timesFor = (data: Found, providerId: string) =>
  data.days.flatMap((d) => d.providers.filter((p) => p.provider_id === providerId).flatMap((p) => p.times.map((t) => t.iso)));

describe('list_providers', () => {
  it('lists every active stylist with the services they can do; Tess is junior', async () => {
    const r = await call('list_providers', {});
    const { providers } = r.structuredContent as { providers: { id: string; name: string; service_ids: string[] }[] };
    expect(providers.map((p) => p.name).sort()).toEqual([...byName.keys()].sort());
    const tess = providers.find((p) => p.name === 'Tess')!;
    expect(tess.service_ids).toHaveLength(4);
    expect(providers.filter((p) => p.name !== 'Tess').every((p) => p.service_ids.length === a.serviceIds.length)).toBe(true);
  });

  it('narrows to stylists qualified for the WHOLE visit', async () => {
    const colour = await call('list_providers', { service_ids: [serviceId('Colour')] });
    const names = (colour.structuredContent as { providers: { name: string }[] }).providers.map((p) => p.name);
    expect(names).not.toContain('Tess');
    expect(names).toHaveLength(byName.size - 1);
    const both = await call('list_providers', { service_ids: [serviceId('Cut'), serviceId('Colour')] });
    expect((both.structuredContent as { providers: unknown[] }).providers).toHaveLength(byName.size - 1);
    expect(textOf(both)).toMatch(/can do that whole visit/);
  });

  it('an unknown service id is NOT_FOUND pointing at list_services', async () => {
    expect(errorOf(await call('list_providers', { service_ids: ['nope'] }))).toMatchObject({
      error: 'NOT_FOUND',
      field: 'service_ids',
      next: { tool: 'list_services' },
    });
  });
});

describe('find_open_times', () => {
  it('a named stylist: starts at opening, skips the lunch break, ends in time for the visit and its buffer', async () => {
    const dana = byName.get('Dana')!;
    const { error, data, text } = await find({ provider_id: dana, service_ids: [serviceId('Cut')] });
    expect(error).toBeNull();
    expect(data.days).toHaveLength(1);
    const times = data.days[0]!.providers[0]!.times;
    expect(data.days[0]!.providers[0]!.name).toBe('Dana');
    expect(times[0]).toEqual({ label: 'Wed 10 Jun, 9:00 am', iso: '2026-06-10T09:00:00-05:00' });
    expect(times.some((t) => t.label.includes('12:'))).toBe(false);
    // Cut is 45 min: the BODY must end by the 17:00 close, so 16:15 is the last start. Its 10-minute
    // after-buffer runs past close — a buffer is the stylist's clean-up, not client time (spec BUF-*).
    expect(times.at(-1)!.iso).toBe('2026-06-10T16:15:00-05:00');
    expect(times.every((t) => t.free_count === undefined)).toBe(true);
    expect(data.count).toBe(times.length);
    expect(text).toBe(`${times.length} open times with Dana, Wed 10 Jun.`);
  });

  it('EQUALITY: the "any" path and the named paths answer one question the same way', async () => {
    const serviceIds = [serviceId('Cut')];
    const any = (await find({ service_ids: serviceIds })).data;
    const named = new Map<string, string[]>();
    for (const [, id] of byName) named.set(id, timesFor((await find({ provider_id: id, service_ids: serviceIds })).data, id));

    // (1) "any" lists each instant once, under a stylist whose own column offers it.
    const anyEntries = any.days.flatMap((d) => d.providers.flatMap((p) => p.times.map((t) => ({ ...t, provider_id: p.provider_id }))));
    expect(anyEntries.length).toBeGreaterThan(0);
    expect(new Set(anyEntries.map((t) => t.iso)).size).toBe(anyEntries.length);
    for (const t of anyEntries) expect(named.get(t.provider_id), `${t.iso} assigned to ${t.provider_id}`).toContain(t.iso);

    // (2) Every instant any stylist offers is offered by "any", and free_count is exactly how many offer it.
    const union = new Set([...named.values()].flat());
    expect(new Set(anyEntries.map((t) => t.iso))).toEqual(union);
    for (const t of anyEntries) {
      const free = [...named.values()].filter((times) => times.includes(t.iso)).length;
      expect(t.free_count, t.iso).toBe(free);
    }
  });

  it('a booked time disappears for that stylist and stays offered through others', async () => {
    const dana = byName.get('Dana')!;
    const at = toDate(instantFromIso('2026-06-10T15:00:00Z')); // 10:00 CDT
    await bookAppointment(prisma, {
      businessId: a.businessId,
      providerId: dana,
      serviceIds: [serviceId('Cut')],
      startAt: at,
      now: NOW,
      actor: staffActor(a.ownerId),
      audience: 'staff',
    });
    const named = (await find({ provider_id: dana, service_ids: [serviceId('Cut')] })).data;
    expect(timesFor(named, dana)).not.toContain('2026-06-10T10:00:00-05:00');
    // Buffer after (10 min) means 10:45 is blocked too for Dana; 11:00 is back.
    expect(timesFor(named, dana)).not.toContain('2026-06-10T10:45:00-05:00');
    expect(timesFor(named, dana)).toContain('2026-06-10T11:00:00-05:00');
    const any = (await find({ service_ids: [serviceId('Cut')] })).data;
    const tenAm = any.days[0]!.providers.filter((p) => p.times.some((t) => t.iso === '2026-06-10T10:00:00-05:00'));
    expect(tenAm.map((p) => p.provider_id)).not.toContain(dana);
    expect(tenAm.length).toBeGreaterThan(0);
  });

  it('part_of_day keeps only that band', async () => {
    const { data } = await find({ service_ids: [serviceId('Cut')], part_of_day: 'afternoon' });
    const labels = data.days.flatMap((d) => d.providers.flatMap((p) => p.times.map((t) => t.iso.slice(11, 16))));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((t) => t >= '12:00' && t < '17:00')).toBe(true);
  });

  it('a closed day yields no days, and the summary says so', async () => {
    const { data, text } = await find({ service_ids: [serviceId('Cut')], from_day: '2026-06-14', to_day: '2026-06-14' }); // Sunday
    expect(data).toEqual({ days: [], count: 0 });
    expect(text).toMatch(/^0 open times with any stylist, Sun 14 Jun — try/);
  });

  it('refuses a range over 14 days, an inverted range, and a malformed day — each naming its field', async () => {
    expect((await find({ service_ids: [serviceId('Cut')], to_day: '2026-06-24' })).error).toMatchObject({ error: 'INVALID_ARGUMENT', field: 'to_day' });
    expect((await find({ service_ids: [serviceId('Cut')], to_day: '2026-06-23' })).error).toBeNull();
    expect((await find({ service_ids: [serviceId('Cut')], to_day: '2026-06-09' })).error).toMatchObject({ error: 'INVALID_ARGUMENT', field: 'to_day' });
    expect((await find({ service_ids: [serviceId('Cut')], from_day: 'June 10' })).error).toMatchObject({ error: 'INVALID_ARGUMENT', field: 'from_day' });
  });

  it('a stylist who cannot do the visit is NOT_QUALIFIED pointing at list_providers; unknown ids are NOT_FOUND', async () => {
    expect((await find({ provider_id: byName.get('Tess')!, service_ids: [serviceId('Colour')] })).error).toMatchObject({
      error: 'NOT_QUALIFIED',
      field: 'provider_id',
      next: { tool: 'list_providers' },
    });
    expect((await find({ provider_id: 'nope', service_ids: [serviceId('Cut')] })).error).toMatchObject({ error: 'NOT_FOUND', field: 'provider_id' });
    expect((await find({ service_ids: [serviceId('Cut')], client_id: 'nope' })).error).toMatchObject({ error: 'NOT_FOUND', field: 'client_id', next: { tool: 'find_client' } });
  });

  it('fall-back day: 1:30 am is offered TWICE, as two instants with their offsets (spec FB-1/FB-4)', async () => {
    const dana = byName.get('Dana')!;
    for (const providerId of [null, dana]) {
      const override = await prisma.dateOverride.create({
        data: { businessId: a.businessId, providerId, day: '2026-11-01', isClosed: false },
      });
      await prisma.dateOverrideWindow.create({
        data: { businessId: a.businessId, dateOverrideId: override.id, open: '00:00', close: '23:59' },
      });
    }
    const { data } = await find({ provider_id: dana, service_ids: [serviceId('Fringe trim')], from_day: '2026-11-01', to_day: '2026-11-01' });
    const oneThirty = data.days[0]!.providers[0]!.times.filter((t) => t.label.startsWith('Sun 1 Nov, 1:30 am'));
    expect(oneThirty).toEqual([
      { label: 'Sun 1 Nov, 1:30 am CDT', iso: '2026-11-01T01:30:00-05:00' },
      { label: 'Sun 1 Nov, 1:30 am CST', iso: '2026-11-01T01:30:00-06:00' },
    ]);
  });
});
