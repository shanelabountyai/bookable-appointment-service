/**
 * Two businesses, each with an owner and a stylist, so every test can assert
 * tenancy rather than assume it (PRD §9.2). Salon A gets the setup seed (4
 * providers, 8 services); salon B is a second, sparser book whose ids are the
 * ones a token for A must never be able to name.
 */
import { staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import type { PrismaClient } from '@bookable/db';
import { seedStaffUser } from '@bookable/db/auth';
import { bookAppointment } from '@bookable/db/booking';
import { seedSetup } from '@bookable/db/settings';
import { createProposal } from '@bookable/db/mcp';
import { createWaitlistEntry } from '@bookable/db/waitlist';

export interface Salon {
  businessId: string;
  ownerId: string;
  staffId: string;
  serviceIds: string[];
  providerIds: string[];
  /** One booked appointment, Thu 2026-06-11 09:00 local (a day no availability test touches), so id-taking tools have something to be refused on. */
  appointmentId: string;
  /** One client ("Alex …"), on the waitlist for the week after, for the same reason. */
  clientId: string;
  /** One unused proposal by the owner, so commit_proposal has a foreign id to be refused on. */
  proposalId: string;
}

const WED_0900 = toDate(instantFromIso('2026-06-11T14:00:00Z'));
const SEED_NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));

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
  await prisma.serviceProvider.create({ data: { businessId: bizB.id, serviceId: serviceB.id, providerId: providerB.id } });
  for (const weekday of [2, 3, 4, 5, 6]) {
    await prisma.weeklyWindow.create({ data: { businessId: bizB.id, providerId: null, weekday, open: '09:00', close: '17:00', endsNextDay: false } });
    await prisma.weeklyWindow.create({ data: { businessId: bizB.id, providerId: providerB.id, weekday, open: '09:00', close: '17:00', endsNextDay: false } });
  }

  const book = (businessId: string, providerId: string, serviceId: string, actor: string) =>
    bookAppointment(prisma, { businessId, providerId, serviceIds: [serviceId], startAt: WED_0900, now: SEED_NOW, actor: staffActor(actor), audience: 'staff' });
  const apptA = await book(ownerA.businessId, setupA.providerIds[0]!, setupA.serviceIds[0]!, ownerA.staffUserId);
  const apptB = await book(bizB.id, providerB.id, serviceB.id, ownerB.staffUserId);

  const clientA = await prisma.client.create({ data: { businessId: ownerA.businessId, name: 'Alex Stone', phone: '+13125550100' }, select: { id: true } });
  const clientB = await prisma.client.create({ data: { businessId: bizB.id, name: 'Alex Baker', phone: '+17735550100' }, select: { id: true } });
  const wait = (businessId: string, clientId: string, serviceId: string) =>
    createWaitlistEntry(prisma, { businessId, clientId, serviceIds: [serviceId], providerIds: [], fromDay: '2026-06-15', toDay: '2026-06-19', dayParts: [] });
  await wait(ownerA.businessId, clientA.id, setupA.serviceIds[0]!);
  await wait(bizB.id, clientB.id, serviceB.id);

  const propose = (businessId: string, staffUserId: string) =>
    createProposal(prisma, { businessId, staffUserId, tokenId: 'seed', action: 'prepare_new_client', args: { name: 'Seed', phone: '+13125550199' }, summary: 'Add client Seed.', now: SEED_NOW });
  const propA = await propose(ownerA.businessId, ownerA.staffUserId);
  const propB = await propose(bizB.id, ownerB.staffUserId);

  return {
    a: {
      businessId: ownerA.businessId,
      ownerId: ownerA.staffUserId,
      staffId: staffA.id,
      serviceIds: setupA.serviceIds,
      providerIds: setupA.providerIds,
      appointmentId: apptA.id,
      clientId: clientA.id,
      proposalId: propA.id,
    },
    b: {
      businessId: bizB.id,
      ownerId: ownerB.staffUserId,
      staffId: staffB.id,
      serviceIds: [serviceB.id],
      providerIds: [providerB.id],
      appointmentId: apptB.id,
      clientId: clientB.id,
      proposalId: propB.id,
    },
  };
}
