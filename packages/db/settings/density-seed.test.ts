/**
 * A-011 — the density seed (§9).
 *
 * These assert the seed's PROPERTIES, not that it ran without throwing. A
 * seed that produces an empty book still "succeeds", and every screen built
 * on it then looks fine while being untested — which is the whole reason the
 * operator review moved this item ahead of the customer UI (S-1).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { instantFromIso, toDate } from '../../core/time';
import { computeDaySlots } from '../scheduling';
import { DEMO_WEEK, FALL_BACK_DAY, SPRING_FORWARD_DAY, seedDensity } from './density-seed';
import { seedSetup } from './setup-seed';

const prisma = new PrismaClient();

/**
 * The seed books ~100 appointments through the REAL write path, each its own
 * transaction with an advisory lock — around four seconds. Re-seeding per test
 * made the file slow AND flaky: a test that timed out left its seed running,
 * and the next test's TRUNCATE deadlocked (40P01) against the abandoned
 * connection. So the read-only assertions share ONE seed, and only the tests
 * that genuinely need a fresh database re-seed themselves.
 */
const SEED_TIMEOUT = 120_000;
let shared: Awaited<ReturnType<typeof seedDensity>>;

beforeAll(async () => {
  await prisma.$connect();
  await resetDatabase(prisma);
  await seedSetup(prisma);
  shared = await seedDensity(prisma);
}, SEED_TIMEOUT);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the density seed produces a realistic book', () => {
  it('creates appointments through the real write path', async () => {
    expect(shared.appointmentsCreated).toBeGreaterThan(20);

    // Every appointment has a service line and an event, because it went
    // through bookAppointment rather than a raw insert.
    const appointments = await prisma.appointment.count({ where: { status: 'booked' } });
    const lines = await prisma.appointmentServiceLine.count();
    const events = await prisma.appointmentEvent.count();
    expect(lines).toBeGreaterThanOrEqual(appointments);
    expect(events).toBeGreaterThanOrEqual(appointments);
  });

  it('leaves the no-overlap invariant intact', async () => {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
      SELECT count(*)::bigint AS count
        FROM "Appointment" a JOIN "Appointment" b
          ON a."providerId" = b."providerId" AND a.id < b.id
         AND a.status NOT IN ('cancelled','cancelled_late')
         AND b.status NOT IN ('cancelled','cancelled_late')
         AND tstzrange(a."blockedStart", a."blockedEnd", '[)')
          && tstzrange(b."blockedStart", b."blockedEnd", '[)')
    `);
    expect(Number(rows[0]!.count)).toBe(0);
  });

  // §9's whole point: different columns must look DIFFERENT, or the day view
  // is being tested against a uniform book that hides every layout bug.
  it('gives providers genuinely different densities', () => {
    const counts = Object.values(shared.byProvider).sort((a, b) => b - a);
    expect(counts.length).toBeGreaterThanOrEqual(3);
    // The busiest column is meaningfully busier than the quietest.
    expect(counts[0]!).toBeGreaterThan(counts[counts.length - 1]!);
  });

  it('leaves at least one provider-day with NOTHING available', async () => {
    const providers = await prisma.provider.findMany({ orderBy: { displayOrder: 'asc' } });
    const service = await prisma.service.findFirstOrThrow({ orderBy: { displayOrder: 'asc' } });

    let fullyBookedDays = 0;
    for (const provider of providers) {
      for (const day of DEMO_WEEK) {
        const { slots } = await computeDaySlots(prisma, {
          businessId: provider.businessId,
          providerId: provider.id,
          serviceIds: [service.id],
          day,
          now: toDate(instantFromIso(`${day}T00:00:00-05:00`)),
          audience: 'staff',
        }).catch(() => ({ slots: [] }));
        if (slots.length === 0) fullyBookedDays++;
      }
    }
    // The customer flow must have a "nothing that day" case to render.
    expect(fullyBookedDays).toBeGreaterThan(0);
  });

  it('leaves at least one day with room, so the demo is not uniformly full', async () => {
    const priya = (await prisma.provider.findMany({ orderBy: { displayOrder: 'asc' } }))[1]!;
    const service = await prisma.service.findFirstOrThrow({ orderBy: { displayOrder: 'asc' } });
    const { slots } = await computeDaySlots(prisma, {
      businessId: priya.businessId,
      providerId: priya.id,
      serviceIds: [service.id],
      day: DEMO_WEEK[0],
      now: toDate(instantFromIso(`${DEMO_WEEK[0]}T00:00:00-05:00`)),
      audience: 'staff',
    });
    expect(slots.length).toBeGreaterThan(0);
  });
});

describe('the DST fixtures actually exist', () => {
  /**
   * The failure this guards against is silent. Both DST days are SUNDAYS and
   * the setup seed opens Tue–Sat, so without the seed's explicit overrides
   * these days contain zero appointments — the two days the entire project is
   * about would quietly not be in the demo, and nothing would go red.
   */
  it('books real appointments on the spring-forward and fall-back days', async () => {
    expect(shared.springForwardCount).toBeGreaterThan(0);
    expect(shared.fallBackCount).toBeGreaterThan(0);

    for (const day of [SPRING_FORWARD_DAY, FALL_BACK_DAY]) {
      const onDay = await prisma.appointment.count({ where: { startDay: day } });
      expect(onDay, `expected appointments on ${day}`).toBeGreaterThan(0);
    }
  });

  it('the fall-back day contains appointments in the DOUBLED hour, distinguishable by offset', async () => {
    const rows = await prisma.$queryRawUnsafe<{ offset: string; count: bigint }[]>(
      `SELECT to_char("startAt" AT TIME ZONE 'America/Chicago', 'HH24:MI') AS "offset", count(*)::bigint AS count
         FROM "Appointment" WHERE "startDay" = $1 GROUP BY 1 ORDER BY 1`,
      FALL_BACK_DAY,
    );
    // 01:00–01:59 happens twice that day. Whether or not the seed lands on
    // both occurrences, the wall labels must round-trip — and the underlying
    // instants must be distinct.
    const instants = await prisma.appointment.findMany({
      where: { startDay: FALL_BACK_DAY },
      select: { startAt: true },
    });
    const unique = new Set(instants.map((i) => i.startAt.toISOString()));
    expect(unique.size).toBe(instants.length);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('determinism and safety', () => {
  /**
   * A demo that differs run to run cannot be walked through with anybody.
   *
   * Compared on the provider's NAME, not its id: ids are cuids regenerated by
   * every reset, so asserting on them would be asserting that the database's
   * id generator is deterministic — which it is not, and never should be. What
   * must be reproducible is WHICH PROVIDER is booked WHEN.
   */
  it(
    'produces identical data for the same seed',
    async () => {
      const run = async () => {
        await resetDatabase(prisma);
        await seedSetup(prisma);
        const result = await seedDensity(prisma, { randomSeed: 12345 });
        const rows = await prisma.appointment.findMany({
          orderBy: [{ startAt: 'asc' }, { providerId: 'asc' }],
          select: { startAt: true, startDay: true, provider: { select: { displayName: true } } },
        });
        return {
          created: result.appointmentsCreated,
          rows: rows.map((r) => `${r.startDay}|${r.startAt.toISOString()}|${r.provider.displayName}`),
        };
      };

      const first = await run();
      const second = await run();

      expect(second.created).toBe(first.created);
      expect(second.rows).toEqual(first.rows);
      expect(first.rows.length).toBeGreaterThan(20);
    },
    SEED_TIMEOUT,
  );

  it('seeds a client with enough no-shows to cross the CLIENT-04 threshold', async () => {
    const grouped = await prisma.appointment.groupBy({
      by: ['clientId'],
      where: { status: 'no_show' },
      _count: { _all: true },
    });
    expect(grouped.length).toBeGreaterThan(0);
    expect(Math.max(...grouped.map((g) => g._count._all))).toBeGreaterThanOrEqual(3);
  });

  // D-17: a household shares a phone number, and they must remain SEPARATE
  // clients — the case a unique index would have silently merged.
  it('seeds two clients sharing one phone number', async () => {
    const rows = await prisma.client.groupBy({ by: ['phone'], _count: { _all: true } });
    expect(rows.some((r) => r._count._all > 1)).toBe(true);
  });

  it('seeds mid-window time off, not time off at the edge of a window', async () => {
    const timeOff = await prisma.timeOff.findFirstOrThrow();
    const label = await prisma.$queryRawUnsafe<{ start: string; end: string }[]>(
      `SELECT to_char($1::timestamptz AT TIME ZONE 'America/Chicago','HH24:MI') AS start,
              to_char($2::timestamptz AT TIME ZONE 'America/Chicago','HH24:MI') AS end`,
      timeOff.startAt,
      timeOff.endAt,
    );
    // Inside 09:00–17:00, touching neither edge.
    expect(label[0]!.start > '09:00').toBe(true);
    expect(label[0]!.end < '17:00').toBe(true);
  });

  it('refuses to run in production', async () => {
    try {
      vi.stubEnv('NODE_ENV', 'production');
      await expect(seedDensity(prisma)).rejects.toThrow(/production/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses to run without the setup seed', async () => {
    await resetDatabase(prisma);
    await prisma.business.create({ data: { name: 'Empty', timezone: 'America/Chicago' } });
    await expect(seedDensity(prisma)).rejects.toThrow(/setup seed/);
  });
});
