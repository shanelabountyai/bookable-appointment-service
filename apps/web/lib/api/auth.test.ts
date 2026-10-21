/**
 * W-001 — bearer resolution: the key, and only the key, says which business.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { issueApiKey, revokeApiKey } from '@bookable/db/api';
import { seedStaffUser } from '@bookable/db/auth';
import { issueMcpToken } from '@bookable/db/mcp';
import { resetDatabase } from '@bookable/db/testing';
import { bearerOf, resolveCaller } from './auth';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const req = (authorization?: string) => new Request('http://localhost/api/v1/services', { headers: authorization ? { authorization } : {} });

let businessId: string;
let ownerId: string;

beforeAll(async () => prisma.$connect());
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await resetDatabase(prisma);
  const owner = await seedStaffUser(prisma, { email: 'a@example.test', password: 'pw-owner-a-1234', name: 'Sam' });
  businessId = owner.businessId;
  ownerId = owner.staffUserId;
});

describe('bearerOf', () => {
  it('reads "Bearer <key>" case-insensitively and nothing else', () => {
    expect(bearerOf(req('Bearer bk_api_x'))).toBe('bk_api_x');
    expect(bearerOf(req('bearer   bk_api_x'))).toBe('bk_api_x');
    expect(bearerOf(req('Basic abc'))).toBeNull();
    expect(bearerOf(req('Bearer'))).toBeNull();
    expect(bearerOf(req('Bearer a b'))).toBeNull();
    expect(bearerOf(req())).toBeNull();
  });
});

describe('resolveCaller', () => {
  it("returns the key's business, scopes and the business's zone", async () => {
    const { key, id } = await issueApiKey(prisma, { businessId, issuedById: ownerId, label: 'HubSpot sync', scopes: ['read'], now: NOW });
    expect(await resolveCaller(prisma, req(`Bearer ${key}`), NOW)).toEqual({
      keyId: id,
      businessId,
      label: 'HubSpot sync',
      scopes: ['read'],
      timezone: 'America/Chicago',
    });
  });

  it('is null with no header, an MCP token, an unknown key, and a revoked key', async () => {
    const { key, id } = await issueApiKey(prisma, { businessId, issuedById: ownerId, label: 'x', scopes: ['read'], now: NOW });
    const mcp = await issueMcpToken(prisma, { businessId, staffUserId: ownerId, issuedById: ownerId, label: 'l', now: NOW });
    expect(await resolveCaller(prisma, req(), NOW)).toBeNull();
    expect(await resolveCaller(prisma, req(`Bearer ${mcp.token}`), NOW)).toBeNull();
    expect(await resolveCaller(prisma, req(`Bearer bk_api_${'A'.repeat(43)}`), NOW)).toBeNull();
    await revokeApiKey(prisma, { businessId, id, now: NOW });
    expect(await resolveCaller(prisma, req(`Bearer ${key}`), NOW)).toBeNull();
  });
});
