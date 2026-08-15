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
    await seedStaffUser(prisma, { email: STAFF_EMAIL, password: STAFF_PASSWORD });
  } finally {
    await prisma.$disconnect();
  }
}
