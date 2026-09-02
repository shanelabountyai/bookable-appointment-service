/**
 * A-073 — THE CLIENTS WHO HAVE STOPPED COMING (RPT-01, CLIENT-02).
 *
 * Tuesday is at 45% and the owner has no list to ring. Three hundred clients,
 * eighty of them on a six-week cycle who have not been in for fourteen weeks,
 * and the only way to find them today is to read the client list one record at
 * a time. A-040 fixed the other half of this — rebooking at the checkout —
 * and this is the largest untapped lever left.
 *
 * WHAT "LAPSED" MEANS HERE, precisely, because a wrong definition produces a
 * list that wastes the owner's afternoon:
 *
 *   * her last COMPLETED visit is older than N weeks. Not `booked` and not
 *     `no_show`: a no-show is not evidence she was in, and counting it would
 *     hide somebody who has genuinely stopped coming behind an appointment she
 *     did not attend.
 *   * she has nothing in the book AHEAD of `now`, in any active status. A
 *     client with a colour on Thursday is not lapsed however long ago she last
 *     sat down, and ringing her is the call that makes a salon look careless.
 *   * she is not flagged. A no-show-blocked client is not who you ring to fill
 *     a Tuesday (the row's own words), and offering her time is the opposite
 *     of what CLIENT-04's counter is for.
 *   * she has not been merged away. A tombstone is not a person to ring.
 *
 * N IS A NUMBER ON THE REPORT, not a setting (the row is explicit): a salon
 * with a six-week cycle and one with a twelve-week cycle both want to slide it
 * while looking at the answer, and a settings page nobody tunes is a setting
 * that is always wrong.
 *
 * ORDERED LONGEST-LAPSED FIRST, with her value beside it rather than as the
 * sort: "who have we lost?" is the question, and sorting by spend puts the
 * client who came once for a fringe trim below the one who came twice for a
 * cut — which is true and useless. The owner reads the money on the row.
 */
import { ACTIVE_STATUSES, MISSED_STATUSES } from '../../core/scheduling';
import { reliabilityWindowStart } from '../../core/clients';
import { calendarDay, fromDate, instant, toDate, toLabel, zoneId } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

const WEEK_MS = 7 * 86_400_000;

/** The default N, and the reason it is six: the salon's own colour cycle is
 *  six weeks, so twelve is two missed appointments — long enough that she has
 *  noticed, short enough that she has not found somebody else. */
export const LAPSED_WEEKS = 12;

export interface LapsedClient {
  clientId: string;
  name: string | null;
  phone: string | null;
  /** Her last completed visit — the one the call is about. */
  lastVisitAt: Date;
  weeksSince: number;
  lastProviderName: string;
  lastServiceNames: string[];
  /** What that visit was worth, from its OWN line prices (D-16's reflex —
   *  never the live catalogue, which has moved since). */
  lastSpendCents: number;
  /** A-073 hangs the call marks off this, so the report remembers who has
   *  been rung. The FK needs an appointment, and hers is the visit above. */
  lastAppointmentId: string;
}

/**
 * Clients whose last completed visit is older than `weeks` and who have
 * nothing booked, longest-lapsed first.
 *
 * `now` is injected, never read from the clock here — the same discipline as
 * `listOpenedSlots` and `clientReliability`.
 */
export async function listLapsedClients(
  db: Db,
  args: { businessId: string; now: Date; weeks?: number; limit?: number },
): Promise<LapsedClient[]> {
  const weeks = args.weeks ?? LAPSED_WEEKS;
  const cutoff = toDate(instant(fromDate(args.now) - weeks * WEEK_MS));

  // ONE ROW PER CLIENT — her most recent completed visit. Grouping in the
  // database rather than reading every appointment: three hundred clients with
  // six years of history behind them is a table scan the report does not need.
  const lastVisits = await db.appointment.groupBy({
    by: ['clientId'],
    where: {
      businessId: args.businessId,
      status: 'completed',
      clientId: { not: null },
    },
    _max: { startAt: true },
  });

  const lapsed = lastVisits.flatMap((row) =>
    row.clientId && row._max.startAt && fromDate(row._max.startAt) < fromDate(cutoff)
      ? [{ clientId: row.clientId, lastVisitAt: row._max.startAt }]
      : [],
  );
  if (lapsed.length === 0) return [];

  // BOUND — nothing in the book ahead of now, in any ACTIVE status. Derived
  // from the status module, never hand-typed: a cancellation does not make her
  // un-lapsed, and a `no_show` on Thursday does not mean she is coming.
  const booked = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      clientId: { in: lapsed.map((row) => row.clientId) },
      status: { in: [...ACTIVE_STATUSES] },
      startAt: { gt: args.now },
    },
    select: { clientId: true },
    distinct: ['clientId'],
  });
  const hasSomethingBooked = new Set(booked.flatMap((row) => (row.clientId ? [row.clientId] : [])));

  // BOUND — not flagged. "A no-show-blocked client is not who you ring to fill
  // a Tuesday."
  //
  // A-077: the window is CLIENT-04's, taken from the module that owns it. The
  // first version of this hand-rolled `52 * WEEK_MS` against the INSTANT axis,
  // which was a second copy of the reliability window living outside
  // `reliabilityWindowStart` — the status-enum rule wearing a different hat,
  // and it disagreed with `reliability.ts` on the axis as well as the source:
  // that one filters `startDay` on the salon's calendar, and fifty-two weeks is
  // not a year across a leap day. One call, one window, one axis.
  const business = await db.business.findUniqueOrThrow({
    where: { id: args.businessId },
    select: { timezone: true },
  });
  const today = calendarDay(toLabel(fromDate(args.now), zoneId(business.timezone)).day);
  const flagged = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      clientId: { in: lapsed.map((row) => row.clientId) },
      status: { in: [...MISSED_STATUSES] },
      startDay: { gte: reliabilityWindowStart(today) as string },
    },
    select: { clientId: true },
    distinct: ['clientId'],
  });
  const hasMissed = new Set(flagged.flatMap((row) => (row.clientId ? [row.clientId] : [])));

  const candidates = lapsed.filter(
    (row) => !hasSomethingBooked.has(row.clientId) && !hasMissed.has(row.clientId),
  );
  if (candidates.length === 0) return [];

  const clients = await db.client.findMany({
    where: {
      id: { in: candidates.map((row) => row.clientId) },
      businessId: args.businessId,
      // A tombstone is not a person to ring: her history is on the survivor.
      mergedIntoClientId: null,
    },
    select: { id: true, name: true, phone: true },
  });
  const byId = new Map(clients.map((client) => [client.id, client]));

  // The visit itself, for the sentence the owner reads: who she saw, what she
  // had, what it was worth. One query for the lot, matched on (client, start)
  // rather than one read per row.
  const visits = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      status: 'completed',
      OR: candidates
        .filter((row) => byId.has(row.clientId))
        .map((row) => ({ clientId: row.clientId, startAt: row.lastVisitAt })),
    },
    select: {
      id: true,
      clientId: true,
      startAt: true,
      provider: { select: { displayName: true } },
      lines: { orderBy: { ordinal: 'asc' }, select: { priceCents: true, service: { select: { name: true } } } },
    },
  });
  const visitFor = new Map(visits.flatMap((v) => (v.clientId ? [[v.clientId, v] as const] : [])));

  const rows = candidates.flatMap((row) => {
    const client = byId.get(row.clientId);
    const visit = visitFor.get(row.clientId);
    if (!client || !visit) return [];
    return [
      {
        clientId: client.id,
        name: client.name,
        phone: client.phone,
        lastVisitAt: row.lastVisitAt,
        weeksSince: Math.floor((fromDate(args.now) - fromDate(row.lastVisitAt)) / WEEK_MS),
        lastProviderName: visit.provider.displayName,
        lastServiceNames: visit.lines.map((line) => line.service.name),
        // Her OWN line prices (D-16): the catalogue has moved since, and
        // "she was worth £140" has to mean what she actually paid.
        lastSpendCents: visit.lines.reduce((total, line) => total + line.priceCents, 0),
        lastAppointmentId: visit.id,
      },
    ];
  });

  rows.sort(
    (a, b) => fromDate(a.lastVisitAt) - fromDate(b.lastVisitAt) || (a.name ?? '').localeCompare(b.name ?? ''),
  );
  return args.limit ? rows.slice(0, args.limit) : rows;
}

/**
 * A-077 — has this call gone stale?
 *
 * A-072's marks were designed for a freed slot, which dies on Thursday at 2, so
 * a mark against one is days old at most. The `lapsed` subject is **one row per
 * client, forever**, and the lapsed round is a quarterly errand — so in October
 * the owner reads "left a message — Priya" beside a name, from a call Priya
 * made in June, and skips her. That is A-061's original defect (a list that
 * lies about what has been done) inverted: not a missing memory, a memory with
 * no expiry.
 *
 * THE REPORT'S OWN WINDOW IS THE RULE. `weeks` is already the owner's answer to
 * "how long without a visit is too long"; it is the same answer to "how long
 * before a call stops counting as having been made". A second number to tune
 * would be a second number nobody tunes.
 *
 * Nothing stored and nothing cleared, exactly as A-059's `stale` is: derived on
 * every read from `calledAt`, so a mark cannot rot into a wrong answer. The
 * mark itself is never deleted — somebody did make that call.
 */
export function isCallStale(calledAt: Date, now: Date, weeks: number): boolean {
  return fromDate(now) - fromDate(calledAt) > weeks * WEEK_MS;
}
