/**
 * Per-test database reset for e2e — every spec file imports `test`/`expect`
 * from HERE, never directly from `@playwright/test`.
 *
 * WHY THIS EXISTS. `globalSetup` resets the database once per `npm run
 * test:e2e` invocation, not once per test. Every spec shares one app instance
 * and one Postgres test database (CLAUDE.md), and the provider roster and
 * service catalog are genuinely global rows — there is no per-test tenant.
 * Two specs that each independently add a provider named "Dana" (the obvious
 * example name) therefore collide the moment BOTH have run once in the same
 * suite invocation: the second one finds a provider list with two Danas in
 * it. That happened for real (A-006's qualify spec and A-025's provider spec
 * both use "Dana"), and it will keep happening as more specs are added unless
 * every test starts from a known-empty state — the identical reasoning behind
 * every `beforeEach(resetDatabase(...))` already used across this repo's
 * vitest DB tests (packages/db/**\/*.test.ts). This file is that same pattern
 * for Playwright.
 */
import { expect, test as base } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedStaffUser } from '@bookable/db/auth';
import { resetDatabase } from '@bookable/db/testing';

export const STAFF_EMAIL = 'owner@shear-genius.test';
export const STAFF_PASSWORD = 'e2e-staff-password';

export const test = base;

test.beforeEach(async () => {
  const prisma = new PrismaClient();
  try {
    await resetDatabase(prisma);
    await seedStaffUser(prisma, { email: STAFF_EMAIL, password: STAFF_PASSWORD });
    // Known policy baseline, so a spec asserting "not 60" or "shorter than
    // the lead time" is meaningful and reproducible run over run.
    const business = await prisma.business.findFirstOrThrow();
    await prisma.business.update({
      where: { id: business.id },
      data: { minimumLeadMinutes: 120, cancellationCutoffMinutes: 120, bookingHorizonDays: 90, noShowBlockThreshold: 3 },
    });
  } finally {
    await prisma.$disconnect();
  }
});

export { expect };
