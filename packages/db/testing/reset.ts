/**
 * The one way a database test resets state.
 *
 * WHY THIS EXISTS. Each DB test file used to clear its own tables with
 * `deleteMany()` in a hand-maintained order. That is wrong twice over:
 *
 *  1. It is ORDER-DEPENDENT ACROSS FILES. A file that clears Provider but not
 *     Appointment leaves rows that make the NEXT file's Provider delete fail
 *     with `Appointment_providerId_fkey`. That is exactly how CI broke: the
 *     TZ=UTC run left appointments behind and the TZ=Pacific/Kiritimati run —
 *     same code, same database, second in line — failed all 20 settings tests
 *     in its `beforeEach`. It read like a timezone bug and was not one.
 *  2. `deleteMany()` CANNOT clear `AppointmentEvent` at all: it is append-only
 *     by trigger, and the trigger refuses DELETE. TRUNCATE does not fire
 *     row-level triggers, which is the only reason a test can reset it.
 *
 * `TRUNCATE ... CASCADE` in a single statement resolves the order itself, so
 * no caller has to know the foreign-key graph or what ran before it.
 */
import type { PrismaClient } from '../generated/client/index.js';

/**
 * Every table, in one statement. CASCADE handles the dependency order.
 *
 * Listed explicitly rather than discovered from `information_schema`, because
 * a query that finds every table also finds `_prisma_migrations` if you get
 * its filter slightly wrong, and truncating that turns a test run into a
 * re-migration.
 *
 * THIS COMMENT USED TO CLAIM A NEW TABLE WOULD "FAIL LOUDLY HERE (leftover
 * rows in an unlisted table)". It would not, and demo checkpoint 4 measured
 * it: `TRUNCATE ... CASCADE` also truncates every table holding a foreign key
 * INTO one that is listed, whatever that key's `ON DELETE` says. An
 * `AppointmentSeries` row written before a reset (a table absent from this
 * list since A-049) was gone after it — silently, which is the opposite of
 * loudly.
 *
 * So the list is not a safety net; it is an INVENTORY of what a reset is
 * ASKED to clear — not of everything it reaches. CASCADE reaches more, and
 * naming a table has a cost: see the note inside the list. A new table only
 * needs adding here when nothing already listed leads to it.
 */
const TABLES = [
  'AppointmentEvent',
  'AppointmentServiceLine',
  'NotificationOutbox',
  'ManageToken',
  'Appointment',
  // DELIBERATELY NOT LISTED, and this is the interesting part:
  // `AppointmentBlock`, `AppointmentResourceHold` and `AppointmentSeries`.
  //
  // Demo checkpoint 4 added them "to complete the inventory" and it was a
  // behaviour change, not documentation: TRUNCATE takes an ACCESS EXCLUSIVE
  // lock on every table it NAMES, so listing them widened the lock set. The
  // first two are written by TRIGGERS inside a booking transaction, which
  // already holds a ROW EXCLUSIVE lock on `Appointment` — so a reset racing a
  // booking deadlocked (40P01), each waiting for the other's table. It
  // reproduced as 28 failures across four files and, being timing-dependent,
  // it passed the gate that shipped it.
  //
  // CASCADE reaches all three anyway, which is what checkpoint 4 measured in
  // the first place. Naming them buys nothing and costs a deadlock against
  // exactly the concurrent transactions `races.test.ts` exists to create.
  'WaitlistEntry',
  'Client',
  'WindowBreak',
  'DateOverrideWindow',
  'DateOverride',
  'WeeklyWindow',
  'TimeOff',
  'AdHocBlock',
  'ServiceProvider',
  'ServiceSegment',
  'Service',
  'Resource',
  'ResourceType',
  'Provider',
  'StaffUser',
  'Business',
  // Infrastructure, no foreign keys — but a counter left at its limit by one
  // test would refuse the next test's first request.
  'RateLimitCounter',
] as const;

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
