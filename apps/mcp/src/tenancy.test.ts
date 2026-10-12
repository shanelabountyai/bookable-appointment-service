/**
 * M-003 — tenancy (PRD §9.2): a token for salon B can never name a salon-A id,
 * on ANY tool. Every tool is covered by construction: each entry in TOOLS must
 * appear in `PROBES` below (a tool missing here fails the first test), and
 * every probe is run with B's token against A's ids.
 *
 * Two probe kinds:
 *  - `args`: a call carrying A's ids must come back `NOT_FOUND` — never a hint
 *    that the id exists elsewhere;
 *  - `leaks`: a call with no id arguments must return nothing of A's — the
 *    ids it lists are checked against every A id we know.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@bookable/db';
import { resetDatabase } from '@bookable/db/testing';
import { instantFromIso, toDate } from '@bookable/core/time';
import { connectAs, errorOf } from './testing/connect';
import { seedTwoSalons, type Salon } from './testing/two-salons';
import { TOOLS } from './tools';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const deps = { prisma, now: () => NOW };

type Probe =
  | { kind: 'args'; args: (a: Salon, b: Salon) => Record<string, unknown> }
  | { kind: 'leaks'; args?: Record<string, unknown>; ids: (data: unknown) => string[] }
  /** The tool takes no ids and lists nothing — say so explicitly rather than leaving it off the registry. */
  | { kind: 'none'; why: string };

/** One entry per tool. Adding a tool without a probe fails `every tool has a probe`. */
const PROBES: Record<string, Probe[]> = {
  list_services: [{ kind: 'leaks', ids: (data) => (data as { services: { id: string }[] }).services.map((s) => s.id) }],
  list_providers: [
    { kind: 'leaks', ids: (data) => (data as { providers: { id: string; service_ids: string[] }[] }).providers.flatMap((p) => [p.id, ...p.service_ids]) },
    { kind: 'args', args: (a) => ({ service_ids: [a.serviceIds[0]] }) },
  ],
  get_day: [
    { kind: 'leaks', args: { day: '2026-06-10' }, ids: (data) => (data as { columns: { provider_id: string }[] }).columns.map((c) => c.provider_id) },
    { kind: 'args', args: (a) => ({ day: '2026-06-10', provider_id: a.providerIds[0] }) },
  ],
  get_appointment: [{ kind: 'args', args: (a) => ({ appointment_id: a.appointmentId }) }],
  find_client: [{ kind: 'leaks', args: { query: 'Alex' }, ids: (data) => (data as { clients: { id: string }[] }).clients.map((c) => c.id) }],
  get_client_history: [{ kind: 'args', args: (a) => ({ client_id: a.clientId }) }],
  list_waitlist: [{ kind: 'leaks', ids: (data) => (data as { entries: { entry_id: string; client_id: string }[] }).entries.flatMap((e) => [e.entry_id, e.client_id]) }],
  get_week_report: [{ kind: 'leaks', args: { week_of: '2026-06-10' }, ids: (data) => (data as { utilization: { provider_id: string }[] }).utilization.map((u) => u.provider_id) }],
  prepare_booking: [
    { kind: 'args', args: (a, b) => ({ client_id: a.clientId, service_ids: b.serviceIds, provider_id: b.providerIds[0], start: '2026-06-12 10:00' }) },
    { kind: 'args', args: (a, b) => ({ client_id: b.clientId, service_ids: a.serviceIds.slice(0, 1), provider_id: b.providerIds[0], start: '2026-06-12 10:00' }) },
    { kind: 'args', args: (a, b) => ({ client_id: b.clientId, service_ids: b.serviceIds, provider_id: a.providerIds[0], start: '2026-06-12 10:00' }) },
  ],
  prepare_new_client: [{ kind: 'none', why: 'takes a name and a phone; the phone lookup is scoped to the business in prepare' }],
  commit_proposal: [{ kind: 'args', args: (a) => ({ proposal_id: a.proposalId }) }],
  find_open_times: [
    { kind: 'args', args: (a) => ({ service_ids: [a.serviceIds[0]], provider_id: 'any', from_day: '2026-06-10', to_day: '2026-06-10' }) },
    { kind: 'args', args: (a, b) => ({ service_ids: b.serviceIds, provider_id: a.providerIds[0], from_day: '2026-06-10', to_day: '2026-06-10' }) },
  ],
};

let a: Salon;
let b: Salon;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a, b } = await seedTwoSalons(prisma));
});

describe('tenancy', () => {
  it('every tool has a probe', () => {
    expect(Object.keys(PROBES).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it.each(Object.entries(PROBES))('%s: a salon-B token sees nothing of salon A', async (name, probes) => {
    const { client, close } = await connectAs(prisma, { businessId: b.businessId, staffUserId: b.ownerId, issuedById: b.ownerId }, deps);
    try {
      const aIds = new Set([a.businessId, a.ownerId, a.staffId, a.appointmentId, a.clientId, a.proposalId, ...a.serviceIds, ...a.providerIds]);
      for (const probe of probes) {
        if (probe.kind === 'none') continue;
        if (probe.kind === 'args') {
          const result = await client.callTool({ name, arguments: probe.args(a, b) });
          expect(errorOf(result), JSON.stringify(probe.args(a, b))).toMatchObject({ error: 'NOT_FOUND' });
          expect(JSON.stringify(result)).not.toMatch(/another|other business|elsewhere/i);
        } else {
          const result = await client.callTool({ name, arguments: probe.args ?? {} });
          expect(errorOf(result)).toBeNull();
          const ids = probe.ids(result.structuredContent);
          expect(ids.filter((id) => aIds.has(id))).toEqual([]);
          expect(ids.length).toBeGreaterThan(0);
        }
      }
    } finally {
      await close();
    }
  });
});
