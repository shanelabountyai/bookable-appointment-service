/**
 * Two businesses, each with an owner and a stylist, so every test can assert
 * tenancy rather than assume it (PRD §9.2). Salon A gets the setup seed (4
 * providers, 8 services); salon B is a second, sparser book whose ids are the
 * ones a token for A must never be able to name.
 */
import type { PrismaClient } from '@bookable/db';
import { seedStaffUser } from '@bookable/db/auth';
import { seedSetup } from '@bookable/db/settings';

export interface Salon {
  businessId: string;
  ownerId: string;
  staffId: string;
  serviceIds: string[];
  providerIds: string[];
}

export async function seedTwoSalons(prisma: PrismaClient): Promise<{ a: Salon; b: Salon }> {
  const ownerA = await seedStaffUser(prisma, { email: 'a@example.test', password: 'pw-owner-a-1234', name: 'Sam' });
  const setupA = await seedSetup(prisma);
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
  const staffB = await prisma.staffUser.create({
    data: { businessId: bizB.id, name: 'Omar', role: 'staff' },
    select: { id: true },
  });
  const providerB = await prisma.provider.create({ data: { businessId: bizB.id, displayName: 'Omar' }, select: { id: true } });
  const serviceB = await prisma.service.create({
    data: { businessId: bizB.id, name: 'Trim', durationMinutes: 30, priceCents: 2000 },
    select: { id: true },
  });

  return {
    a: {
      businessId: ownerA.businessId,
      ownerId: ownerA.staffUserId,
      staffId: staffA.id,
      serviceIds: setupA.serviceIds,
      providerIds: setupA.providerIds,
    },
    b: {
      businessId: bizB.id,
      ownerId: ownerB.staffUserId,
      staffId: staffB.id,
      serviceIds: [serviceB.id],
      providerIds: [providerB.id],
    },
  };
}
