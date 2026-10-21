/**
 * W-001 — the API key is a credential for an INTEGRATION: issued once by an
 * owner, stored hashed, scoped, revocable without touching anybody. A second
 * business is seeded so "scoped to the business" is asserted, not assumed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { hashManageToken } from '../../core/auth';
import { seedStaffUser } from '../auth';
import { PrismaClient } from '../generated/client/index.js';
import { issueMcpToken, resolveMcpToken } from '../mcp';
import { resetDatabase } from '../testing';
import { ApiKeyRejected, apiKeyLabels, issueApiKey, listApiKeys, resolveApiKey, revokeApiKey } from './keys';

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
  const staffA = await prisma.staffUser.create({ data: { businessId: ownerA.businessId, name: 'Priya', role: 'staff' }, select: { id: true } });
  const bizB = await prisma.business.create({ data: { name: 'Other Salon', timezone: 'America/Chicago' } });
  const ownerB = await seedStaffUser(prisma, { businessId: bizB.id, email: 'b@example.test', password: 'pw-owner-b-1234', name: 'Bea' });
  a = { businessId: ownerA.businessId, ownerId: ownerA.staffUserId, staffId: staffA.id };
  b = { businessId: bizB.id, ownerId: ownerB.staffUserId };
});

const issue = (scopes: string[] = ['read', 'write'], label = 'HubSpot sync') =>
  issueApiKey(prisma, { businessId: a.businessId, issuedById: a.ownerId, label, scopes, now: NOW });

describe('issueApiKey', () => {
  it('stores only the hash, and the key resolves to its business, label and scopes', async () => {
    const issued = await issue(['write', 'read', 'read']);
    expect(issued.key).toMatch(/^bk_api_[A-Za-z0-9_-]{43}$/);

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.keyHash).toBe(hashManageToken(issued.key));
    expect(JSON.stringify(row)).not.toContain(issued.key);
    // De-duplicated and in the canonical order.
    expect(row.scopes).toEqual(['read', 'write']);

    expect(await resolveApiKey(prisma, issued.key, LATER)).toEqual({
      keyId: issued.id,
      businessId: a.businessId,
      label: 'HubSpot sync',
      scopes: ['read', 'write'],
    });
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: issued.id } })).lastUsedAt).toEqual(LATER);
  });

  it('refuses a blank label, an unknown scope, no scopes, and a key that only widens', async () => {
    await expect(issue(['read'], '   ')).rejects.toBeInstanceOf(ApiKeyRejected);
    await expect(issue(['read', 'admin'])).rejects.toThrow(/Unknown scope: admin/);
    await expect(issue([])).rejects.toThrow(/at least one scope/);
    await expect(issue(['prices', 'contacts'])).rejects.toThrow(/read or write/);
    expect(await prisma.apiKey.count()).toBe(0);
  });

  it('only an active OWNER of this business may issue one (D-36)', async () => {
    const as = (issuedById: string) => issueApiKey(prisma, { businessId: a.businessId, issuedById, label: 'x', scopes: ['read'], now: NOW });
    await expect(as(a.staffId)).rejects.toThrow(/Only an owner/);
    await expect(as(b.ownerId)).rejects.toThrow(/Only an owner/);
    await prisma.staffUser.update({ where: { id: a.ownerId }, data: { active: false } });
    await expect(as(a.ownerId)).rejects.toThrow(/Only an owner/);
  });
});

describe('resolveApiKey', () => {
  it('is null for a malformed, an unknown, a revoked, and an MCP token', async () => {
    const issued = await issue();
    expect(await resolveApiKey(prisma, 'nope', LATER)).toBeNull();
    expect(await resolveApiKey(prisma, `bk_api_${'x'.repeat(43)}`, LATER)).toBeNull();
    const mcp = await issueMcpToken(prisma, { businessId: a.businessId, staffUserId: a.ownerId, issuedById: a.ownerId, label: 'l', now: NOW });
    expect(await resolveApiKey(prisma, mcp.token, LATER)).toBeNull();
    expect(await revokeApiKey(prisma, { businessId: a.businessId, id: issued.id, now: LATER })).toBe(true);
    expect(await resolveApiKey(prisma, issued.key, LATER)).toBeNull();
  });

  it('a key outlives the owner who issued it: deactivating a PERSON revokes nothing (§5)', async () => {
    const owner2 = await prisma.staffUser.create({ data: { businessId: a.businessId, name: 'Jo', role: 'owner' }, select: { id: true } });
    const issued = await issueApiKey(prisma, { businessId: a.businessId, issuedById: owner2.id, label: 'n8n', scopes: ['read'], now: NOW });
    await prisma.staffUser.update({ where: { id: owner2.id }, data: { active: false } });
    expect(await resolveApiKey(prisma, issued.key, LATER)).not.toBeNull();
  });
});

describe('revokeApiKey', () => {
  it('is scoped to the business, idempotent, and touches no other key and no MCP token', async () => {
    const one = await issue(['read'], 'one');
    const two = await issue(['read'], 'two');
    const mcp = await issueMcpToken(prisma, { businessId: a.businessId, staffUserId: a.ownerId, issuedById: a.ownerId, label: 'l', now: NOW });

    expect(await revokeApiKey(prisma, { businessId: b.businessId, id: one.id, now: LATER })).toBe(false);
    expect(await resolveApiKey(prisma, one.key, LATER)).not.toBeNull();

    expect(await revokeApiKey(prisma, { businessId: a.businessId, id: one.id, now: NOW })).toBe(true);
    expect(await revokeApiKey(prisma, { businessId: a.businessId, id: one.id, now: LATER })).toBe(true);
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: one.id } })).revokedAt).toEqual(NOW);

    expect(await resolveApiKey(prisma, two.key, LATER)).not.toBeNull();
    expect(await resolveMcpToken(prisma, mcp.token, LATER)).not.toBeNull();
    expect(await prisma.staffUser.count({ where: { businessId: a.businessId, active: true } })).toBe(2);
  });
});

describe('listApiKeys and apiKeyLabels', () => {
  it("lists this business's keys only, live first, with the issuer's name; labels resolve revoked keys too", async () => {
    const one = await issue(['read'], 'one');
    const two = await issue(['read', 'write', 'prices'], 'two');
    await issueApiKey(prisma, { businessId: b.businessId, issuedById: b.ownerId, label: 'theirs', scopes: ['read'], now: NOW });
    await revokeApiKey(prisma, { businessId: a.businessId, id: one.id, now: LATER });

    const rows = await listApiKeys(prisma, a.businessId);
    expect(rows.map((r) => [r.label, r.revokedAt !== null, r.issuedByName])).toEqual([
      ['two', false, 'Sam'],
      ['one', true, 'Sam'],
    ]);
    expect(rows[0]!.scopes).toEqual(['read', 'write', 'prices']);
    expect(await apiKeyLabels(prisma, [one.id, two.id, one.id])).toEqual(new Map([[one.id, 'one'], [two.id, 'two']]));
    expect(await apiKeyLabels(prisma, [])).toEqual(new Map());
  });
});
