/**
 * W-006 — the one client insert desk, MCP and API share. The canonical phone
 * is the DATABASE's (D-55's trigger); this function owns trimming, the
 * empty-phone rule and the business scope, and decides no duplicates.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { ClientRejected, createClient } from './create';
import { findClientsByPhone } from './clients';

const prisma = new PrismaClient();
let businessId: string;

beforeAll(async () => prisma.$connect());
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await resetDatabase(prisma);
  businessId = (await prisma.business.create({ data: { name: 'Salon', timezone: 'America/Chicago' } })).id;
});

describe('createClient', () => {
  it('trims, stores the canonical phone through the trigger, and is found by any spelling of the number', async () => {
    const c = await createClient(prisma, { businessId, name: '  Rae Núñez ', phone: ' (312) 555-0199 ', email: ' rae@example.test ' });
    expect(c).toMatchObject({ name: 'Rae Núñez', phone: '+13125550199', email: 'rae@example.test' });
    expect((await findClientsByPhone(prisma, businessId, '312 555 0199')).map((x) => x.id)).toEqual([c.id]);
  });

  it('a blank phone or email is none, never an empty string; a blank name is refused naming the field', async () => {
    const c = await createClient(prisma, { businessId, name: 'Walk In', phone: '   ', email: '' });
    expect(c).toMatchObject({ phone: null, email: null });
    await expect(createClient(prisma, { businessId, name: '  ' })).rejects.toMatchObject({ name: 'ClientRejected', field: 'name' });
    await expect(createClient(prisma, { businessId, name: '' })).rejects.toBeInstanceOf(ClientRejected);
  });

  it('decides nothing about duplicates: a household shares a number (D-17)', async () => {
    await createClient(prisma, { businessId, name: 'Mother', phone: '3125550100' });
    await createClient(prisma, { businessId, name: 'Daughter', phone: '+1 312 555 0100' });
    expect(await findClientsByPhone(prisma, businessId, '3125550100')).toHaveLength(2);
  });
});
