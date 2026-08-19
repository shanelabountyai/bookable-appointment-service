/**
 * A-024 — RPT-02's frozen constant, against the real seed.
 *
 * "The AC asserts an exact seeded constant (e.g. 62.5%), not 'within 1% of
 * hand-calculated.'" Separate file from `dashboard.test.ts`'s synthetic,
 * per-test-reset behavior tests: this one needs the FULL density seed
 * (`seedDensity`, ~5-9s through the real write path) shared across its
 * handful of tests, same reasoning `density-seed.test.ts` gives for sharing
 * one seed rather than re-seeding per test.
 *
 * The number below is not hand-derived — nobody can hand-derive it (the seed
 * books greedily and a slot the engine offers can still be taken by the time
 * it is written, per `density-seed.ts`'s own comment). It was read off a
 * run of this exact seed, and the determinism test in `density-seed.test.ts`
 * ("produces identical data for the same seed") is what makes freezing it
 * here a running instant instead.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { seedSetup } from '../settings';
import { DEMO_WEEK, seedDensity } from '../settings/density-seed';
import { dashboardSummary } from './dashboard';

const prisma = new PrismaClient();
const SEED_TIMEOUT = 120_000;

let businessId: string;

beforeAll(async () => {
  await prisma.$connect();
  await resetDatabase(prisma);
  const setup = await seedSetup(prisma);
  businessId = setup.businessId;
  await seedDensity(prisma);
}, SEED_TIMEOUT);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the frozen utilization constant (RPT-02)', () => {
  it("Dana's DEMO_WEEK utilization is the exact seeded constant", async () => {
    const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: DEMO_WEEK[0] });
    const dana = summary.utilizationByProvider.find((p) => p.providerName === 'Dana');
    expect(dana).toBeDefined();
    expect(dana!.utilization).not.toBeNull();
    // FROZEN — computed from a run of this seed (confirmed identical across
    // two consecutive runs, same as `density-seed.test.ts`'s own determinism
    // guarantee), pinned here so a future change to the seed, the formula, or
    // the availability chain has to explain itself rather than silently
    // drift. 1290 occupied minutes / 2100 available minutes — Dana's Tue-Sat
    // 09:00-17:00-minus-break week, minus the two appointments transitioned
    // to `cancelled_late` above.
    expect(dana!.utilization).toBe(1290 / 2100);
  });

  it("the late-cancel tile finds Dana's two seeded offenders", async () => {
    const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: DEMO_WEEK[0] });
    expect(summary.cancels.late).toBeGreaterThanOrEqual(2);

    const late = await prisma.appointment.findMany({
      where: { businessId, status: 'cancelled_late', startDay: { in: [...DEMO_WEEK] } },
      select: { provider: { select: { displayName: true } } },
    });
    expect(late.length).toBeGreaterThanOrEqual(2);
    expect(late.every((a) => a.provider.displayName === 'Dana')).toBe(true);
  });
});
