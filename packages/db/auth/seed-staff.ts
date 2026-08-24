/**
 * Creates (or resets) the single staff credential (D-9).
 *
 * Used by the e2e setup today and by A-025's owner setup later. It is NOT the
 * §9 seed script — that is A-011, and it seeds appointments.
 *
 * REFUSES TO RUN IN PRODUCTION. A known-value demo credential is fine in dev
 * and test precisely because this guard exists; without it, this file is a
 * back door with a published password.
 */
import { hashPassword } from '../../core/auth';
import type { PrismaClient } from '../generated/client/index.js';

export interface SeedStaffInput {
  businessId?: string;
  businessName?: string;
  timezone?: string;
  email: string;
  password: string;
  /** A-037: what the event log calls this account. Defaults to the name the
   *  one shared credential effectively had before names existed. */
  name?: string;
}

export async function seedStaffUser(
  prisma: PrismaClient,
  input: SeedStaffInput,
): Promise<{ staffUserId: string; businessId: string }> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seedStaffUser refuses to run with NODE_ENV=production.');
  }

  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);

  const business =
    (input.businessId
      ? await prisma.business.findUnique({ where: { id: input.businessId } })
      : await prisma.business.findFirst()) ??
    (await prisma.business.create({
      data: {
        name: input.businessName ?? 'Shear Genius',
        timezone: input.timezone ?? 'America/Chicago',
      },
    }));

  const name = input.name?.trim() || 'Front desk';
  // A-050 — THE OWNER. This is the account the salon signs in with, and the
  // migration's backfill says the same thing about every row that already had
  // a password: seeding a `staff` here would leave a fresh install with a
  // dashboard nobody can open and no screen that could grant the role.
  const staff = await prisma.staffUser.upsert({
    where: { businessId_email: { businessId: business.id, email } },
    create: { businessId: business.id, email, passwordHash, name, role: 'owner' },
    update: { passwordHash, name, role: 'owner' },
    select: { id: true },
  });

  return { staffUserId: staff.id, businessId: business.id };
}
