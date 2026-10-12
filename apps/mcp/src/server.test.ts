/**
 * M-001/M-003 — the server answers a real MCP client end-to-end, lists per
 * role, and re-checks the credential on every call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@bookable/db';
import { revokeMcpToken } from '@bookable/db/mcp';
import { resetDatabase } from '@bookable/db/testing';
import { instantFromIso, toDate } from '@bookable/core/time';
import { contextForToken } from './context';
import { connectAs, connectWithToken, errorOf } from './testing/connect';
import { seedTwoSalons, type Salon } from './testing/two-salons';
import { TOOLS } from './tools';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const deps = { prisma, now: () => NOW };

let a: Salon;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a } = await seedTwoSalons(prisma));
});

const asOwner = () => connectAs(prisma, { businessId: a.businessId, staffUserId: a.ownerId, issuedById: a.ownerId }, deps);
const asStaff = () => connectAs(prisma, { businessId: a.businessId, staffUserId: a.staffId, issuedById: a.ownerId }, deps);

describe('tools/list is built per role', () => {
  it.each(['owner', 'staff'] as const)('%s sees exactly the tools whose roles include it', async (role) => {
    const { client, close } = await (role === 'owner' ? asOwner() : asStaff());
    try {
      const { tools } = await client.listTools();
      const expected = TOOLS.filter((t) => t.roles.includes(role)).map((t) => t.name).sort();
      expect(tools.map((t) => t.name).sort()).toEqual(expected);
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});

describe('list_services', () => {
  it('is listed with read-only annotations and answers with the seeded services', async () => {
    const { client, close } = await asStaff();
    try {
      const { tools } = await client.listTools();
      const listed = tools.find((t) => t.name === 'list_services');
      expect(listed?.annotations?.readOnlyHint).toBe(true);
      expect(listed?.annotations?.destructiveHint).toBeFalsy();
      expect(listed?.description).toMatch(/find_open_times/);

      const result = await client.callTool({ name: 'list_services', arguments: {} });
      expect(errorOf(result)).toBeNull();
      const data = result.structuredContent as { services: { id: string; price_cents: number }[] };
      expect(data.services.map((s) => s.id).sort()).toEqual([...a.serviceIds].sort());
      expect(data.services.every((s) => Number.isInteger(s.price_cents))).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: `${a.serviceIds.length} active services.` }]);
    } finally {
      await close();
    }
  });

  it('leaves out a deactivated service — the desk cannot book it either', async () => {
    const gone = a.serviceIds[0]!;
    await prisma.service.update({ where: { id: gone }, data: { active: false } });
    const { client, close } = await asOwner();
    try {
      const result = await client.callTool({ name: 'list_services', arguments: {} });
      const data = result.structuredContent as { services: { id: string }[] };
      expect(data.services.map((s) => s.id)).not.toContain(gone);
      expect(data.services).toHaveLength(a.serviceIds.length - 1);
    } finally {
      await close();
    }
  });
});

describe('the credential is re-checked on every call (PRD §9.3)', () => {
  it('a token revoked mid-session fails on the very next call', async () => {
    const { client, token, close } = await asStaff();
    try {
      expect(errorOf(await client.callTool({ name: 'list_services', arguments: {} }))).toBeNull();
      const ctx = await contextForToken(prisma, token, NOW);
      await revokeMcpToken(prisma, { businessId: a.businessId, id: ctx!.tokenId, now: NOW });
      const refused = await client.callTool({ name: 'list_services', arguments: {} });
      expect(errorOf(refused)).toMatchObject({ error: 'UNAUTHORIZED', message: expect.stringMatching(/owner/) });
      expect(errorOf(refused)).not.toHaveProperty('next');
    } finally {
      await close();
    }
  });

  it('a person taken off the roster mid-session fails on the very next call', async () => {
    const { client, close } = await asStaff();
    try {
      await prisma.staffUser.update({ where: { id: a.staffId }, data: { active: false } });
      expect(errorOf(await client.callTool({ name: 'list_services', arguments: {} }))).toMatchObject({ error: 'UNAUTHORIZED' });
    } finally {
      await close();
    }
  });

  it('a revoked token cannot open a connection at all', async () => {
    const { token, close } = await asStaff();
    await close();
    const ctx = await contextForToken(prisma, token, NOW);
    await revokeMcpToken(prisma, { businessId: a.businessId, id: ctx!.tokenId, now: NOW });
    expect(await contextForToken(prisma, token, NOW)).toBeNull();
    await expect(connectWithToken(token, deps)).rejects.toThrow(/did not resolve/);
  });
});
