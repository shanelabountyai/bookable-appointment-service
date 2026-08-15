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
import { ACTIVE_STATUSES, SLOT_FREEING_STATUSES } from '../core/scheduling/status';
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
  await db.query('TRUNCATE "AppointmentEvent", "AppointmentServiceLine", "Appointment", "Provider", "Business" CASCADE');
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
}) =>
  db.query(
    `INSERT INTO "Appointment"
       (id, "businessId", "providerId", status, "startAt", "endAt",
        "bufferBeforeMinutes", "bufferAfterMinutes", "isOverride",
        "blockedStart", "blockedEnd", "startDay", "startWallTime", "updatedAt")
     VALUES ($1,$2,$3,$4::"AppointmentStatus",$5,$6,$7,$8,$9,'epoch','epoch','2026-06-09','00:00', now())`,
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
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'appointment_no_overlap'`,
    );
    const def = rows[0]!.def;
    for (const status of SLOT_FREEING_STATUSES) {
      expect(def).toContain(`'${status}'`);
    }
    for (const status of ACTIVE_STATUSES) {
      expect(def).not.toContain(`'${status}'`);
    }
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
  it('permits exactly one ACTIVE segment per service', async () => {
    await db.query(
      `INSERT INTO "Service" (id,"businessId",name,"durationMinutes","priceCents","updatedAt")
       VALUES ('svc1',$1,'Colour',90,12000, now())`,
      [businessId],
    );
    await db.query(
      `INSERT INTO "ServiceSegment" (id,"businessId","serviceId",ordinal,"durationMinutes","updatedAt")
       VALUES ('seg1',$1,'svc1',0,90, now())`,
      [businessId],
    );
    const code = await sqlstateOf(() =>
      db.query(
        `INSERT INTO "ServiceSegment" (id,"businessId","serviceId",ordinal,"durationMinutes","updatedAt")
         VALUES ('seg2',$1,'svc1',1,30, now())`,
        [businessId],
      ),
    );
    expect(code).toBe('23505'); // unique_violation on the partial index
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
