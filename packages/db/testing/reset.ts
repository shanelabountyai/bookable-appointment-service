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
 * Listed explicitly rather than discovered from `information_schema`: a new
 * table should fail loudly here (leftover rows in an unlisted table) rather
 * than be silently skipped by a query that also silently skips
 * `_prisma_migrations` if you get its filter slightly wrong.
 */
const TABLES = [
  'AppointmentEvent',
  'AppointmentServiceLine',
  'NotificationOutbox',
  'ManageToken',
  'Appointment',
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
] as const;

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
