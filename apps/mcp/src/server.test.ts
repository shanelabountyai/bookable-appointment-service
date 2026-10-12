/**
 * M-001 — the server answers a real MCP client end-to-end.
 *
 * Goes through `tools/list` and `tools/call` over an in-memory transport, so
 * what is asserted is what a client would see: the listing, the annotations,
 * the schema-validated `structuredContent`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@bookable/db';
import { seedStaffUser } from '@bookable/db/auth';
import { seedSetup } from '@bookable/db/settings';
import { resetDatabase } from '@bookable/db/testing';
import { instantFromIso, toDate } from '@bookable/core/time';
import { contextForStaffId, type CallerContext } from './context';
import { connectAs } from './testing/connect';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const deps = { prisma, now: () => NOW };

let owner: CallerContext;
let serviceIds: string[];

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
  const seeded = await seedStaffUser(prisma, { email: 'owner@example.test', password: 'pw-owner-1234', name: 'Sam' });
  ({ serviceIds } = await seedSetup(prisma));
  const ctx = await contextForStaffId(prisma, seeded.staffUserId);
  if (!ctx) throw new Error('seeded owner did not resolve');
  owner = ctx;
});

describe('list_services', () => {
  it('is listed with read-only annotations and answers with the seeded services', async () => {
    const { client, close } = await connectAs(owner, deps);
    try {
      const { tools } = await client.listTools();
      const listed = tools.find((t) => t.name === 'list_services');
      expect(listed?.annotations?.readOnlyHint).toBe(true);
      expect(listed?.annotations?.destructiveHint).toBeFalsy();
      expect(listed?.description).toMatch(/find_open_times/);

      const result = await client.callTool({ name: 'list_services', arguments: {} });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as { services: { id: string; price_cents: number }[] };
      expect(data.services.map((s) => s.id).sort()).toEqual([...serviceIds].sort());
      expect(data.services.every((s) => Number.isInteger(s.price_cents))).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: `${serviceIds.length} active services.` }]);
    } finally {
      await close();
    }
  });

  it('leaves out a deactivated service — the desk cannot book it either', async () => {
    const gone = serviceIds[0]!;
    await prisma.service.update({ where: { id: gone }, data: { active: false } });
    const { client, close } = await connectAs(owner, deps);
    try {
      const result = await client.callTool({ name: 'list_services', arguments: {} });
      const data = result.structuredContent as { services: { id: string }[] };
      expect(data.services.map((s) => s.id)).not.toContain(gone);
      expect(data.services).toHaveLength(serviceIds.length - 1);
    } finally {
      await close();
    }
  });
});

describe('contextForStaffId', () => {
  it('is null for a deactivated staff member, so deactivation revokes access', async () => {
    await prisma.staffUser.update({ where: { id: owner.staffUserId }, data: { active: false } });
    expect(await contextForStaffId(prisma, owner.staffUserId)).toBeNull();
  });
});
