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
import { addDays, calendarDay, daysBetween, fromDate, instantFromIso, toDate, toLabel, zoneId } from '../../core/time';
import { computeDaySlots } from '../scheduling';
import { countUnfinished, listOpenedSlots, listUnconfirmedTomorrow, listUnfinished } from '../appointments';
import { listLapsedClients } from '../reports';
import { listWaitlistEntries, matchFreedSlot } from '../waitlist';
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

/**
 * A-081 — the seed's `now`, FROZEN, for the same reason every engine test
 * freezes one. Half of what `seedDensity` produces is anchored to it, so a test
 * reading the real clock would assert against a book that is a different shape
 * every day it runs — and, twice a year, a different shape on the same day.
 *
 * A Wednesday afternoon: `today` is a day the salon opens, and 15:30 leaves
 * real past rows behind it and real future rows ahead of it, which is what the
 * unfinished list and the opened-up list respectively need to be non-empty.
 * Deliberately twelve weeks past `SEED_ANCHOR_DAY` — that gap IS the defect.
 */
const SEED_NOW = toDate(instantFromIso('2026-09-02T15:30:00-05:00'));
/** A-110 — the seed's own day, which is what a waitlist entry expires against. */
const seedToday = (timezone: string) => toLabel(fromDate(SEED_NOW), zoneId(timezone)).day;

beforeAll(async () => {
  await prisma.$connect();
  await resetDatabase(prisma);
  await seedSetup(prisma);
  shared = await seedDensity(prisma, { now: SEED_NOW });
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
        const result = await seedDensity(prisma, { randomSeed: 12345, now: SEED_NOW });
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

  /**
   * A-081 — THE ASSERTIONS THAT WOULD HAVE CAUGHT THE DARK DEMO.
   *
   * Every one of these passed vacuously before this item, because the surfaces
   * they name were all built AFTER the fixed book they read from, and none of
   * them had a test that ran against the seed at all. Measured on the real
   * thing twelve weeks after `SEED_ANCHOR_DAY`: `unfinished 0, opened up 0, on
   * today's book 0` against 227 seeded appointments and 176 rows past and still
   * open. Counting appointments cannot see this — the book was full, it was
   * simply full in June.
   *
   * So these assert what the SCREENS say, not what the tables hold. The e2e
   * suite structurally cannot: `e2e/fixtures.ts` TRUNCATEs and seeds its own
   * rows before every spec, so a feature dormant on a fresh install is dormant
   * in e2e too (CLAUDE.md).
   */
  describe('A-081 — the moving book', () => {
    it('leaves rows on today\'s book', async () => {
      const business = await prisma.business.findFirstOrThrow();
      const today = toLabel(fromDate(SEED_NOW), zoneId(business.timezone)).day;
      const onToday = await prisma.appointment.count({
        where: { businessId: business.id, startDay: today },
      });
      expect(onToday).toBeGreaterThan(0);
    });

    it('leaves past appointments nobody closed, for /staff/unfinished', async () => {
      const business = await prisma.business.findFirstOrThrow();
      const count = await countUnfinished(prisma, { businessId: business.id, now: SEED_NOW });
      expect(count).toBeGreaterThan(0);
      expect(shared.leftUnfinished).toBeGreaterThan(0);

      // UNEVENLY, which is the fixture. A-076's screen is worth building only
      // because "she was seen to arrive" and "she never checked in" are
      // different answers and the desk has to say which — a seed that left
      // every open row on the same status demonstrates neither.
      const rows = await listUnfinished(prisma, { businessId: business.id, now: SEED_NOW });
      expect(new Set(rows.map((row) => row.status)).size).toBeGreaterThan(1);
    });

    it('leaves future time that has just been freed, for /staff/opened', async () => {
      const business = await prisma.business.findFirstOrThrow();
      const opened = await listOpenedSlots(prisma, { businessId: business.id, now: SEED_NOW });
      expect(opened.length).toBeGreaterThan(0);
    });

    it('cuts a no-show\'s range rather than freeing it (A-069)', async () => {
      const released = await prisma.appointment.findFirst({
        where: { status: 'no_show', releasedAt: { not: null } },
        select: { startAt: true, endAt: true, releasedAt: true, blockedEnd: true },
      });
      expect(released).not.toBeNull();
      // The CUT, which is the whole mechanism: the chair is let go of at
      // `releasedAt`, not at `endAt`, and the trigger — not the seed — is what
      // wrote that.
      expect(released!.blockedEnd.toISOString()).toBe(released!.releasedAt!.toISOString());
      expect(released!.releasedAt!.getTime()).toBeGreaterThan(released!.startAt.getTime());
      expect(released!.releasedAt!.getTime()).toBeLessThan(released!.endAt.getTime());
    });

    /**
     * THE TWO BOOKS DO NOT TOUCH. The moving window is nineteen days wide and
     * `SEED_ANCHOR_DAY` is a constant, so nothing stops them colliding on some
     * future September — and a collision is not a crash, it is A-024's exact
     * utilization constant quietly measuring extra appointments. The margin is
     * ±3 days because that assertion is over DEMO_WEEK's whole ISO WEEK, not
     * over its five open days.
     */
    it('never lands on the fixed fixtures', () => {
      for (const fixed of [...DEMO_WEEK, SPRING_FORWARD_DAY, FALL_BACK_DAY]) {
        for (const day of shared.recentDays) {
          expect(Math.abs(daysBetween(calendarDay(day), calendarDay(fixed)))).toBeGreaterThan(3);
        }
      }
      // And it did not skip everything: a window that reserved its way to
      // nothing would make every assertion above pass on an empty set.
      expect(shared.recentDays.length).toBeGreaterThan(10);
    });
  });

  /**
   * A-095 — THE DARK CORNERS CHECKPOINT 7 COULD NOT WALK.
   *
   * A-081's assertions above are the same idea one layer up: they caught
   * SCREENS rendering their empty state on a full book. These catch a screen
   * that is full of appointments and still empty of the thing it is FOR.
   *
   * Every number quoted here was measured on the seed as it stood before this
   * item, at this same frozen `now`.
   */
  describe('A-095 — the dark corners', () => {
    /**
     * MEASURED BY THE MINIMUM ACROSS PROVIDERS, never by a total or by "some
     * provider has some". The book held 411 appointments and Marcus and Tess
     * had ZERO between them from today onwards — a sum, an average and an
     * any-provider assertion all pass on that book, and two of four columns
     * are blank on every screen anybody demos.
     */
    it('gives every provider a future column, not just two', async () => {
      const business = await prisma.business.findFirstOrThrow();
      const providers = await prisma.provider.findMany({
        where: { businessId: business.id, active: true },
        orderBy: { displayOrder: 'asc' },
      });
      const futureCounts = await Promise.all(
        providers.map((provider) =>
          prisma.appointment.count({
            where: {
              businessId: business.id,
              providerId: provider.id,
              startAt: { gt: SEED_NOW },
              status: { notIn: ['cancelled', 'cancelled_late'] },
            },
          }),
        ),
      );
      const empty = providers.filter((_, index) => futureCounts[index] === 0).map((p) => p.displayName);
      expect(empty, 'every stylist needs a future column').toEqual([]);
      expect(Math.min(...futureCounts)).toBeGreaterThan(0);
    });

    /**
     * THE ROOM AXIS HAS TO BIND SOMEWHERE, or checkpoint 6's entire finding is
     * unreachable on the demo book.
     *
     * With only two of four columns filled, the number of chairs in use never
     * exceeded the number of stylists working: peak 2 concurrent holds against
     * 4 chairs, and this exact sweep returned 2,937 offers and NOT ONE
     * `no-resource-free`. A read model that predicts the chair chooser's
     * answer cannot be demonstrated — or caught being wrong — on a room that
     * never fills.
     *
     * Asserted on the REASON, not on a count of offers: an absence assertion
     * here passes for a dozen wrong reasons, including a sweep that threw.
     */
    it('fills the room hard enough that the chair axis actually refuses', async () => {
      const business = await prisma.business.findFirstOrThrow();
      const zone = zoneId(business.timezone);
      const today = toLabel(fromDate(SEED_NOW), zone).day;
      const providers = await prisma.provider.findMany({
        where: { businessId: business.id, active: true },
        orderBy: { displayOrder: 'asc' },
      });
      // The SHORT services are where this shows up, and that is the operator's
      // case rather than an artefact: a ten-minute fringe trim fits in the
      // stylist's gap and there is no chair to put her in. "She is free, the
      // room is not."
      const services = await prisma.service.findMany({
        where: { businessId: business.id, active: true, durationMinutes: { lte: 45 } },
        orderBy: { displayOrder: 'asc' },
      });

      const roomRefusals: string[] = [];
      for (let offset = 0; offset <= 9; offset += 1) {
        const day = addDays(calendarDay(today), offset);
        for (const provider of providers) {
          for (const service of services) {
            const result = await computeDaySlots(prisma, {
              businessId: business.id,
              providerId: provider.id,
              serviceIds: [service.id],
              day,
              now: SEED_NOW,
              audience: 'staff',
            }).catch(() => null);
            if (!result) continue;
            for (const exclusion of result.excluded) {
              if (exclusion.reasons.includes('no-resource-free')) {
                roomRefusals.push(`${day} ${provider.displayName} ${service.name} @${exclusion.label}`);
              }
            }
          }
        }
      }
      expect(roomRefusals.length, 'the four chairs must bind somewhere in the future book').toBeGreaterThan(0);
    }, SEED_TIMEOUT);

    /**
     * WHAT THE SCREEN SAYS, not what the table holds — and the distinction is
     * the whole of this test rather than a flourish.
     *
     * `matchFreedSlot` is a conjunction of five conditions, and an entry that
     * fails any of them leaves `/staff/opened` → "Who wants this slot?"
     * rendering *"Nobody on the waitlist fits this one"* — WHICH IS EXACTLY
     * WHAT IT RENDERED WITH NO ENTRIES AT ALL. `waitlistEntry.count() > 0`
     * passes against that. The first version of this seed's entry was built
     * from A-069's RELEASED TAIL, whose 25 freed minutes cannot hold the
     * 150-minute colour its `primaryServiceId` names; it counted 1 and matched
     * nobody.
     */
    it('puts a name against a slot that actually opened up', async () => {
      const business = await prisma.business.findFirstOrThrow();
      const zone = zoneId(business.timezone);
      expect(shared.waitlistEntries).toBeGreaterThan(0);

      const entries = await listWaitlistEntries(prisma, { businessId: business.id, today: seedToday(business.timezone) });
      // A-110 — and every seeded entry's window is still open at `SEED_NOW`.
      // A demo book whose standing queue had lapsed rows on it would now be
      // SHORT here rather than merely stale, which is the point of the count.
      expect(entries.length).toBe(shared.waitlistEntries);

      const opened = await listOpenedSlots(prisma, { businessId: business.id, now: SEED_NOW });
      const matched = new Map<string, string[]>();
      for (const slot of opened) {
        if (!slot.primaryServiceId) continue;
        const label = toLabel(fromDate(slot.startAt), zone);
        const who = await matchFreedSlot(prisma, {
          businessId: business.id,
          providerId: slot.providerId,
          serviceId: slot.primaryServiceId,
          day: label.day,
          time: label.time,
          freedMinutes: slot.freedMinutes,
        });
        if (who.length > 0) matched.set(slot.key, who.map((entry) => entry.clientName ?? '(no name)'));
      }
      expect([...matched.values()].flat().length, 'a freed slot with nobody against it is the empty state again').toBeGreaterThan(0);
    });

    /**
     * A-023/WAIT-03/04 — the list must be FILTERED, not merely listed. One
     * entry that matches everything demonstrates a list; the narrower ones are
     * what show the desk that "Saturday mornings, Dana only" is a real
     * constraint the screen applies.
     */
    it('seeds narrower entries too, so the filters have something to exclude', async () => {
      const business = await prisma.business.findFirstOrThrow();
      const entries = await listWaitlistEntries(prisma, { businessId: business.id, today: seedToday(business.timezone) });
      expect(entries.some((entry) => entry.dayParts.length > 0)).toBe(true);
      expect(entries.some((entry) => entry.providerIds.length > 0)).toBe(true);
      expect(entries.some((entry) => entry.dayParts.length === 0 && entry.providerIds.length === 0)).toBe(true);
    });

    /**
     * BOTH SUBJECTS. `ClientCallMark` serves two screens through one table
     * (A-073), and a fixture that only ever writes one of them leaves the
     * other exactly as dark as it was.
     */
    it('records call marks against both of the subjects that exist', async () => {
      const subjects = await prisma.clientCallMark.findMany({ select: { subject: true } });
      expect(shared.callMarks).toBe(subjects.length);
      expect(subjects.some((row) => row.subject.startsWith('freed:'))).toBe(true);
      expect(subjects.some((row) => row.subject === 'lapsed')).toBe(true);
    });

    /**
     * A-092's screen, which had never carried a row. Every one of the eight
     * demo clients is booked somewhere in the moving window, and "nothing
     * booked ahead of her" is half the report's definition — so the seed could
     * not produce a lapsed client by accident however many appointments it
     * wrote. Measured: 0 lapsed on a book of 713.
     */
    it('leaves clients who have not been in, for the lapsed report', async () => {
      const business = await prisma.business.findFirstOrThrow();
      expect(shared.lapsedClients).toBeGreaterThan(0);
      const rows = await listLapsedClients(prisma, { businessId: business.id, now: SEED_NOW });
      expect(rows.length).toBeGreaterThan(0);
      // The ROW, not just the count: A-092's list renders her stylist, her
      // services and what she spent, and a history row with no service line
      // is dropped by the report entirely rather than rendered blank.
      expect(rows[0]!.lastServiceNames.length).toBeGreaterThan(0);
      expect(rows[0]!.lastSpendCents).toBeGreaterThan(0);
      expect(rows[0]!.weeksSince).toBeGreaterThan(12);
    });

    /**
     * A-021/A-061 — tomorrow's call-down, PART-WORKED and with BOTH outcomes.
     *
     * A list where nobody has been rung shows the screen without showing what
     * it is for, and one outcome leaves half the row unrendered on every walk
     * and under every axe run — which is the sibling of the defect checkpoint
     * 7 found twice.
     */
    it('leaves tomorrow\'s call-down part-worked, in both outcomes', async () => {
      const business = await prisma.business.findFirstOrThrow();
      const zone = zoneId(business.timezone);
      const tomorrow = addDays(calendarDay(toLabel(fromDate(SEED_NOW), zone).day), 1);
      const rows = await listUnconfirmedTomorrow(prisma, { businessId: business.id, tomorrow });
      const attempts = rows.flatMap((row) => (row.attempt ? [row.attempt.outcome] : []));
      expect(attempts.length).toBe(shared.callDownAttempts);
      expect(new Set(attempts)).toEqual(new Set(['no_answer', 'left_message']));
      // PART-worked: a list where every row has been rung is a finished errand,
      // and the screen's whole job is the ones still to do.
      expect(rows.length).toBeGreaterThan(attempts.length);
    });
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

  /**
   * The counterpart to `seedSetup`'s "changes nothing on a second run": this
   * seed genuinely cannot make that promise, so it refuses instead of half
   * keeping it. Before the guard, a second pass wrote 11 more appointments and
   * then threw `completed → checked_in` partway through, leaving a book that
   * was neither run's.
   *
   * Asserted by COUNT, not just by the throw: a guard that refuses *after*
   * writing would satisfy `rejects.toThrow` perfectly well, and writing is the
   * whole harm.
   */
  it('refuses to run on a book that already holds appointments', async () => {
    await resetDatabase(prisma);
    await seedSetup(prisma);
    await seedDensity(prisma);
    const before = await prisma.appointment.count();
    expect(before).toBeGreaterThan(20);

    await expect(seedDensity(prisma)).rejects.toThrow(/not idempotent/);
    expect(await prisma.appointment.count()).toBe(before);
  }, SEED_TIMEOUT);
});
