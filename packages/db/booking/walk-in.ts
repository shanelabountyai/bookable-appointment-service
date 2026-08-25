/**
 * A-017 — "walk-in, starting now, against the next free provider" (BOOK-04).
 *
 * The question the front desk is actually asking is "who can take her, and
 * when?", so the answer is a provider AND an instant, chosen by the engine
 * rather than by this file: `computeDaySlots` already knows about windows,
 * breaks, buffers, time off and everything else, and a second "is anyone
 * free?" rule here would be a second answer to the same question.
 *
 * "Starting now" means AS SOON AS POSSIBLE, not "at this exact minute". The
 * earliest offered slot is almost never `now` to the second — the grid runs on
 * the salon's interval — and booking off-grid would either mark an ordinary
 * walk-in as a BOOK-05 override or leave a three-minute sliver nobody can
 * sell. Neither is worth it to save the client four minutes in the chair.
 */
import { fromDate, toDate } from '../../core/time';
import { providersForVisit } from '../qualification';
import { computeDaySlots } from '../scheduling';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface WalkInOption {
  providerId: string;
  providerName: string;
  startAt: Date;
}

/**
 * Every provider who could take this visit today, with the earliest time each
 * could start — soonest first.
 *
 * A LIST rather than a single answer: "Priya at 2:15 or Dana at 3:00" is a
 * choice the front desk makes out loud with the client in front of them, and a
 * function that picked for them would be overruled half the time.
 */
export async function walkInOptions(
  db: Db,
  args: { businessId: string; serviceIds: readonly string[]; day: string; now: Date },
): Promise<WalkInOption[]> {
  // A multi-service visit needs ONE provider qualified for ALL of it
  // (VISIT-01: same provider, in order) — not one who happens to do the first.
  // A-056 extracted that counting into `providersForVisit`, because its own
  // "anyone" search needed the identical rule and a second copy is how the two
  // come to disagree about a half-qualified stylist.
  const providers = await providersForVisit(db, {
    businessId: args.businessId,
    serviceIds: args.serviceIds,
  });

  const options = await Promise.all(
    providers.map(async (provider) => {
      const { slots } = await computeDaySlots(db, {
        businessId: args.businessId,
        providerId: provider.id,
        serviceIds: args.serviceIds,
        day: args.day,
        now: args.now,
        // Staff: no horizon, no lead time (D-21, D-25). The whole point is to
        // book the person standing at the desk.
        audience: 'staff',
      });

      const soonest = slots.find((slot) => slot.start >= fromDate(args.now));
      return soonest
        ? {
            providerId: provider.id,
            providerName: provider.displayName,
            displayOrder: provider.displayOrder,
            startAt: toDate(soonest.start),
          }
        : null;
    }),
  );

  return options
    .filter((option): option is NonNullable<typeof option> => option !== null)
    .sort(
      (a, b) =>
        a.startAt.getTime() - b.startAt.getTime() ||
        a.displayOrder - b.displayOrder ||
        a.providerName.localeCompare(b.providerName),
    )
    .map(({ providerId, providerName, startAt }) => ({ providerId, providerName, startAt }));
}

/**
 * D-17's soft note: "this client already has an appointment then."
 *
 * A NOTE, never a refusal. One client may legitimately hold overlapping
 * appointments — mum with Dana and daughter with Priya at 2pm is one phone
 * number and two people, and there is deliberately no client-axis constraint.
 * But a front desk double-booking the SAME person by accident is an ordinary
 * slip, and saying so costs nothing.
 */
export async function clientAlreadyBookedAround(
  db: Db,
  args: { businessId: string; clientId: string; startAt: Date; endAt: Date },
): Promise<{ startAt: Date; providerName: string }[]> {
  const rows = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      clientId: args.clientId,
      status: { notIn: ['cancelled', 'cancelled_late'] },
      startAt: { lt: args.endAt },
      endAt: { gt: args.startAt },
    },
    select: { startAt: true, provider: { select: { displayName: true } } },
    orderBy: { startAt: 'asc' },
  });

  return rows.map((row) => ({ startAt: row.startAt, providerName: row.provider.displayName }));
}
