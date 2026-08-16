/**
 * Seeds the one staff credential the auth specs log in with.
 *
 * Runs against the TEST database (`.env.test` first-wins, same as everything
 * else) before any spec. The credential is a known value on purpose — it is
 * safe because `seedStaffUser` refuses to run with NODE_ENV=production.
 */
import { PrismaClient } from '@bookable/db';
import { seedStaffUser } from '@bookable/db/auth';

export const STAFF_EMAIL = 'owner@shear-genius.test';
export const STAFF_PASSWORD = 'e2e-staff-password';

export default async function globalSetup(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // Reset the roster and policy so the specs are repeatable — A-025's specs
    // add providers and change settings, and a second run must start from the
    // same place as the first. Appointments are untouched (there are none
    // until A-009); the staff credential is upserted, not recreated.
    await prisma.serviceProvider.deleteMany();
    await prisma.windowBreak.deleteMany();
    await prisma.weeklyWindow.deleteMany();
    await prisma.dateOverride.deleteMany();
    await prisma.service.deleteMany();
    await prisma.provider.deleteMany();

    await seedStaffUser(prisma, { email: STAFF_EMAIL, password: STAFF_PASSWORD });

    // Known policy baseline, so a spec asserting "not 60" is meaningful.
    const business = await prisma.business.findFirstOrThrow();
    await prisma.business.update({
      where: { id: business.id },
      data: { minimumLeadMinutes: 120, cancellationCutoffMinutes: 120, bookingHorizonDays: 90, noShowBlockThreshold: 3 },
    });
  } finally {
    await prisma.$disconnect();
  }
}
