/**
 * Per-test database reset for e2e — every spec file imports `test`/`expect`
 * from HERE, never directly from `@playwright/test`.
 *
 * WHY THIS EXISTS. There is no `globalSetup` — this file replaced it, and the
 * unregistered leftover was deleted after demo checkpoint 3 mis-diagnosed a
 * defect from its stale description. A once-per-invocation reset is not enough:
 * every spec shares one app instance
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
 *
 * A CONSEQUENCE WORTH STATING, because a checkpoint got it backwards. The
 * truncate below runs before every test's `beforeEach`, so a spec that calls
 * `seedSetup()` there is seeding an EMPTY database: e2e has always exercised
 * the FIRST run, not the second. Checkpoint 3's dormant-resource defect was
 * therefore present in this suite too, and survived because nothing asserted
 * a chair — not because anything here seeded twice. "Add the assertion" is
 * the lesson; "reset harder" is not.
 */
import { expect, test as base } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedStaffUser } from '@bookable/db/auth';
import { resetDatabase } from '@bookable/db/testing';

export const STAFF_EMAIL = 'owner@shear-genius.test';
export const STAFF_PASSWORD = 'e2e-staff-password';

/**
 * An AUTO FIXTURE, not `test.beforeEach()`.
 *
 * That distinction is the whole reason this file works. A bare
 * `test.beforeEach(...)` at module scope here registers the hook against
 * whichever spec file happens to import this module FIRST — Node caches the
 * module, so the registration statement never runs again and every other spec
 * file silently gets no reset at all. That failed exactly as you would expect
 * and no more obviously: each spec file passed when run alone, and the suite
 * failed as soon as two files ran together, with data leaking from one test
 * into the next inside whichever file lost the race.
 *
 * `auto: true` is per-test by construction: Playwright sets the fixture up
 * before every test that uses this `test` object, in every file, regardless of
 * import order.
 */
export const test = base.extend<{ freshDatabase: void }>({
  freshDatabase: [
    async ({}, use) => {
      const prisma = new PrismaClient();
      try {
        await resetDatabase(prisma);
        await seedStaffUser(prisma, { email: STAFF_EMAIL, password: STAFF_PASSWORD });
        // Known policy baseline, so a spec asserting "not 60" or "shorter than
        // the lead time" is meaningful and reproducible run over run.
        const business = await prisma.business.findFirstOrThrow();
        await prisma.business.update({
          where: { id: business.id },
          data: {
            minimumLeadMinutes: 120,
            cancellationCutoffMinutes: 120,
            bookingHorizonDays: 90,
            noShowBlockThreshold: 3,
          },
        });
      } finally {
        await prisma.$disconnect();
      }
      await use();
    },
    { auto: true },
  ],
});

export { expect };
