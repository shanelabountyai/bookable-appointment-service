/**
 * A-056 — "ANYTHING THURSDAY? I DON'T MIND WHO." (SVC-02)
 *
 * The most common call a salon takes, and until this file the product could
 * not answer it. `/staff/book` will not ask for times without a provider, so
 * one day was four passes and "Thursday or Friday" was sixteen — the desk
 * stops doing it and says "let me ring you back", which is a booking lost. The
 * public flow made "Who would you like to see?" a mandatory step with no *no
 * preference* option, so a first-time client who has never heard of Dana or
 * Priya picks the top name or leaves. That is the operator's explanation for
 * the utilization gap A-024's dashboard reports and cannot account for: the
 * senior is solid and the junior is at 40%.
 *
 * SVC-02 has specified this since the master PRD and nothing implemented it.
 * The only hits for the rule before this file were the waitlist's *preference*
 * field, a tiebreak comment, and a UI label.
 *
 * WHAT IT IS NOT: a second slot engine. Every time here comes from
 * `computeDaySlots`, once per qualified provider, exactly as the walk-in
 * search already does. This file merges and CHOOSES; it never decides whether
 * a time is free.
 */
import { ACTIVE_STATUSES } from '../../core/scheduling';
import { fromDate, toDate, toLabel, zoneId } from '../../core/time';
import { type QualifiedProvider, providersForVisit } from '../qualification';
import { computeDaySlots, daysWithAvailability } from '../scheduling';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface AnyProviderTime {
  /** The instant (D-4) — never a `{day, time}` pair. */
  at: Date;
  /** WHO the client would get, already decided by SVC-02's rule. */
  providerId: string;
  providerName: string;
  /** How many qualified stylists are free at this time. The desk reads "3
   *  free at 2" as slack it can offer around; one is a time it should sell
   *  now. Costs nothing — the merge already knows. */
  freeCount: number;
}

/**
 * Every time this visit could start on this day, with ANY qualified stylist —
 * one row per distinct time, naming the person the client would actually get.
 *
 * ONE ROW PER TIME, NOT ONE PER PROVIDER-TIME. Four stylists free at 2pm is
 * one offer to the client ("two o'clock"), not four; a list that repeats every
 * time four times is a list the desk scrolls past. The name on the row is the
 * answer to "who would that be, then?", which is the next question and is
 * asked about half the time.
 *
 * THE ASSIGNMENT IS MADE HERE, AT LIST TIME, AND THE ROW CARRIES IT. The
 * alternative — deciding again on submit — would let the desk read "2 o'clock
 * with Dana" and book Priya, because another booking landed in between. What
 * you see is what you book, and if that provider is taken in the meantime the
 * exclusion constraint refuses it exactly as it refuses any other lost race
 * (D-2). No new write path: this produces a `providerId` and the ordinary
 * `bookAppointment` does the rest.
 */
export async function anyProviderTimes(
  db: Db,
  args: {
    businessId: string;
    serviceIds: readonly string[];
    day: string;
    now: Date;
    /** Staff lifts the horizon and the lead time (D-21, D-25); public does not. */
    audience?: 'public' | 'staff';
  },
): Promise<AnyProviderTime[]> {
  const providers = await providersForVisit(db, { businessId: args.businessId, serviceIds: args.serviceIds });
  if (providers.length === 0) return [];

  const load = await bookedMinutesOn(db, {
    businessId: args.businessId,
    day: args.day,
    providerIds: providers.map((p) => p.id),
  });

  // Per provider, because SVC-02 says the search computes per provider: a
  // junior's longer cut is a different length and therefore a different set of
  // start times, and averaging that would offer times nobody can work.
  const perProvider = await Promise.all(
    providers.map(async (provider) => {
      const { slots } = await computeDaySlots(db, {
        businessId: args.businessId,
        providerId: provider.id,
        serviceIds: args.serviceIds,
        day: args.day,
        now: args.now,
        audience: args.audience ?? 'public',
      });
      return { provider, starts: slots.map((slot) => slot.start) };
    }),
  );

  const byInstant = new Map<number, QualifiedProvider[]>();
  for (const { provider, starts } of perProvider) {
    for (const start of starts) {
      const free = byInstant.get(start) ?? [];
      free.push(provider);
      byInstant.set(start, free);
    }
  }

  return [...byInstant.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, free]) => {
      const chosen = leastBooked(free, load);
      return {
        at: toDate(start as ReturnType<typeof fromDate>),
        providerId: chosen.id,
        providerName: chosen.displayName,
        freeCount: free.length,
      };
    });
}

/**
 * A-071 — WHO ELSE COULD DO IT AT THIS EXACT INSTANT?
 *
 * The other half of A-056's promise, and the half it did not keep. "Anyone at
 * two" means the stylists are interchangeable at two o'clock — that is the
 * entire premise of the row the desk tapped. So when the desk loses the race
 * for the person that row named, the answer is not "that time is not free",
 * and it is certainly not an override that would knowingly double-book her:
 * the answer is the next free stylist, by name, on a button.
 *
 * NOT A SECOND SEARCH. It is `anyProviderTimes` for the day the instant falls
 * on, filtered to that instant — the same merge, the same SVC-02 tiebreak,
 * recomputed against live rows, so whoever has just been taken is simply not
 * in it any more. `null` means nobody qualified is free at that instant, which
 * is exactly when the ordinary refusal-plus-override IS the right answer.
 *
 * The DAY is derived here rather than taken as an argument: two callers need
 * this (the desk and the public flow) and a business date derived twice from
 * one instant is two chances to derive it differently.
 */
export async function anyProviderAt(
  db: Db,
  args: {
    businessId: string;
    serviceIds: readonly string[];
    /** The instant she was promised (D-4), never a `{day, time}` pair. */
    at: Date;
    now: Date;
    audience?: 'public' | 'staff';
  },
): Promise<AnyProviderTime | null> {
  const business = await db.business.findUniqueOrThrow({
    where: { id: args.businessId },
    select: { timezone: true },
  });
  const day = toLabel(fromDate(args.at), zoneId(business.timezone)).day;

  const offered = await anyProviderTimes(db, {
    businessId: args.businessId,
    serviceIds: args.serviceIds,
    day,
    now: args.now,
    ...(args.audience ? { audience: args.audience } : {}),
  });

  const wanted = fromDate(args.at);
  return offered.find((time) => fromDate(time.at) === wanted) ?? null;
}

/**
 * SVC-02's rule, verbatim: the qualified provider with the FEWEST BOOKED
 * MINUTES on that business date, ties broken by `displayOrder`.
 *
 * Deterministic on purpose — the PRD says so in as many words, "so an
 * acceptance test can assert it". `providersForVisit` already returns the list
 * in `displayOrder` then name, so a stable `reduce` over it inherits both
 * tiebreaks without restating either.
 */
function leastBooked(free: QualifiedProvider[], load: Map<string, number>): QualifiedProvider {
  return free.reduce((best, candidate) =>
    (load.get(candidate.id) ?? 0) < (load.get(best.id) ?? 0) ? candidate : best,
  );
}

/**
 * Minutes already booked per provider on one business date.
 *
 * `startDay` rather than a range over instants (P1-6): it is the denormalized
 * business date written by the same code that writes the instants, and it is
 * what "on that business date" in SVC-02 means — the 23:30 appointment that
 * runs past midnight belongs to the day it started, which is the day the
 * stylist worked it.
 *
 * ACTIVE statuses, so a no-show still counts against the stylist's load (D-7):
 * she stood there, the time was hers, and load-balancing the next booking onto
 * her because a client failed to turn up would be balancing on fiction.
 */
async function bookedMinutesOn(
  db: Db,
  args: { businessId: string; day: string; providerIds: string[] },
): Promise<Map<string, number>> {
  const rows = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      providerId: { in: args.providerIds },
      startDay: args.day,
      status: { in: [...ACTIVE_STATUSES] },
    },
    select: { providerId: true, startAt: true, endAt: true },
  });

  const load = new Map<string, number>(args.providerIds.map((id) => [id, 0]));
  for (const row of rows) {
    const minutes = Math.round((fromDate(row.endAt) - fromDate(row.startAt)) / 60_000);
    load.set(row.providerId, (load.get(row.providerId) ?? 0) + minutes);
  }
  return load;
}

/**
 * The days in a range on which ANY qualified stylist could take this visit.
 *
 * The public flow's day list, for the "no preference" path. Built from the
 * same per-provider engine calls rather than a cheaper approximation: a day
 * offered here and empty when opened is worse than a day not offered.
 */
export async function anyProviderDays(
  db: Db,
  args: {
    businessId: string;
    serviceIds: readonly string[];
    fromDay: string;
    toDay: string;
    now: Date;
    audience?: 'public' | 'staff';
  },
): Promise<string[]> {
  const providers = await providersForVisit(db, { businessId: args.businessId, serviceIds: args.serviceIds });
  if (providers.length === 0) return [];

  const perProvider = await Promise.all(
    providers.map((provider) =>
      daysWithAvailability(db, {
        businessId: args.businessId,
        providerId: provider.id,
        serviceIds: args.serviceIds,
        fromDay: args.fromDay,
        toDay: args.toDay,
        now: args.now,
        audience: args.audience ?? 'public',
      }),
    ),
  );

  return [...new Set(perProvider.flat())].sort();
}
