/**
 * A-009 — THE RACE TESTS (BOOK-03, spec §4.5).
 *
 * A race test must SPECIFY an interleaving, not sample one. `Promise.all` with
 * a hopeful assertion is a flake generator: it passes on a fast machine, hangs
 * on CI, and never tells you which interleaving it exercised.
 *
 * Every ordering constraint below is an explicit `await` on a promise the
 * other party resolves. No setTimeout, no polling, no sampling. Each test
 * carries a hard timeout so a hang FAILS rather than hanging the suite —
 * CLAUDE.md: a "flaky" race test here is a broken race test, not a retry
 * candidate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { staffActor, systemActor } from '../../core/auth';
import { Client as PgClient } from 'pg';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow, upsertDateOverride } from '../availability';
import { isSlotTakenError } from '../errors';
import { bookAppointment } from './book';
import { rescheduleAppointment } from '../appointments';
import { computeDaySlots } from '../scheduling';
import { SlotTaken } from './errors';

const prisma = new PrismaClient();
const STAFF = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');
const RACE_TIMEOUT = 20_000;

let businessId: string;
let providerId: string;
let otherProviderId: string;
let serviceId: string;

const DAY = '2026-06-09'; // Tuesday
const at = (iso: string) => toDate(instantFromIso(iso));
const TEN_AM = at('2026-06-09T10:00:00-05:00');
const NOW = at('2026-06-09T08:00:00-05:00');

/** An explicit happens-before edge. */
const barrier = () => {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
};

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const business = await prisma.business.create({
    data: {
      name: 'Shear Genius',
      timezone: 'America/Chicago',
      slotIntervalMinutes: 15,
      minimumLeadMinutes: 0,
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  const priya = await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } });
  providerId = dana.id;
  otherProviderId = priya.id;

  const service = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500, bufferAfterMinutes: 15 },
  });
  serviceId = service.id;
  await prisma.serviceProvider.createMany({
    data: [
      { businessId, serviceId, providerId: dana.id },
      { businessId, serviceId, providerId: priya.id },
    ],
  });

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAFF);
  for (const p of [dana.id, priya.id]) {
    await createWeeklyWindow(prisma, { businessId, providerId: p, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false }, STAFF);
  }
});

const book = (over: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [serviceId],
    startAt: TEN_AM,
    now: NOW,
    actor: ACTOR,
    audience: 'staff',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

const computeDaySlotsFor = async (serviceIds: string[]) =>
  (await computeDaySlots(prisma, { businessId, providerId, serviceIds, day: DAY, now: NOW, audience: 'staff' })).slots;

const countAt = async () => prisma.appointment.count({ where: { status: { notIn: ['cancelled', 'cancelled_late'] } } });

/** The SQL invariant from spec §4.5 — the assertion the nightly fuzz makes.
 *  Zero overlapping active pairs, whatever else happened. */
async function overlappingPairs(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
    SELECT count(*)::bigint AS count
      FROM "Appointment" a
      JOIN "Appointment" b
        ON a."providerId" = b."providerId"
       AND a.id < b.id
       AND a.status NOT IN ('cancelled','cancelled_late')
       AND b.status NOT IN ('cancelled','cancelled_late')
       AND tstzrange(a."blockedStart", a."blockedEnd", '[)')
        && tstzrange(b."blockedStart", b."blockedEnd", '[)')
  `);
  return Number(rows[0]!.count);
}

describe('BOOK-03 — the deterministic race matrix', () => {
  /**
   * (a) The canonical write skew — with an important consequence of D-24.
   *
   * The spec scripts this as "A reads, B reads, B commits, A writes", with A
   * failing on 23P01. That interleaving IS NO LONGER REACHABLE through this
   * write path, and deliberately so: the advisory lock serializes the two
   * transactions, so the loser re-runs the engine AFTER the winner committed
   * and finds the time occupied. It never reaches the constraint.
   *
   * That is a stronger guarantee, not a weaker one, and it is why this test
   * fires both attempts genuinely concurrently and asserts the observable
   * contract instead of a scripted internal ordering: exactly one commits,
   * the loser gets SlotTaken (a 409 with alternatives, never a 500), and the
   * SQL invariant holds. The constraint's own defence is proven separately by
   * test 1b, which bypasses the lock entirely.
   */
  it(
    '1. two concurrent bookings of the same slot → exactly one commits, loser gets SlotTaken',
    async () => {
      const [a, b] = await Promise.allSettled([book({ idempotencyKey: 'A' }), book({ idempotencyKey: 'B' })]);

      const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
      const rejected = [a, b].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // NOT a 500 — a clear "that time has just been taken" (BOOK-02).
      expect(rejected[0]!.reason).toBeInstanceOf(SlotTaken);
      expect((rejected[0]!.reason as SlotTaken).alternatives.length).toBeGreaterThan(0);
      expect(await countAt()).toBe(1);
      expect(await overlappingPairs()).toBe(0);
    },
    RACE_TIMEOUT,
  );

  /**
   * 1b. THE SCRIPTED INTERLEAVING, at the level where it is still reachable.
   *
   * D-24's lock removed this ordering from the write path, but it is exactly
   * the ordering the spec requires be proven, and it is still reachable
   * against the database — a script, a psql session, or a future code path
   * that forgets the lock takes this route. Two real connections, explicit
   * happens-before edges, no setTimeout and no polling:
   *
   *   A BEGIN, A inserts (holds the gist entry)
   *     → B BEGIN, B inserts the SAME range → BLOCKS on A's uncommitted tuple
   *       → A COMMITs → B fails with 23P01
   *
   * That blocking-then-failing behaviour is precisely why READ COMMITTED is
   * sufficient and why there is no retry loop anywhere in this write path.
   */
  it(
    '1b. two raw transactions, scripted: B blocks on A, then fails 23P01 when A commits',
    async () => {
      const a = new PgClient({ connectionString: process.env.DATABASE_URL });
      const b = new PgClient({ connectionString: process.env.DATABASE_URL });
      await a.connect();
      await b.connect();

      const aInserted = barrier();
      const bIsWaiting = barrier();

      try {
        const insert = (client: PgClient, id: string) =>
          client.query(
            `INSERT INTO "Appointment"
               (id,"businessId","providerId",status,"startAt","endAt","bufferBeforeMinutes","bufferAfterMinutes",
                "isOverride","blockedStart","blockedEnd","startDay","startWallTime","updatedAt")
             VALUES ($1,$2,$3,'booked',$4::timestamptz,$5::timestamptz,0,15,false,'epoch','epoch',$6,'10:00', now())`,
            [id, businessId, providerId, TEN_AM.toISOString(), at('2026-06-09T11:00:00-05:00').toISOString(), DAY],
          );

        const A = (async () => {
          await a.query('BEGIN');
          await insert(a, 'raceA');
          aInserted.release(); // ── edge 1: A holds the entry, uncommitted
          await bIsWaiting.reached; // ── edge 2: B is provably blocked
          await a.query('COMMIT');
        })();

        let bError: unknown;
        const B = (async () => {
          await aInserted.reached; // ── edge 1
          await b.query('BEGIN');
          // This BLOCKS until A commits or rolls back — gist exclusion checks
          // take an ordinary lock and wait. Releasing the edge immediately
          // before it is what makes the ordering explicit rather than timed.
          const blocked = insert(b, 'raceB');
          bIsWaiting.release(); // ── edge 2
          try {
            await blocked;
            await b.query('COMMIT');
          } catch (error) {
            bError = error;
            await b.query('ROLLBACK');
          }
        })();

        await Promise.all([A, B]);

        expect(bError).toBeDefined();
        expect(isSlotTakenError(bError)).toBe(true);
        expect(await countAt()).toBe(1);
        expect(await overlappingPairs()).toBe(0);
      } finally {
        await a.end();
        await b.end();
      }
    },
    RACE_TIMEOUT,
  );

  /**
   * 1c. The same script, but A ROLLS BACK — B must then SUCCEED.
   *
   * Proves the exclusion lock is released and that a failed attempt leaves no
   * phantom block. Skipping this is how you ship a system where every
   * abandoned checkout permanently kills a slot (spec §4.5 interleaving 2).
   */
  it(
    '1c. B succeeds once A rolls back — a failed attempt leaves no phantom block',
    async () => {
      const a = new PgClient({ connectionString: process.env.DATABASE_URL });
      const b = new PgClient({ connectionString: process.env.DATABASE_URL });
      await a.connect();
      await b.connect();

      const aInserted = barrier();
      const bIsWaiting = barrier();

      try {
        const insert = (client: PgClient, id: string) =>
          client.query(
            `INSERT INTO "Appointment"
               (id,"businessId","providerId",status,"startAt","endAt","bufferBeforeMinutes","bufferAfterMinutes",
                "isOverride","blockedStart","blockedEnd","startDay","startWallTime","updatedAt")
             VALUES ($1,$2,$3,'booked',$4::timestamptz,$5::timestamptz,0,15,false,'epoch','epoch',$6,'10:00', now())`,
            [id, businessId, providerId, TEN_AM.toISOString(), at('2026-06-09T11:00:00-05:00').toISOString(), DAY],
          );

        const A = (async () => {
          await a.query('BEGIN');
          await insert(a, 'rollbackA');
          aInserted.release();
          await bIsWaiting.reached;
          await a.query('ROLLBACK');
        })();

        let bCommitted = false;
        const B = (async () => {
          await aInserted.reached;
          await b.query('BEGIN');
          const blocked = insert(b, 'rollbackB');
          bIsWaiting.release();
          await blocked;
          await b.query('COMMIT');
          bCommitted = true;
        })();

        await Promise.all([A, B]);

        expect(bCommitted).toBe(true);
        expect(await countAt()).toBe(1);
        expect(await overlappingPairs()).toBe(0);
      } finally {
        await a.end();
        await b.end();
      }
    },
    RACE_TIMEOUT,
  );

  /**
   * 1d. BOOK-02's explicit requirement: provoke a REAL 23P01 through the write
   * path and assert it maps to SlotTaken rather than a 500.
   *
   * Reachable only with D-24's serialization skipped — with the lock in place
   * the loser is refused by the engine re-check and never touches the
   * constraint. That is the point of the seam: this is defence-in-depth code
   * for every path that does not take the lock, and untested
   * defence-in-depth is just an untested branch.
   *
   * Verified by mutation: removing the `isSlotTakenError` mapping in book.ts
   * makes this test fail.
   */
  it(
    '1d. a constraint violation through the write path maps to SlotTaken, not a 500',
    async () => {
      const results = await Promise.allSettled([
        book({ idempotencyKey: 'u1', __unsafeSkipSerialization: true }),
        book({ idempotencyKey: 'u2', __unsafeSkipSerialization: true }),
      ]);

      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      // Without serialization both pass their engine re-check, so the
      // constraint is what refuses the loser.
      expect(rejected).toHaveLength(1);

      // A PERMANENT DIAGNOSTIC, not debugging left behind.
      //
      // This test failed once, on 2026-08-16, during a full-suite run under
      // TZ=Pacific/Kiritimati: the rejection was a raw
      // PrismaClientUnknownRequestError instead of SlotTaken. It did not
      // reproduce in the 23 runs that followed (6 of this file alone, 17 full
      // suites), so the cause is UNKNOWN and nothing has been "fixed" on the
      // strength of a plausible story.
      //
      // What makes it expensive is that the assertion below reports only the
      // CLASS, and every contention failure Postgres can raise here —
      // 23P01 arriving unmapped, a 40P01 deadlock between the two lock-free
      // writers this test deliberately creates, a P2028 timeout — arrives as
      // that same class. So the next occurrence would be as uninformative as
      // the last. Printing the code and message costs nothing on the passing
      // path and turns a repeat into a diagnosis instead of a third
      // investigation.
      if (!(rejected[0]!.reason instanceof SlotTaken)) {
        const e = rejected[0]!.reason as { code?: unknown; meta?: unknown; message?: unknown };
        console.log(`1d ESCAPED: ${e?.constructor?.name} code=${String(e?.code)} meta=${JSON.stringify(e?.meta)}`);
        console.log(`1d MESSAGE: ${String(e?.message).replace(/\s+/g, ' ')}`);
      }
      expect(rejected[0]!.reason).toBeInstanceOf(SlotTaken);
      expect(await countAt()).toBe(1);
      expect(await overlappingPairs()).toBe(0);
    },
    RACE_TIMEOUT,
  );

  /**
   * 1e. D-24 earns its keep: the lock key must bucket by BUSINESS day.
   *
   * Two bookings on the same Chicago evening straddle UTC midnight (18:00 is
   * 23:00Z, 20:00 is 01:00Z the next day). A lock keyed on
   * `floor(epochMs / 86_400_000)` puts them in different buckets and never
   * serializes them — an axis crossing (D-3) hiding inside a lock key. This
   * asserts the two are serialized by booking overlapping ranges across that
   * boundary and requiring exactly one to win.
   */
  it(
    '1e. the advisory lock serializes across UTC midnight, because it keys on the business day',
    async () => {
      // UTC midnight is 19:00 in Chicago (CDT), which the default 09:00-17:00
      // fixture does not cover — open the evening for both business and
      // provider so the two candidates are genuinely offerable.
      for (const p of [null, providerId]) {
        await upsertDateOverride(
          prisma,
          { businessId, providerId: p, day: DAY, isClosed: false, windows: [{ open: '09:00', close: '22:00', endsNextDay: false }] },
          STAFF,
        );
      }

      const a = at('2026-06-09T18:45:00-05:00'); // 23:45Z
      const b = at('2026-06-09T19:15:00-05:00'); // 00:15Z next UTC day
      expect(Math.floor(a.getTime() / 86_400_000)).not.toBe(Math.floor(b.getTime() / 86_400_000));

      // 60-minute service +15 buffer: 18:45 blocks to 20:00, so 19:15 overlaps.
      const results = await Promise.allSettled([
        book({ startAt: a, idempotencyKey: 'utc-a' }),
        book({ startAt: b, idempotencyKey: 'utc-b' }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await overlappingPairs()).toBe(0);
    },
    RACE_TIMEOUT,
  );

  /**
   * 1f. D-24 EARNS ITS KEEP — the override race, made deterministic.
   *
   * The lock is invisible through the ordinary path: the exclusion constraint
   * already guarantees exactly-one for two normal bookings, so removing the
   * lock changes nothing observable there. Its whole value is the case the
   * constraint deliberately does NOT defend — a staff override stores a
   * zero-width range, so a customer booking racing it passes the constraint
   * and both commit (operator R-9).
   *
   * Scripted by holding the very lock the write path takes, from a separate
   * session, so the ordering is forced rather than sampled:
   *
   *   test acquires the (provider, business-day) lock
   *     → customer booking starts and BLOCKS acquiring it
   *       → a staff override is committed underneath it
   *         → test releases the lock
   *           → customer re-runs the engine, sees the override via D-16's
   *             COALESCE, and is refused
   *
   * With the lock removed from book.ts the customer never blocks, reads before
   * the override exists, and commits — so this test fails. That is what makes
   * it a test of the lock rather than a test of the constraint.
   */
  it(
    '1f. a customer cannot be booked onto time a staff override has taken',
    async () => {
      const holder = new PgClient({ connectionString: process.env.DATABASE_URL });
      await holder.connect();

      try {
        // The same key the write path derives: provider + BUSINESS day.
        await holder.query(`SELECT pg_advisory_lock(hashtext($1))`, [`${providerId}:${DAY}`]);

        const customerBooking = book({ audience: 'public', actor: systemActor, idempotencyKey: 'cust' }).catch(
          (error: unknown) => error,
        );

        // The customer is now blocked on the lock. Commit the override
        // underneath it, exactly as a staff member would from the day view.
        await book({
          isOverride: true,
          overrideReason: 'Regular, squeezing her in',
          audience: 'staff',
          idempotencyKey: 'ovr',
          __unsafeSkipSerialization: true,
        });

        await holder.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`${providerId}:${DAY}`]);

        const outcome = await customerBooking;
        expect(outcome).toBeInstanceOf(SlotTaken);

        const rows = await prisma.appointment.findMany({
          where: { status: { notIn: ['cancelled', 'cancelled_late'] } },
          select: { isOverride: true },
        });
        // ONLY the override exists. The customer was refused.
        expect(rows).toHaveLength(1);
        expect(rows[0]!.isOverride).toBe(true);
      } finally {
        await holder.end();
      }
    },
    RACE_TIMEOUT,
  );

  // (d) The loser's rollback must RELEASE the slot. Skipping this is how you
  // ship a system where every abandoned checkout permanently kills a slot.
  it(
    '2. A fails and rolls back → B then succeeds on the same slot',
    async () => {
      // A fails inside its transaction (an unqualified service id), so its
      // transaction rolls back after taking the lock.
      await expect(book({ serviceIds: ['no-such-service'] })).rejects.toThrow();
      expect(await countAt()).toBe(0);

      await expect(book({ idempotencyKey: 'after-rollback' })).resolves.toMatchObject({ deduplicated: false });
      expect(await countAt()).toBe(1);
      expect(await overlappingPairs()).toBe(0);
    },
    RACE_TIMEOUT,
  );

  // (b) Partial overlap, not identical start. Proves a unique index on
  // (provider, startAt) would be INSUFFICIENT and the range constraint is
  // doing the work.
  it(
    '3. partial overlap, different starts → exactly one succeeds',
    async () => {
      const first = await book({ startAt: at('2026-06-09T09:15:00-05:00'), idempotencyKey: 'p1' });
      expect(first.deduplicated).toBe(false);

      // 09:15 + 60min + 15min buffer blocks to 10:30, so 10:00 collides.
      await expect(book({ startAt: at('2026-06-09T10:00:00-05:00'), idempotencyKey: 'p2' })).rejects.toBeInstanceOf(
        SlotTaken,
      );
      expect(await countAt()).toBe(1);
      expect(await overlappingPairs()).toBe(0);
    },
    RACE_TIMEOUT,
  );

  // (c) Buffer-only overlap: the BODIES do not touch, the blocked ranges do.
  // Proves the constraint is on blockedStart/blockedEnd, not startAt/endAt.
  it(
    '4. buffer-only overlap → the second is refused',
    async () => {
      await book({ startAt: at('2026-06-09T09:00:00-05:00'), idempotencyKey: 'b1' });
      // 09:00-10:00 body, +15 buffer → blocked to 10:15. A 10:00 start's body
      // begins after the first body ends, but inside its buffer.
      await expect(book({ startAt: at('2026-06-09T10:00:00-05:00'), idempotencyKey: 'b2' })).rejects.toBeInstanceOf(
        SlotTaken,
      );
      expect(await overlappingPairs()).toBe(0);
    },
    RACE_TIMEOUT,
  );

  // (g) The test that proves the D-15 partial predicate, re-asserted at the
  // API after A-003 asserted it against the database.
  it.each(['cancelled', 'cancelled_late'] as const)(
    '5. a %s appointment does not block a rebooking of the same range',
    async (status) => {
      const booked = await book({ idempotencyKey: `c-${status}` });
      await prisma.appointment.update({ where: { id: booked.id }, data: { status } });

      await expect(book({ idempotencyKey: `re-${status}` })).resolves.toMatchObject({ deduplicated: false });
      expect(await overlappingPairs()).toBe(0);
    },
    RACE_TIMEOUT,
  );

  /**
   * (h) THE SPEC'S SIXTH INTERLEAVING (§4.5), which nothing could test until
   * A-014 existed: a reschedule and a fresh booking racing for the same
   * destination.
   *
   * It is the interesting one because the two paths are different code — a
   * same-row `UPDATE` and an `INSERT` — reaching the same slot. The lock they
   * share is keyed on the provider-DAY, not on the row or the statement, which
   * is what makes them serialize against each other at all; a lock taken on
   * the appointment row would not, because the booking has no row to lock.
   *
   * Fired genuinely concurrently and asserted on the observable contract:
   * exactly one occupies 14:00, the loser is told the time went rather than
   * given a 500, and the SQL invariant holds either way.
   */
  it(
    '6. reschedule vs new booking for the same destination → exactly one wins',
    async () => {
      const mine = await book({ idempotencyKey: 'the-mover' });

      const destination = at('2026-06-09T14:00:00-05:00');
      const results = await Promise.allSettled([
        rescheduleAppointment(prisma, {
          appointmentId: mine.id,
          startAt: destination,
          now: NOW,
          actor: ACTOR,
          audience: 'staff',
        }),
        book({ startAt: destination, idempotencyKey: 'the-newcomer' }),
      ]);

      const winners = results.filter((r) => r.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      const loser = results.find((r) => r.status === 'rejected');
      expect(loser?.reason).toBeInstanceOf(SlotTaken);

      // Whichever won, the salon's book is consistent: one appointment at
      // 14:00, and no overlapping pair anywhere.
      const atDestination = await prisma.appointment.count({
        where: { startAt: destination, status: { notIn: ['cancelled', 'cancelled_late'] } },
      });
      expect(atDestination).toBe(1);
      expect(await overlappingPairs()).toBe(0);

      // And the customer whose appointment was being moved still HAS one —
      // the failure mode that makes cancel-then-book unacceptable (spec §4.6).
      const stillThere = await prisma.appointment.findUniqueOrThrow({ where: { id: mine.id } });
      expect(stillThere.status).toBe('booked');
    },
    RACE_TIMEOUT,
  );

  // (e) Same slot, DIFFERENT providers → both succeed. Without
  // `providerId WITH =` in the constraint you have accidentally serialized
  // the entire salon.
  it(
    '7. same slot, different providers → both succeed',
    async () => {
      const [a, b] = await Promise.allSettled([
        book({ idempotencyKey: 'dana' }),
        book({ providerId: otherProviderId, idempotencyKey: 'priya' }),
      ]);
      expect(a.status).toBe('fulfilled');
      expect(b.status).toBe('fulfilled');
      expect(await countAt()).toBe(2);
      expect(await overlappingPairs()).toBe(0);
    },
    RACE_TIMEOUT,
  );

  // (f) Idempotency: the same key twice returns the SAME appointment, not a
  // conflict and not a duplicate.
  it(
    '8. the same idempotency key twice returns the same appointment',
    async () => {
      const first = await book({ idempotencyKey: 'same-key' });
      const second = await book({ idempotencyKey: 'same-key' });

      expect(second.id).toBe(first.id);
      expect(second.deduplicated).toBe(true);
      expect(await countAt()).toBe(1);
    },
    RACE_TIMEOUT,
  );

  it(
    '8b. two CONCURRENT requests with the same idempotency key still produce one appointment',
    async () => {
      const results = await Promise.allSettled([
        book({ idempotencyKey: 'concurrent-key' }),
        book({ idempotencyKey: 'concurrent-key' }),
      ]);
      // One creates; the other either dedupes or loses on the unique index —
      // either way exactly one appointment exists and neither is a 500.
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(await countAt()).toBe(1);
      expect(await overlappingPairs()).toBe(0);
    },
    RACE_TIMEOUT,
  );

  /**
   * 9. THE NINTH INTERLEAVING (operator review R-9).
   *
   * A staff override writes a ZERO-WIDTH blocked range, so the exclusion
   * constraint deliberately does NOT defend that time — only the
   * in-transaction engine re-check does. Without serialization both a staff
   * override and a concurrent self-serve booking pass their re-checks and both
   * commit, and the customer creates the accidental double-book Goal 2 forbids.
   *
   * D-24's advisory lock is what makes this deterministic: the second
   * transaction waits, re-runs the engine against the committed override, and
   * sees the time occupied (D-16's COALESCE).
   */
  it(
    '9. staff override vs concurrent self-serve booking of the same range',
    async () => {
      const results = await Promise.allSettled([
        book({ isOverride: true, overrideReason: 'Regular, squeezing her in', audience: 'staff', idempotencyKey: 'ovr' }),
        book({ audience: 'public', actor: systemActor, idempotencyKey: 'cust' }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      // The override always succeeds — staff can always act.
      const override = await prisma.appointment.findFirst({ where: { isOverride: true } });
      expect(override).not.toBeNull();

      // Whatever the ordering, the customer must NOT end up sharing that time.
      // Either she lost (one appointment) or she booked first and the override
      // knowingly joined her (two, but the second is a marked override).
      const active = await prisma.appointment.findMany({
        where: { status: { notIn: ['cancelled', 'cancelled_late'] } },
        select: { isOverride: true },
      });
      const nonOverride = active.filter((a) => !a.isOverride);
      expect(nonOverride.length).toBeLessThanOrEqual(1);
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // And the invariant still holds: no two ACTIVE non-override rows overlap.
      expect(await overlappingPairs()).toBe(0);
    },
    RACE_TIMEOUT,
  );
});

/**
 * The nightly fuzz (spec §4.5). Its assertion is the SQL INVARIANT, not a
 * success count — "how many succeeded" is a property of timing, "do any two
 * active appointments overlap" is a property of correctness.
 *
 * Skipped in the ordinary gate because it is genuinely concurrent and
 * therefore slow; run with FUZZ=1.
 */
describe.skipIf(!process.env.FUZZ)('nightly concurrency fuzz', () => {
  it(
    'fires 50 concurrent bookings and leaves zero overlapping pairs',
    async () => {
      const starts = ['09:00', '09:15', '09:30', '10:00', '11:00'];
      const attempts = Array.from({ length: 50 }, (_, i) =>
        book({
          startAt: at(`2026-06-09T${starts[i % starts.length]}:00-05:00`),
          idempotencyKey: `fuzz-${i}`,
        }).catch(() => null),
      );
      await Promise.all(attempts);
      expect(await overlappingPairs()).toBe(0);
    },
    120_000,
  );
});

/**
 * A-028 — multi-service visits (VISIT-01, D-23).
 *
 * Half the sample salon's Saturday is cut+colour, and the workaround staff
 * would otherwise reach for — two adjacent appointments — is REFUSED by the
 * database once one service's bufferAfter meets the next one's bufferBefore.
 * Routing every combination booking through a knowing override would make
 * D-8's override marker meaningless.
 */
describe('VISIT-01 — one appointment, several services', () => {
  let colourId: string;

  beforeEach(async () => {
    // Cut is 60min +15 after (from the outer fixture). Colour is 120min,
    // 10 before / 20 after — unequal on purpose, so whose-buffer bugs cannot
    // hide (CLAUDE.md).
    const colour = await prisma.service.create({
      data: {
        businessId,
        name: 'Colour',
        durationMinutes: 120,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 20,
        priceCents: 14000,
      },
    });
    colourId = colour.id;
    await prisma.serviceProvider.create({ data: { businessId, serviceId: colourId, providerId } });
    // The composed visit is 180 minutes, so open the day wide enough for it.
    for (const p of [null, providerId]) {
      await upsertDateOverride(
        prisma,
        { businessId, providerId: p, day: DAY, isClosed: false, windows: [{ open: '09:00', close: '20:00', endsNextDay: false }] },
        STAFF,
      );
    }
  });

  it('books cut+colour as ONE appointment with one ordered line per service', async () => {
    const booked = await book({ serviceIds: [serviceId, colourId], startAt: at('2026-06-09T10:00:00-05:00'), idempotencyKey: 'visit' });

    // 60 + 120 = 180 minutes of body.
    expect(booked.endAt.getTime() - booked.startAt.getTime()).toBe(180 * 60_000);

    const lines = await prisma.appointmentServiceLine.findMany({
      where: { appointmentId: booked.id },
      orderBy: { ordinal: 'asc' },
    });
    expect(lines).toHaveLength(1 + 1);
    expect(lines.map((l) => l.serviceId)).toEqual([serviceId, colourId]);
    // D-18: each line snapshots its OWN price and duration, so a later price
    // rise cannot rewrite this visit's history and "which service cost what"
    // survives.
    expect(lines.map((l) => l.priceCents)).toEqual([5500, 14000]);
    expect(lines.map((l) => l.durationMinutes)).toEqual([60, 120]);
    expect(await prisma.appointment.count()).toBe(1);
  });

  // The rule the whole item turns on.
  it('does NOT stack the inner buffers — the visit takes the first before and the last after', async () => {
    const booked = await book({ serviceIds: [serviceId, colourId], startAt: at('2026-06-09T10:00:00-05:00'), idempotencyKey: 'buffers' });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: booked.id } });
    // Cut goes first (0 before), colour last (20 after). The cut's 15-after
    // and the colour's 10-before are INSIDE the visit and must not apply.
    expect(row.bufferBeforeMinutes).toBe(0);
    expect(row.bufferAfterMinutes).toBe(20);

    // Blocked range = body ± the visit's own buffers only: 10:00 → 13:00 +20.
    expect(row.blockedStart.toISOString()).toBe(at('2026-06-09T10:00:00-05:00').toISOString());
    expect(row.blockedEnd.toISOString()).toBe(at('2026-06-09T13:20:00-05:00').toISOString());
  });

  it('ORDER matters — reversing the services changes the blocked range', async () => {
    const booked = await book({ serviceIds: [colourId, serviceId], startAt: at('2026-06-09T10:00:00-05:00'), idempotencyKey: 'reversed' });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: booked.id } });
    // Colour first (10 before), cut last (15 after).
    expect(row.bufferBeforeMinutes).toBe(10);
    expect(row.bufferAfterMinutes).toBe(15);
    const lines = await prisma.appointmentServiceLine.findMany({
      where: { appointmentId: booked.id },
      orderBy: { ordinal: 'asc' },
    });
    expect(lines.map((l) => l.serviceId)).toEqual([colourId, serviceId]);
  });

  it('offers slots for the COMPOSED duration, not the first service alone', async () => {
    const single = await computeDaySlotsFor([serviceId]);
    const visit = await computeDaySlotsFor([serviceId, colourId]);
    // A 180-minute visit fits in fewer places than a 60-minute cut.
    expect(visit.length).toBeLessThan(single.length);
    // And the last offered visit start must leave room for all 180 minutes.
    const lastVisit = visit[visit.length - 1]!;
    expect(lastVisit.end - lastVisit.start).toBe(180 * 60_000);
  });

  it('the composed visit still collides with a neighbouring booking', async () => {
    await book({ serviceIds: [serviceId], startAt: at('2026-06-09T12:00:00-05:00'), idempotencyKey: 'neighbour' });
    // A 10:00 cut+colour runs to 13:00 and would swallow the 12:00 booking.
    await expect(
      book({ serviceIds: [serviceId, colourId], startAt: at('2026-06-09T10:00:00-05:00'), idempotencyKey: 'clash' }),
    ).rejects.toBeInstanceOf(SlotTaken);
    expect(await overlappingPairs()).toBe(0);
  });

  it('refuses a visit containing a service the provider is not qualified for', async () => {
    const unqualified = await prisma.service.create({
      data: { businessId, name: 'Massage', durationMinutes: 30, priceCents: 8000 },
    });
    await expect(
      book({ serviceIds: [serviceId, unqualified.id], startAt: at('2026-06-09T10:00:00-05:00'), idempotencyKey: 'unqual' }),
    ).rejects.toThrow();
    expect(await prisma.appointment.count()).toBe(0);
  });

  it('refuses an empty visit', async () => {
    await expect(book({ serviceIds: [], idempotencyKey: 'empty' })).rejects.toThrow();
  });
});
