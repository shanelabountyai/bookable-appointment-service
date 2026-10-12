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
  | { kind: 'args'; args: (a: Salon) => Record<string, unknown> }
  | { kind: 'leaks'; args?: Record<string, unknown>; ids: (data: unknown) => string[] };

/** One entry per tool. Adding a tool without a probe fails `every tool has a probe`. */
const PROBES: Record<string, Probe> = {
  list_services: {
    kind: 'leaks',
    ids: (data) => (data as { services: { id: string }[] }).services.map((s) => s.id),
  },
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

  it.each(Object.entries(PROBES))('%s: a salon-B token sees nothing of salon A', async (name, probe) => {
    const { client, close } = await connectAs(prisma, { businessId: b.businessId, staffUserId: b.ownerId, issuedById: b.ownerId }, deps);
    try {
      const aIds = new Set([a.businessId, a.ownerId, a.staffId, ...a.serviceIds, ...a.providerIds]);
      if (probe.kind === 'args') {
        const result = await client.callTool({ name, arguments: probe.args(a) });
        expect(errorOf(result)).toMatchObject({ error: 'NOT_FOUND' });
        expect(JSON.stringify(result)).not.toMatch(/another|other business|elsewhere/i);
      } else {
        const result = await client.callTool({ name, arguments: probe.args ?? {} });
        expect(errorOf(result)).toBeNull();
        const ids = probe.ids(result.structuredContent);
        expect(ids.filter((id) => aIds.has(id))).toEqual([]);
        expect(ids.length).toBeGreaterThan(0);
      }
    } finally {
      await close();
    }
  });
});
