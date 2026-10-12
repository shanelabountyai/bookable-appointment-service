/**
 * M-002 — the token is a credential: issued once, stored hashed, revocable,
 * and dead the moment its person leaves the roster. A second business is
 * seeded so "scoped to the business" is asserted, not assumed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { hashManageToken } from '../../core/auth';
import { seedStaffUser } from '../auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { McpTokenRejected, issueMcpToken, listMcpTokens, resolveMcpToken, revokeMcpToken } from './tokens';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const LATER = toDate(instantFromIso('2026-06-09T14:05:00Z'));

let a: { businessId: string; ownerId: string; staffId: string };
let b: { businessId: string; ownerId: string };

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
  const ownerA = await seedStaffUser(prisma, { email: 'a@example.test', password: 'pw-owner-a-1234', name: 'Sam' });
  const staffA = await prisma.staffUser.create({
    data: { businessId: ownerA.businessId, name: 'Priya', role: 'staff' },
    select: { id: true },
  });
  const bizB = await prisma.business.create({ data: { name: 'Other Salon', timezone: 'America/Chicago' } });
  const ownerB = await seedStaffUser(prisma, {
    businessId: bizB.id,
    email: 'b@example.test',
    password: 'pw-owner-b-1234',
    name: 'Bea',
  });
  a = { businessId: ownerA.businessId, ownerId: ownerA.staffUserId, staffId: staffA.id };
  b = { businessId: bizB.id, ownerId: ownerB.staffUserId };
});

const issueFor = (staffUserId: string, label = "Priya's phone") =>
  issueMcpToken(prisma, { businessId: a.businessId, staffUserId, issuedById: a.ownerId, label, now: NOW });

describe('issueMcpToken', () => {
  it('stores only the hash, and the token resolves to its person, business and role', async () => {
    const issued = await issueFor(a.staffId);
    expect(issued.token).toMatch(/^bk_mcp_[A-Za-z0-9_-]{43}$/);

    const row = await prisma.mcpToken.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.tokenHash).toBe(hashManageToken(issued.token));
    expect(JSON.stringify(row)).not.toContain(issued.token);

    const grant = await resolveMcpToken(prisma, issued.token, LATER);
    expect(grant).toEqual({
      tokenId: issued.id,
      businessId: a.businessId,
      staffUserId: a.staffId,
      staffName: 'Priya',
      role: 'staff',
    });
    const [listed] = await listMcpTokens(prisma, a.businessId);
    expect(listed).toMatchObject({ staffName: 'Priya', label: "Priya's phone", lastUsedAt: LATER, revokedAt: null });
  });

  it('refuses a blank label, a person off the roster, and a person from another business', async () => {
    await expect(issueFor(a.staffId, '  ')).rejects.toBeInstanceOf(McpTokenRejected);
    await prisma.staffUser.update({ where: { id: a.staffId }, data: { active: false } });
    await expect(issueFor(a.staffId)).rejects.toThrow(/off the roster/);
    await expect(issueFor(b.ownerId)).rejects.toThrow(/not on this roster/);
    expect(await prisma.mcpToken.count()).toBe(0);
  });
});

describe('resolveMcpToken', () => {
  it('is null for an unknown token, a wrong-prefix string, and a revoked token', async () => {
    const issued = await issueFor(a.staffId);
    expect(await resolveMcpToken(prisma, 'bk_mcp_' + 'x'.repeat(43), NOW)).toBeNull();
    expect(await resolveMcpToken(prisma, issued.token.slice(7), NOW)).toBeNull();

    expect(await revokeMcpToken(prisma, { businessId: a.businessId, id: issued.id, now: NOW })).toBe(true);
    expect(await resolveMcpToken(prisma, issued.token, LATER)).toBeNull();
    // Revoking again keeps the first time; revoking from the other business is "nobody".
    expect(await revokeMcpToken(prisma, { businessId: a.businessId, id: issued.id, now: LATER })).toBe(true);
    expect(await revokeMcpToken(prisma, { businessId: b.businessId, id: issued.id, now: LATER })).toBe(false);
    const row = await prisma.mcpToken.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.revokedAt).toEqual(NOW);
  });

  it('is null once its person is deactivated — off the roster revokes every token on the next call', async () => {
    const issued = await issueFor(a.staffId);
    expect(await resolveMcpToken(prisma, issued.token, NOW)).not.toBeNull();
    await prisma.staffUser.update({ where: { id: a.staffId }, data: { active: false } });
    expect(await resolveMcpToken(prisma, issued.token, LATER)).toBeNull();
  });

  it('does not list another business’s tokens', async () => {
    await issueFor(a.staffId);
    expect(await listMcpTokens(prisma, b.businessId)).toEqual([]);
  });
});
