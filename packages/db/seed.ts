/**
 * The seed entry point: setup (A-025) then density (A-011), in that order.
 *
 * `db:reset:test` now runs this, so a reset produces a REALISTIC book rather
 * than an empty schema — which is the whole point of moving A-011 ahead of the
 * customer UI (operator S-1): every screen built next is built against a full
 * day, a day with one slot left, and the doubled fall-back hour.
 *
 * Wrapped in main() rather than using top-level await: tsx transpiles this to
 * CJS, where top-level await is not available.
 */
import { PrismaClient } from './generated/client/index.js';
import { seedDensity, seedSetup } from './settings';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const setup = await seedSetup(prisma);
    const density = await seedDensity(prisma);
    console.info(
      `[seed] ${setup.providerIds.length} providers, ${setup.serviceIds.length} services, ` +
        `${density.appointmentsCreated} appointments, ${density.clientsCreated} clients ` +
        `(spring-forward ${density.springForwardCount}, fall-back ${density.fallBackCount}; ` +
        `${density.recentDays.length} days around today, ${density.leftUnfinished} left open; ` +
        // A-095. Every one of these was ZERO on a book of 411 appointments, and
        // the log said nothing about it — the same silence that let the total
        // under-report itself by three. A number that is printed is a number
        // somebody can notice going to zero.
        `${density.waitlistEntries} on the waitlist, ${density.callMarks} call marks, ` +
        `${density.callDownAttempts} call-down attempts, ${density.lapsedClients} lapsed; ` +
        // A-108. This was zero on every install ever made, and nothing said so.
        `${density.dispatched} messages sent, ` +
        // A-113. Zero overlapping pairs on every install, so A-099's lanes
        // had nothing to draw on the demo book.
        `${density.overrides} double-booked by override)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] failed', error);
  process.exitCode = 1;
});
