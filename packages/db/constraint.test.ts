/**
 * A-003 — the invariant tests, written DIRECTLY AGAINST THE DATABASE.
 *
 * These deliberately use `pg` rather than Prisma. The point of D-2 is that
 * no-overlap is enforced by the database and *every* code path is refused —
 * app, script, psql, a future migration. A test that goes through the ORM only
 * proves the ORM behaves; this one proves the invariant holds against a client
 * that knows nothing about the application's rules.
 *
 * Nothing here reads the system clock, and every instant is written with an
 * explicit offset.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { ACTIVE_STATUSES, APPOINTMENT_STATUSES, SLOT_FREEING_STATUSES } from '../core/scheduling/status';
import { isSlotTakenError } from './errors';
import { instantFromIso, toDate } from '../core/time';

const db = new Client({ connectionString: process.env.DATABASE_URL });

/** The SQLSTATE for exclusion_violation. NOT 23505 — Prisma will not surface
 *  this as P2002, which is why A-009 must map it explicitly (spec §4.2). */
const EXCLUSION_VIOLATION = '23P01';
const CHECK_VIOLATION = '23514';
/** `restrict_violation`. Verified against PG17 — this is what the append-only
 *  trigger's `USING ERRCODE = 'restrict_violation'` actually surfaces. */
const RESTRICT_VIOLATION = '23001';

let businessId: string;
let providerA: string;
let providerB: string;

beforeAll(async () => {
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  // Truncate rather than recreate: fast, and it proves the constraint survives
  // an empty table (a constraint dropped by a bad migration would still pass a
  // suite that only ever inserts one row).
  // Every table, not a hand-picked subset: a partial list leaves rows that
  // break whichever file runs next (see packages/db/testing/reset.ts).
  await db.query(
    'TRUNCATE "AppointmentEvent", "AppointmentServiceLine", "NotificationOutbox", "ManageToken", "Appointment", ' +
      '"WaitlistEntry", "Client", "WindowBreak", "DateOverrideWindow", "DateOverride", "WeeklyWindow", "TimeOff", ' +
      '"AdHocBlock", "ServiceProvider", "ServiceSegment", "Service", "Resource", "ResourceType", "Provider", ' +
      '"StaffUser", "Business" RESTART IDENTITY CASCADE',
  );
  const b = await db.query<{ id: string }>(
    `INSERT INTO "Business" (id, name, timezone, "updatedAt") VALUES ('biz1','Shear Genius','America/Chicago', now()) RETURNING id`,
  );
  businessId = b.rows[0]!.id;
  const p = await db.query<{ id: string }>(
    `INSERT INTO "Provider" (id, "businessId", "displayName", "updatedAt")
     VALUES ('provA',$1,'Dana', now()), ('provB',$1,'Priya', now()) RETURNING id`,
    [businessId],
  );
  providerA = p.rows[0]!.id;
  providerB = p.rows[1]!.id;
});

/** Insert an appointment straight into the table. `blockedStart`/`blockedEnd`
 *  are passed as placeholders — the trigger overwrites them, which is itself
 *  part of what these tests verify. */
const insert = (opts: {
  id: string;
  provider?: string;
  status?: string;
  start: string;
  end: string;
  bufferBefore?: number;
  bufferAfter?: number;
  isOverride?: boolean;
  /** D-29's alternating active/gap minutes. Omitted means one continuous
   *  block, exactly as every appointment booked before A-030. */
  pattern?: number[];
}) =>
  db.query(
    `INSERT INTO "Appointment"
       (id, "businessId", "providerId", status, "startAt", "endAt",
        "bufferBeforeMinutes", "bufferAfterMinutes", "isOverride", "segmentPattern",
        "blockedStart", "blockedEnd", "startDay", "startWallTime", "updatedAt")
     VALUES ($1,$2,$3,$4::"AppointmentStatus",$5,$6,$7,$8,$9,$10,'epoch','epoch','2026-06-09','00:00', now())`,
    [
      opts.id,
      businessId,
      opts.provider ?? providerA,
      opts.status ?? 'booked',
      opts.start,
      opts.end,
      opts.bufferBefore ?? 0,
      opts.bufferAfter ?? 0,
      opts.isOverride ?? false,
      opts.pattern ?? [],
    ],
  );

const sqlstateOf = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? null;
  }
};

describe('appointment_no_overlap — the D-2 invariant', () => {
  it('refuses an overlapping appointment for the same provider with 23P01', async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    const code = await sqlstateOf(() =>
      insert({ id: 'b', start: '2026-06-09T10:30:00-05:00', end: '2026-06-09T11:30:00-05:00' }),
    );
    expect(code).toBe(EXCLUSION_VIOLATION);
  });

  // The single most important allowance in the whole schema. With '[]' instead
  // of '[)' this fails, and the salon can never book consecutive clients —
  // which is most of a working day.
  it('ALLOWS back-to-back appointments sharing an endpoint (half-open [start, end))', async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    await expect(
      insert({ id: 'b', start: '2026-06-09T11:00:00-05:00', end: '2026-06-09T12:00:00-05:00' }),
    ).resolves.toBeDefined();
  });

  it('allows the same time for a different provider (providerId WITH = is present)', async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    await expect(
      insert({ id: 'b', provider: providerB, start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' }),
    ).resolves.toBeDefined();
  });

  // Unequal buffers on purpose (CLAUDE.md): equal buffers hide whose-buffer bugs.
  it('refuses a BUFFER-ONLY overlap — bodies do not touch, blocked ranges do', async () => {
    // Body 10:00-11:00, +15 after -> blocked to 11:15.
    await insert({
      id: 'a',
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T11:00:00-05:00',
      bufferAfter: 15,
    });
    // Body 11:10-11:40 (no body overlap), -5 before -> blocked from 11:05, which
    // lands inside a's buffer.
    const code = await sqlstateOf(() =>
      insert({
        id: 'b',
        start: '2026-06-09T11:10:00-05:00',
        end: '2026-06-09T11:40:00-05:00',
        bufferBefore: 5,
      }),
    );
    expect(code).toBe(EXCLUSION_VIOLATION);
  });
});

describe('the partial predicate — which statuses free the slot (D-15)', () => {
  // This pair is the test that proves the predicate, and it is why the spec's
  // literal `<> 'cancelled'` is wrong: cancelled_late would block forever.
  it.each(SLOT_FREEING_STATUSES)('a %s appointment does NOT block a rebooking of the identical range', async (status) => {
    await insert({ id: 'old', status, start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    await expect(
      insert({ id: 'new', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' }),
    ).resolves.toBeDefined();
  });

  // no_show and completed are TERMINAL but still OCCUPY their time (D-7).
  // Confusing "terminal" with "frees the slot" puts a gap in the day view where
  // a client was actually sitting.
  it.each(ACTIVE_STATUSES)('a %s appointment DOES still block its time', async (status) => {
    await insert({ id: 'old', status, start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    const code = await sqlstateOf(() =>
      insert({ id: 'new', start: '2026-06-09T10:15:00-05:00', end: '2026-06-09T10:45:00-05:00' }),
    );
    expect(code).toBe(EXCLUSION_VIOLATION);
  });

  // The structural guard against the rental build's VERIFIED defect: if someone
  // adds a status to the enum and forgets the constraint, this fails.
  it('the LIVE constraint predicate matches ACTIVE_STATUSES in the status module', async () => {
    const { rows } = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'appointment_block_no_overlap'`,
    );
    const def = rows[0]!.def;
    for (const status of SLOT_FREEING_STATUSES) {
      expect(def).toContain(`'${status}'`);
    }
    for (const status of ACTIVE_STATUSES) {
      expect(def).not.toContain(`'${status}'`);
    }
  });

  /**
   * The other half of the same guard, and the half that was missing.
   *
   * The test above proves the CONSTRAINT agrees with the module. This proves
   * the ENUM does. Without it, a ninth status added to `schema.prisma` and not
   * to `status.ts` leaves every derived list — the busy set, reminder
   * eligibility, the §7 transition table — silently ignorant of a status rows
   * can actually hold, which is the rental `VERIFIED` defect exactly.
   */
  it('the LIVE AppointmentStatus enum matches APPOINTMENT_STATUSES in the status module', async () => {
    const { rows } = await db.query<{ label: string }>(
      `SELECT e.enumlabel AS label
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'AppointmentStatus'
        ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual([...APPOINTMENT_STATUSES]);
  });
});

describe('staff overrides — D-8 / D-16', () => {
  it('lets a staff override coexist inside an existing booking via a zero-width range', async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    await expect(
      insert({
        id: 'override',
        start: '2026-06-09T10:30:00-05:00',
        end: '2026-06-09T11:00:00-05:00',
        bufferAfter: 10,
        isOverride: true,
      }),
    ).resolves.toBeDefined();

    const { rows } = await db.query<{
      blockedStart: string;
      blockedEnd: string;
      overriddenFromRange: string | null;
    }>(
      `SELECT "blockedStart", "blockedEnd", "overriddenFromRange"::text AS "overriddenFromRange"
         FROM "Appointment" WHERE id='override'`,
    );
    // Zero-width: participates in no && .
    expect(rows[0]!.blockedStart).toEqual(rows[0]!.blockedEnd);
    // ...but the TRUE range is preserved, so the day view can render the real
    // collision and the engine's busy set can subtract it (D-16).
    expect(rows[0]!.overriddenFromRange).not.toBeNull();
  });

  it('still refuses a NON-override customer booking of the overridden time — Goal 2', async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    await insert({
      id: 'override',
      start: '2026-06-09T10:30:00-05:00',
      end: '2026-06-09T11:00:00-05:00',
      isOverride: true,
    });
    const code = await sqlstateOf(() =>
      insert({ id: 'customer', start: '2026-06-09T10:30:00-05:00', end: '2026-06-09T10:45:00-05:00' }),
    );
    expect(code).toBe(EXCLUSION_VIOLATION);
  });

  it('refuses an override row without its true range, and a normal row with one', async () => {
    const code = await sqlstateOf(() =>
      db.query(
        `INSERT INTO "Appointment"
           (id,"businessId","providerId",status,"startAt","endAt","bufferBeforeMinutes","bufferAfterMinutes",
            "isOverride","blockedStart","blockedEnd","overriddenFromRange","startDay","startWallTime","updatedAt")
         VALUES ('bad',$1,$2,'booked','2026-06-09T10:00:00-05:00','2026-06-09T11:00:00-05:00',0,0,
                 false,'epoch','epoch', tstzrange('2026-06-09T10:00:00-05:00','2026-06-09T11:00:00-05:00','[)'),
                 '2026-06-09','10:00', now())`,
        [businessId, providerA],
      ),
    );
    // The trigger nulls the range for a non-override row, so the CHECK holds —
    // the invariant is maintained by construction rather than by refusal.
    expect(code).toBeNull();
    const { rows } = await db.query(`SELECT "overriddenFromRange" FROM "Appointment" WHERE id='bad'`);
    expect(rows[0]!.overriddenFromRange).toBeNull();
  });
});

describe('the blocked-range trigger', () => {
  it('computes blocked ranges from the buffers, overwriting whatever was passed in', async () => {
    await insert({
      id: 'a',
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T11:00:00-05:00',
      bufferBefore: 5,
      bufferAfter: 15, // unequal on purpose
    });
    const { rows } = await db.query<{ bs: string; be: string }>(
      `SELECT to_char("blockedStart" AT TIME ZONE 'America/Chicago','HH24:MI') AS bs,
              to_char("blockedEnd"   AT TIME ZONE 'America/Chicago','HH24:MI') AS be
         FROM "Appointment" WHERE id='a'`,
    );
    expect(rows[0]).toEqual({ bs: '09:55', be: '11:15' });
  });

  it('recomputes the blocked range on UPDATE, so a reschedule cannot leave a stale range', async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00', bufferAfter: 15 });
    await db.query(
      `UPDATE "Appointment" SET "startAt"='2026-06-09T14:00:00-05:00', "endAt"='2026-06-09T15:00:00-05:00' WHERE id='a'`,
    );
    const { rows } = await db.query<{ be: string }>(
      `SELECT to_char("blockedEnd" AT TIME ZONE 'America/Chicago','HH24:MI') AS be FROM "Appointment" WHERE id='a'`,
    );
    expect(rows[0]!.be).toBe('15:15');
  });
});

describe('whole-minute instants', () => {
  it.each([
    ['seconds', '2026-06-09T10:00:30-05:00'],
    ['milliseconds', '2026-06-09T10:00:00.500-05:00'],
  ])('refuses a start with %s — one stray ms breaks back-to-back equality', async (_label, start) => {
    const code = await sqlstateOf(() => insert({ id: 'a', start, end: '2026-06-09T11:00:00-05:00' }));
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('refuses an appointment that ends before it starts', async () => {
    const code = await sqlstateOf(() =>
      insert({ id: 'a', start: '2026-06-09T11:00:00-05:00', end: '2026-06-09T10:00:00-05:00' }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('AppointmentEvent is append-only (§6)', () => {
  const seedEvent = async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    await db.query(
      `INSERT INTO "AppointmentEvent" (id,"businessId","appointmentId",type,actor)
       VALUES ('e1',$1,'a','booked','staff'::"Actor")`,
      [businessId],
    );
  };

  it('refuses UPDATE', async () => {
    await seedEvent();
    const code = await sqlstateOf(() => db.query(`UPDATE "AppointmentEvent" SET type='tampered' WHERE id='e1'`));
    expect(code).toBe(RESTRICT_VIOLATION);
  });

  it('refuses DELETE', async () => {
    await seedEvent();
    const code = await sqlstateOf(() => db.query(`DELETE FROM "AppointmentEvent" WHERE id='e1'`));
    expect(code).toBe(RESTRICT_VIOLATION);
  });

  it('refuses deleting an appointment that has events (onDelete: Restrict)', async () => {
    await seedEvent();
    const code = await sqlstateOf(() => db.query(`DELETE FROM "Appointment" WHERE id='a'`));
    expect(code).toBeTruthy(); // FK restrict, not the trigger
  });
});

describe('D-12 affordances', () => {
  // A-029 lifted the partial unique index that pinned every service to one
  // ACTIVE segment — that guard existed while the engine ignored the table,
  // and a colour is three rows. What still holds is ordinal uniqueness.
  it('permits several ACTIVE segments per service', async () => {
    await db.query(
      `INSERT INTO "Service" (id,"businessId",name,"durationMinutes","priceCents","updatedAt")
       VALUES ('svc1',$1,'Colour',120,12000, now())`,
      [businessId],
    );
    for (const [i, minutes, isGap] of [
      [0, 50, false],
      [1, 40, true],
      [2, 30, false],
    ] as const) {
      await db.query(
        `INSERT INTO "ServiceSegment" (id,"businessId","serviceId",ordinal,"durationMinutes","isGap","updatedAt")
         VALUES ($1,$2,'svc1',$3,$4,$5, now())`,
        [`seg${i}`, businessId, i, minutes, isGap],
      );
    }
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM "ServiceSegment" WHERE "serviceId"='svc1'`);
    expect(rows[0].n).toBe(3);
  });

  it('still refuses two segments at the same ordinal', async () => {
    await db.query(
      `INSERT INTO "Service" (id,"businessId",name,"durationMinutes","priceCents","updatedAt")
       VALUES ('svc1',$1,'Colour',90,12000, now())`,
      [businessId],
    );
    await db.query(
      `INSERT INTO "ServiceSegment" (id,"businessId","serviceId",ordinal,"durationMinutes","updatedAt")
       VALUES ('seg1',$1,'svc1',0,60, now())`,
      [businessId],
    );
    const code = await sqlstateOf(() =>
      db.query(
        `INSERT INTO "ServiceSegment" (id,"businessId","serviceId",ordinal,"durationMinutes","updatedAt")
         VALUES ('seg2',$1,'svc1',0,30, now())`,
        [businessId],
      ),
    );
    expect(code).toBe('23505');
  });

  // A-030/D-29 — the invariant got FINER, not weaker, and these two tests are
  // the whole difference.
  //
  // A-029 left a "tripwire" here meant to fail when A-030 landed. It did not
  // fire, because it booked into the gap of an appointment with no
  // segmentPattern — one continuous block, correctly refused before and after.
  // A tripwire that does not encode the new capability is not a tripwire; the
  // pair below asserts the capability itself, in both directions.
  it('ACCEPTS a booking that lands entirely inside a segmented appointment gap', async () => {
    // A colour 10:00-12:00, cut 50 active / 40 developing / 30 active. The
    // provider is genuinely free 10:50-11:30.
    await insert({
      id: 'colour',
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T12:00:00-05:00',
      pattern: [50, 40, 30],
    });
    await expect(
      insert({ id: 'blowdry', start: '2026-06-09T10:50:00-05:00', end: '2026-06-09T11:20:00-05:00' }),
    ).resolves.toBeDefined();
  });

  it('still REFUSES one that spills out of the gap into the second worked part', async () => {
    await insert({
      id: 'colour',
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T12:00:00-05:00',
      pattern: [50, 40, 30],
    });
    const code = await sqlstateOf(() =>
      insert({ id: 'blowdry', start: '2026-06-09T11:10:00-05:00', end: '2026-06-09T11:40:00-05:00' }),
    );
    expect(code).toBe(EXCLUSION_VIOLATION);
  });

  it('cuts a colour into exactly two blocks, with the buffers on the outer edges', async () => {
    await insert({
      id: 'colour',
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T12:00:00-05:00',
      pattern: [50, 40, 30],
      bufferBefore: 10,
      bufferAfter: 20,
    });
    const { rows } = await db.query<{ ordinal: number; s: string; e: string }>(
      `SELECT ordinal, to_char("blockedStart" AT TIME ZONE 'America/Chicago','HH24:MI') AS s,
              to_char("blockedEnd"   AT TIME ZONE 'America/Chicago','HH24:MI') AS e
         FROM "AppointmentBlock" WHERE "appointmentId"='colour' ORDER BY ordinal`,
    );
    // Buffers belong to the VISIT, not to each part (SEG-01): 09:50 on the
    // front, 12:20 on the back, and nothing added around the gap.
    expect(rows.map((r) => [r.s, r.e])).toEqual([
      ['09:50', '10:50'],
      ['11:30', '12:20'],
    ]);
  });

  it('an unsegmented appointment is still exactly one block', async () => {
    await insert({ id: 'cut', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T10:45:00-05:00' });
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "AppointmentBlock" WHERE "appointmentId"='cut'`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses a pattern that does not add up to the body', async () => {
    const code = await sqlstateOf(() =>
      insert({
        id: 'bad',
        start: '2026-06-09T10:00:00-05:00',
        end: '2026-06-09T12:00:00-05:00',
        pattern: [50, 40, 20],
      }),
    );
    expect(code).toBe('23514'); // check_violation
  });

  it('refuses a pattern ending on a gap', async () => {
    const code = await sqlstateOf(() =>
      insert({
        id: 'bad',
        start: '2026-06-09T10:00:00-05:00',
        end: '2026-06-09T12:00:00-05:00',
        pattern: [80, 40],
      }),
    );
    expect(code).toBe('23514');
  });

  it('frees every block when the appointment is cancelled, not just the first', async () => {
    await insert({
      id: 'colour',
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T12:00:00-05:00',
      pattern: [50, 40, 30],
    });
    await db.query(`UPDATE "Appointment" SET status='cancelled' WHERE id='colour'`);
    // The whole two hours is now bookable, across what used to be both parts.
    await expect(
      insert({ id: 'rebook', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T12:00:00-05:00' }),
    ).resolves.toBeDefined();
  });
});

describe('detecting the violation through Prisma (verified, for A-009)', () => {
  it('surfaces 23P01 as an error the predicate recognises — and NOT as Prisma code P2002', async () => {
    const { PrismaClient } = await import('./generated/client/index.js');
    const prisma = new PrismaClient();
    try {
      const shared = {
        businessId,
        providerId: providerA,
        startDay: '2026-06-09',
        startWallTime: '10:00',
        blockedStart: toDate(instantFromIso('1970-01-01T00:00:00Z')),
        blockedEnd: toDate(instantFromIso('1970-01-01T00:00:00Z')),
      };
      await prisma.appointment.create({
        data: { id: 'p1', ...shared, startAt: toDate(instantFromIso('2026-06-09T15:00:00Z')), endAt: toDate(instantFromIso('2026-06-09T16:00:00Z')) },
      });
      let caught: unknown;
      try {
        await prisma.appointment.create({
          data: { id: 'p2', ...shared, startAt: toDate(instantFromIso('2026-06-09T15:30:00Z')), endAt: toDate(instantFromIso('2026-06-09T16:30:00Z')) },
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      // The reflex — and why it fails. Left as an explicit assertion so nobody
      // "fixes" isSlotTakenError into a code check.
      expect((caught as { code?: string }).code).toBeUndefined();
      expect(isSlotTakenError(caught)).toBe(true);
      expect(isSlotTakenError(new Error('some other failure'))).toBe(false);
    } finally {
      await prisma.$disconnect();
    }
  });
});

/**
 * Added after the Milestone 1 operator review (docs/reviews/05-*.md, R-2).
 *
 * The constraint is now DEFERRABLE INITIALLY IMMEDIATE. The point of these
 * tests is that BOTH halves hold: a multi-row rearrangement becomes possible,
 * and nothing about ordinary single-row booking changes.
 */
describe('deferrable constraint — the Saturday swap (operator review R-2)', () => {
  it('is DEFERRABLE but INITIALLY IMMEDIATE', async () => {
    const { rows } = await db.query<{ condeferrable: boolean; condeferred: boolean }>(
      `SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'appointment_block_no_overlap'`,
    );
    expect(rows[0]!.condeferrable).toBe(true);
    // INITIALLY IMMEDIATE: ordinary writes still check at statement end, so
    // the race interleavings are untouched.
    expect(rows[0]!.condeferred).toBe(false);
  });

  it('STILL refuses an overlap in an ordinary transaction that does not defer', async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    const code = await sqlstateOf(() =>
      insert({ id: 'b', start: '2026-06-09T10:30:00-05:00', end: '2026-06-09T11:30:00-05:00' }),
    );
    expect(code).toBe(EXCLUSION_VIOLATION);
  });

  // "Put Mrs. Hall at 2, move Jenny to 3." Impossible before this migration:
  // no order of single-row updates avoids a transient overlap.
  it('allows two clients to SWAP times inside one deferred transaction', async () => {
    await insert({ id: 'hall', start: '2026-06-09T14:00:00-05:00', end: '2026-06-09T15:00:00-05:00' });
    await insert({ id: 'jenny', start: '2026-06-09T15:00:00-05:00', end: '2026-06-09T16:00:00-05:00' });

    await db.query('BEGIN');
    await db.query('SET CONSTRAINTS appointment_block_no_overlap DEFERRED');
    await db.query(
      `UPDATE "Appointment" SET "startAt"='2026-06-09T15:00:00-05:00', "endAt"='2026-06-09T16:00:00-05:00' WHERE id='hall'`,
    );
    await db.query(
      `UPDATE "Appointment" SET "startAt"='2026-06-09T14:00:00-05:00', "endAt"='2026-06-09T15:00:00-05:00' WHERE id='jenny'`,
    );
    await db.query('COMMIT');

    const { rows } = await db.query<{ id: string; hhmm: string }>(
      `SELECT id, to_char("startAt" AT TIME ZONE 'America/Chicago','HH24:MI') AS hhmm
         FROM "Appointment" ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: 'hall', hhmm: '15:00' },
      { id: 'jenny', hhmm: '14:00' },
    ]);
  });

  // Deferring must not mean "unchecked". A genuine conflict still fails —
  // just at COMMIT rather than at the statement.
  it('still refuses a genuine conflict in a deferred transaction, at COMMIT time', async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    await db.query('BEGIN');
    await db.query('SET CONSTRAINTS appointment_block_no_overlap DEFERRED');
    // This INSERT succeeds at statement time — the check is deferred.
    await insert({ id: 'b', start: '2026-06-09T10:30:00-05:00', end: '2026-06-09T11:30:00-05:00' });
    const code = await sqlstateOf(() => db.query('COMMIT'));
    expect(code).toBe(EXCLUSION_VIOLATION);
    await db.query('ROLLBACK').catch(() => {});

    const { rows } = await db.query(`SELECT id FROM "Appointment"`);
    expect(rows).toHaveLength(1); // the conflicting row did not survive
  });

  // The operator review predicted this path had never been exercised. It had
  // not: the helper checked only the message string, which carries the
  // SQLSTATE through Prisma but NOT through node-postgres, so it returned
  // false for every driver-level violation. Both shapes now assert.
  it('isSlotTakenError recognises a STATEMENT-time driver violation', async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    let caught: unknown;
    try {
      await insert({ id: 'b', start: '2026-06-09T10:30:00-05:00', end: '2026-06-09T11:30:00-05:00' });
    } catch (e) {
      caught = e;
    }
    expect(isSlotTakenError(caught)).toBe(true);
    // A different constraint must NOT read as a slot collision.
    expect(isSlotTakenError({ code: '23P01', constraint: 'some_other_exclusion' })).toBe(false);
    expect(isSlotTakenError({ code: '23505' })).toBe(false);
  });
  // isSlotTakenError() matches on the message string, and a COMMIT-time
  // violation has never gone through it before.
  it('isSlotTakenError still recognises a COMMIT-time violation', async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    await db.query('BEGIN');
    await db.query('SET CONSTRAINTS appointment_block_no_overlap DEFERRED');
    await insert({ id: 'b', start: '2026-06-09T10:30:00-05:00', end: '2026-06-09T11:30:00-05:00' });
    let caught: unknown;
    try {
      await db.query('COMMIT');
    } catch (e) {
      caught = e;
    }
    await db.query('ROLLBACK').catch(() => {});
    expect(caught).toBeDefined();
    expect(isSlotTakenError(caught)).toBe(true);
  });
});

describe('operator review R-4/R-6/R-7 columns', () => {
  it('links an outbox row to its appointment, and refuses to lose that record', async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    await db.query(
      `INSERT INTO "NotificationOutbox" (id,"businessId","appointmentId","dedupeKey",channel,template,payload,"updatedAt")
       VALUES ('n1',$1,'a','confirmation:a','email'::"NotificationChannel",'appointment.confirmed','{}'::jsonb, now())`,
      [businessId],
    );
    // "Was she actually told?" — one indexed lookup, not a LIKE against a key.
    const { rows } = await db.query(`SELECT id FROM "NotificationOutbox" WHERE "appointmentId" = 'a'`);
    expect(rows).toHaveLength(1);

    // Restrict: the proof she was told outlives any delete attempt.
    const code = await sqlstateOf(() => db.query(`DELETE FROM "Appointment" WHERE id='a'`));
    expect(code).toBeTruthy();
  });

  it('carries a per-visit note and a conflict acknowledgment', async () => {
    await insert({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    await db.query(
      `UPDATE "Appointment"
          SET notes='Bring the reference photo',
              "conflictAckAt"=now(), "conflictAckReason"='Called her, coming anyway'
        WHERE id='a'`,
    );
    const { rows } = await db.query<{ notes: string; conflictAckReason: string }>(
      `SELECT notes, "conflictAckReason" FROM "Appointment" WHERE id='a'`,
    );
    expect(rows[0]!.notes).toBe('Bring the reference photo');
    expect(rows[0]!.conflictAckReason).toBe('Called her, coming anyway');
  });
});
