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
import { addDays, calendarDay, fromDate, toDate } from '../../core/time';
import { type QualifiedProvider, providersForVisit } from '../qualification';
import { computeDaySlots } from '../scheduling';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface WalkInOption {
  providerId: string;
  providerName: string;
  startAt: Date;
}

/**
 * A-103 — a time the engine REFUSED, offered as a knowing squeeze-in.
 *
 * The same shape as an offer plus the engine's OWN reasons, because that is
 * the difference: BOOK-05's override is an ordinary booking with a reason
 * typed against it, and the desk has to be able to read what it is overriding
 * before it decides. STAFF ONLY — `overlaps-booking` names exactly when a
 * stylist is with a client (spec §1.3).
 */
export interface WalkInSqueeze extends WalkInOption {
  reasons: readonly string[];
}

/** Everything the desk can say to this walk-in — the offer, or the two things
 *  it says instead when there is no offer. */
export interface WalkInSearch {
  /** The day asked about. Carried so the surface can NAME it rather than
   *  saying "today", which stops being true the moment the desk takes the
   *  following-day offer below. */
  day: string;
  /** Who can take her on that day, soonest first. */
  options: WalkInOption[];
  /**
   * "The soonest we can do you is half nine tomorrow" — the first FOLLOWING
   * day anybody qualified could take her, and each one's earliest time on it.
   * `null` when somebody is free on the day asked about, or when nobody can
   * inside the cap.
   */
  nextDay: { day: string; options: WalkInOption[] } | null;
  /** "We could squeeze you in with Dana" — each qualified stylist's earliest
   *  refused candidate on the day asked about, with the reasons it was
   *  refused. Empty when somebody is free. */
  squeeze: WalkInSqueeze[];
}

/**
 * How far forward "how about tomorrow?" looks. A handful of days, not the
 * booking horizon: the search is one engine pass per stylist per day and the
 * answer stops being useful to somebody standing at the desk long before it
 * stops being computable. A salon shut for a fortnight gets nothing here and
 * the day view, which is the right screen for that.
 */
const NEXT_DAY_CAP = 7;

/** Soonest first, then the salon's own column order — the same tiebreak every
 *  provider list on the staff side uses. */
function soonestFirst<T extends WalkInOption & { displayOrder: number }>(rows: T[]): T[] {
  return rows.sort(
    (a, b) =>
      a.startAt.getTime() - b.startAt.getTime() ||
      a.displayOrder - b.displayOrder ||
      a.providerName.localeCompare(b.providerName),
  );
}

/**
 * One engine pass per provider for one day, returning BOTH edges of what it
 * said: the earliest time it offered, and the earliest candidate it refused.
 *
 * ONE pass, deliberately. `slots` and `excluded` are two halves of a single
 * answer, and asking twice — once for the offers, once for the squeeze — is
 * how the two come to disagree about the same minute.
 */
async function earliestEach(
  db: Db,
  args: { businessId: string; serviceIds: readonly string[]; now: Date; holderKey?: string | null },
  providers: readonly QualifiedProvider[],
  day: string,
) {
  const from = fromDate(args.now);
  return Promise.all(
    providers.map(async (provider) => {
      const { slots, excluded } = await computeDaySlots(db, {
        businessId: args.businessId,
        providerId: provider.id,
        serviceIds: args.serviceIds,
        day,
        now: args.now,
        // Staff: no horizon, no lead time (D-21, D-25). The whole point is to
        // book the person standing at the desk.
        audience: 'staff',
        holderKey: args.holderKey ?? null,
      });

      const offered = slots.find((slot) => slot.start >= from);
      // "That time has passed" on its own is the one exclusion nobody can act
      // on, and squeezing somebody into a minute that is gone is not an
      // override — it is a wrong booking with a reason typed against it.
      // A past time that is ALSO occupied stays, with the reason that matters.
      const refused = excluded
        .filter((e) => e.candidateStart >= from && !(e.reasons.length === 1 && e.reasons[0] === 'in-the-past'))
        // Sorted on the INSTANT rather than trusting the engine's order: on
        // fall-back day two candidates share the label "01:30" (D-4).
        .sort((a, b) => a.candidateStart - b.candidateStart)[0];

      return { provider, offered, refused };
    }),
  );
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
  args: {
    businessId: string;
    serviceIds: readonly string[];
    day: string;
    now: Date;
    /** A-083 — WHO would be sitting in the chair, when the desk already knows.
     *  A walk-in the desk has named may be a client who is already in a chair
     *  for something else (D-17's add-on), and A-063 lets her own envelopes
     *  share it. `null`/omitted is the STRICT question — the right one for the
     *  stranger at the door, and wrong for a client the desk has picked. */
    holderKey?: string | null;
  },
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

  return offersFrom(await earliestEach(db, args, providers, args.day));
}

/** The offered half of an `earliestEach` pass, sorted and stripped of the
 *  ordering key. */
function offersFrom(rows: Awaited<ReturnType<typeof earliestEach>>): WalkInOption[] {
  return soonestFirst(
    rows.flatMap(({ provider, offered }) =>
      offered
        ? [
            {
              providerId: provider.id,
              providerName: provider.displayName,
              displayOrder: provider.displayOrder,
              startAt: toDate(offered.start),
            },
          ]
        : [],
    ),
  ).map(({ providerId, providerName, startAt }) => ({ providerId, providerName, startAt }));
}

/**
 * A-103 — THE TWO ANSWERS A FRONT DESK GIVES WHEN THE BOOK IS FULL.
 *
 * `walkInOptions` returning `[]` was a dead end on the screen: "book a time
 * from the day view instead", said to somebody who is physically in the
 * building with cash. The desk's actual answers are "the soonest we can do you
 * is half nine tomorrow" and "we could squeeze you in with Dana" — the second
 * being BOOK-05 on the PROVIDER axis, which A-042 built only on the time axis
 * and recorded as its own left-behind.
 *
 * NEITHER IS A NEW WRITE PATH and neither is a second slot engine. Every time
 * here comes from `computeDaySlots`, exactly as the search it extends does;
 * the squeeze rows are the candidates that engine REFUSED, and booking one
 * goes through the ordinary `bookAppointment` and gets the ordinary refusal,
 * which is what arms BOOK-05's reason box. The override marker only means
 * something because that ceremony stays.
 *
 * THE FALLBACKS ARE COMPUTED HERE RATHER THAN BY THE CALLER, so the rule that
 * makes them safe cannot be forgotten by the next surface that wants them:
 * offering to knowingly double-book Dana while Priya is free at the same time
 * is A-071's defect wearing a different hat, so a non-empty `options` returns
 * NO squeeze at all. One function, one place that decides.
 */
export async function walkInAnswer(
  db: Db,
  args: {
    businessId: string;
    serviceIds: readonly string[];
    day: string;
    now: Date;
    /** The same holder the offered search uses, or the fallback asks a
     *  stricter question than the search it is extending (A-082). */
    holderKey?: string | null;
    /** Days past `day` to look for the next opening. Defaults to a week. */
    daysAhead?: number;
  },
): Promise<WalkInSearch> {
  const providers = await providersForVisit(db, {
    businessId: args.businessId,
    serviceIds: args.serviceIds,
  });
  const empty = { day: args.day, options: [], nextDay: null, squeeze: [] };
  if (providers.length === 0) return empty;

  // ONE pass for the day asked about. `options` and `squeeze` are the two
  // halves of what the engine said about it, and asking twice is how they come
  // to disagree about the same minute.
  const today = await earliestEach(db, args, providers, args.day);
  const options = offersFrom(today);
  if (options.length > 0) return { ...empty, options };

  const squeeze = soonestFirst(
    today.flatMap(({ provider, refused }) =>
      refused
        ? [
            {
              providerId: provider.id,
              providerName: provider.displayName,
              displayOrder: provider.displayOrder,
              startAt: toDate(refused.candidateStart),
              reasons: refused.reasons as readonly string[],
            },
          ]
        : [],
    ),
  ).map(({ providerId, providerName, startAt, reasons }) => ({ providerId, providerName, startAt, reasons }));

  // SEQUENTIAL WITH AN EARLY EXIT, not a fan-out over the whole week: the
  // common answer is "tomorrow", and asking every day in parallel would run
  // providers x 7 engine passes every time to throw six of them away.
  //
  // Walked on the CALENDAR axis (`addDays`), never by adding 86_400_000 ms —
  // across a transition that arithmetic lands an hour off and drifts (spec X-2).
  let day = addDays(calendarDay(args.day), 1);
  for (let ahead = 0; ahead < (args.daysAhead ?? NEXT_DAY_CAP); ahead++) {
    const laterOptions = offersFrom(await earliestEach(db, args, providers, day));
    if (laterOptions.length > 0) return { ...empty, squeeze, nextDay: { day, options: laterOptions } };
    day = addDays(day, 1);
  }

  return { ...empty, squeeze };
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
