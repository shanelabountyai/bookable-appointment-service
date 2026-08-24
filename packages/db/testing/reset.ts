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
 * So the list is not a safety net; it is an INVENTORY, and its value is that
 * a reader can see what a reset touches. Keep it complete when a table is
 * added — nothing will tell you if you forget.
 */
const TABLES = [
  'AppointmentEvent',
  'AppointmentServiceLine',
  'NotificationOutbox',
  'ManageToken',
  // These three were absent until demo checkpoint 4 found the comment above
  // was wrong: CASCADE had been clearing them all along, which is correct
  // behaviour and was accidental documentation.
  'AppointmentResourceHold',
  'AppointmentBlock',
  'Appointment',
  'AppointmentSeries',
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
