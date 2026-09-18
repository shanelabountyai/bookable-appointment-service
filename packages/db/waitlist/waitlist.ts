/**
 * A-023 — waitlist entries and fit-aware matching (WAIT-01, WAIT-02).
 *
 * v1 is the staff panel only: entries, and "who wants this slot?" for one
 * freed interval. Automated offer-with-soft-hold is OQ-4's follow-on and
 * touches none of this — this module never SENDS anything, it only answers
 * "who".
 */
import { DAY_PART_TAGS, matchesDayParts, tagsFor } from '../../core/waitlist';
import { fromDate, toDate, toLabel, zoneId } from '../../core/time';
import { effectiveDurationMinutes, effectivePriceCents, fitsFreedSpan, serviceFootprintMinutes } from '../../core/settings';
import { composeVisit } from '../../core/scheduling';
import { anyProviderTimes } from '../booking/any-provider';
import { type FreeRun, freedSpanNow } from '../day/free-runs';
import { computeDaySlots } from '../scheduling';
import type { Prisma, PrismaClient, WaitlistStatus } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export class WaitlistEntryRejected extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'WaitlistEntryRejected';
    this.field = field;
  }
}

export interface WaitlistEntryRow {
  id: string;
  clientId: string;
  clientName: string | null;
  clientPhone: string | null;
  /** D-56 — the whole visit, in its order. */
  serviceIds: string[];
  serviceNames: string[];
  providerIds: string[];
  fromDay: string;
  toDay: string;
  dayParts: string[];
  status: WaitlistStatus;
  createdAt: Date;
}

const rowSelect = {
  id: true,
  clientId: true,
  serviceIds: true,
  providerIds: true,
  fromDay: true,
  toDay: true,
  dayParts: true,
  status: true,
  createdAt: true,
  client: { select: { name: true, phone: true } },
} as const;

type RawRow = Prisma.WaitlistEntryGetPayload<{ select: typeof rowSelect }>;

/** D-56 — the names, from ONE read of the catalogue rather than a relation
 *  the array column can no longer carry. A service that has gone renders as
 *  its own absence rather than vanishing from the list, because a line the
 *  matcher can never fit is exactly what whoever rings her needs to see. */
function shape(row: RawRow, names: Map<string, string>): WaitlistEntryRow {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.client.name,
    clientPhone: row.client.phone,
    serviceIds: row.serviceIds,
    serviceNames: row.serviceIds.map((id) => names.get(id) ?? 'A service that has gone'),
    providerIds: row.providerIds,
    fromDay: row.fromDay,
    toDay: row.toDay,
    dayParts: row.dayParts,
    status: row.status,
    createdAt: row.createdAt,
  };
}

async function serviceNames(db: Db, businessId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.service.findMany({
    where: { businessId, id: { in: [...new Set(ids)] } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * A-110 — WAIT-02's EXPIRY, AND IT IS THE ONE COPY OF IT.
 *
 * `expired` is in the enum and nothing in this repo has ever written it, so
 * an entry whose own `toDay` was in June sat on the September queue looking
 * exactly like somebody to ring — while `matchFreedSlot` below, which has
 * read `toDay` directly since A-023, correctly refused to match her. Silently
 * dead and visibly live: two halves of one feature answering "is this entry
 * still open?" two different ways, which is this repo's most-repeated defect.
 *
 * DERIVED ON EVERY READ, NEVER STAMPED BY A JOB. A job is a second write path
 * that eventually disagrees with the read (A-077's shape for the lapsed call
 * marks), and it would have to run before every one of these queries to be
 * worth trusting anyway.
 *
 * NOT the same predicate as "covers this day" — the listing must still show
 * an entry whose window opens next month, so only the closing edge is shared.
 */
const notExpiredOn = (day: string) => ({ toDay: { gte: day } });

/** The live queue — everything staff need to work it, oldest first (first
 *  come, first offered, whenever someone gets to calling).
 *
 *  `today` is the business's own calendar day, passed in: nothing here reads
 *  a clock, and the day this expires against is a CalendarDay in the salon's
 *  zone, never the server's. */
export async function listWaitlistEntries(
  db: Db,
  args: { businessId: string; today: string; status?: WaitlistStatus },
): Promise<WaitlistEntryRow[]> {
  const status = args.status ?? 'active';
  const rows = await db.waitlistEntry.findMany({
    where: {
      businessId: args.businessId,
      status,
      // Only an `active` entry can lapse. A fulfilled one stays fulfilled
      // however long ago its window was, and hiding it would make the status
      // filter lie about history.
      ...(status === 'active' ? notExpiredOn(args.today) : {}),
    },
    orderBy: { createdAt: 'asc' },
    select: rowSelect,
  });
  const names = await serviceNames(db, args.businessId, rows.flatMap((row) => row.serviceIds));
  return rows.map((row) => shape(row, names));
}

export interface CreateWaitlistEntryInput {
  businessId: string;
  clientId: string;
  /** D-56 — the whole visit she was refused, in ITS order (VISIT-01). At
   *  least one; a duplicate is refused rather than composed twice. */
  serviceIds: string[];
  /** Empty = any qualified provider. */
  providerIds: string[];
  fromDay: string;
  toDay: string;
  dayParts: string[];
}

export async function createWaitlistEntry(db: Db, input: CreateWaitlistEntryInput): Promise<WaitlistEntryRow> {
  if (input.fromDay > input.toDay) {
    throw new WaitlistEntryRejected('toDay', 'That range ends before it starts.');
  }
  const badTag = input.dayParts.find((tag) => !(DAY_PART_TAGS as readonly string[]).includes(tag));
  if (badTag) throw new WaitlistEntryRejected('dayParts', `Not a day-part: ${badTag}`);
  // D-56. An entry with no services is one `matchFreedSlot` composes to a
  // zero footprint, which fits every span that ever frees — she would be
  // offered the whole book, forever. The database's column cannot say this
  // (an empty array is a legal TEXT[]), so this is the guard.
  if (input.serviceIds.length === 0) throw new WaitlistEntryRejected('serviceIds', 'An entry needs a service.');
  if (new Set(input.serviceIds).size !== input.serviceIds.length) {
    throw new WaitlistEntryRejected('serviceIds', 'That service is on the visit twice.');
  }

  const [client, services, providers] = await Promise.all([
    db.client.findFirst({ where: { id: input.clientId, businessId: input.businessId } }),
    db.service.findMany({
      where: { id: { in: input.serviceIds }, businessId: input.businessId },
      select: { id: true },
    }),
    input.providerIds.length
      ? db.provider.findMany({ where: { id: { in: input.providerIds }, businessId: input.businessId } })
      : Promise.resolve([]),
  ]);
  if (!client) throw new WaitlistEntryRejected('clientId', 'No such client.');
  if (services.length !== input.serviceIds.length) throw new WaitlistEntryRejected('serviceIds', 'No such service.');
  if (providers.length !== input.providerIds.length) {
    throw new WaitlistEntryRejected('providerIds', 'One of those is not on the roster.');
  }

  const row = await db.waitlistEntry.create({
    data: {
      businessId: input.businessId,
      clientId: input.clientId,
      // Stored in the ORDER she asked for, because D-23's footprint takes
      // the first line's `bufferBefore` and the last line's `bufferAfter` —
      // sorting these would quietly re-price the visit.
      serviceIds: input.serviceIds,
      providerIds: input.providerIds,
      fromDay: input.fromDay,
      toDay: input.toDay,
      dayParts: input.dayParts,
    },
    select: rowSelect,
  });
  return shape(row, await serviceNames(db, input.businessId, row.serviceIds));
}

/** The whole lifecycle in one setter — `active → fulfilled | expired |
 *  cancelled` — because there is exactly one reader of the status column
 *  today and a status-transition table for a four-value enum with one
 *  reader is the abstraction CLAUDE.md's status-module rule exists to avoid
 *  building before it earns its keep. */
export async function setWaitlistEntryStatus(
  db: Db,
  args: { businessId: string; entryId: string; status: WaitlistStatus },
): Promise<void> {
  await db.waitlistEntry.updateMany({
    where: { id: args.entryId, businessId: args.businessId },
    data: { status: args.status },
  });
}

export interface FreedSlot {
  businessId: string;
  providerId: string;
  /**
   * A-124/D-60 — THE RANGE, AS INSTANTS, AND NOTHING ELSE.
   *
   * This was `{ day, time, freedMinutes }`, and the minutes were the length of
   * the appointment that left. Both halves are gone: `freedMinutes` was
   * compared against a composed footprint without ever asking the book, and
   * the wall-clock pair is the one shape CLAUDE.md forbids a payload to carry
   * (D-4 — on fall-back day "01:30" names two instants).
   *
   * What arrives here is the REMAINDER `/staff/opened` and the appointment
   * page derived (`freedSpanNow`). The run around it, which is what actually
   * gets sold, is derived again here from the same function rather than
   * trusted from a URL: a span stops being free the moment somebody books it,
   * and this screen is read minutes after the link was drawn.
   */
  from: Date;
  to: Date;
  /** Injected, never read from a clock here — the engine below takes it and
   *  applies its own lead time (`packages/core` reads no clock at all). */
  now: Date;
}

export interface MatchedEntry {
  id: string;
  clientId: string;
  clientName: string | null;
  clientPhone: string | null;
  /** D-56 — what she is waiting for, in its order. On this list it is no
   *  longer whatever freed the span, so the person ringing her cannot infer
   *  it from the heading and the Book link cannot either. */
  serviceIds: string[];
  serviceNames: string[];
  /** Her whole visit at THIS provider, buffers included (D-23) — the number
   *  that had to fit. On the screen it is what makes "three hours free, she
   *  needs 185 minutes" a sentence the desk can check. */
  footprintMinutes: number;
  /**
   * A-124/D-60 — THE INSTANT THE ENGINE ACTUALLY OFFERED HER, per entry.
   *
   * The Book link used to carry the freed span's own start for everybody,
   * which is the instant the write refuses the moment anything is sold into
   * the front of the range — the offered-then-refused shape, on the screen the
   * desk makes phone calls from. It is per-entry because it has to be: two
   * waiting clients with different visits fit the same run at different
   * starts, and the grid interval anchors at window open, so a span can fit by
   * minutes and still have no start the engine will sell.
   */
  startAt: Date;
  fromDay: string;
  toDay: string;
  dayParts: string[];
  createdAt: Date;
}

/**
 * WAIT-01/02 — "who wants this slot?", for one freed interval on one provider.
 *
 * D-56 (A-119) — WHAT A FREED SPAN MATCHES, AND IT IS NO LONGER A SERVICE.
 *
 * This used to filter `serviceId: freed.serviceId` in SQL and then measure
 * that ONE service against the span. Both halves were wrong for the salon's
 * most valuable booking, in opposite directions: a Cut+Colour waitlisted as
 * `Cut` MATCHED a 55-minute freed cut that cannot hold her appointment, and
 * was NOT offered a 190-minute span that holds the whole of it. Half the
 * sample business's Saturday book is cut + colour (D-23).
 *
 * So the question is now the one the WRITE will ask when the desk books her:
 * can this provider do every line, and does the whole visit fit? The span is
 * the perishable thing, not the service that freed it — the same move A-109
 * made on `/staff/opened` ("can this salon sell this span to anything").
 *
 * A-124 (D-60) — AND THE OTHER HALF OF THAT QUESTION IS THE BOOK, WHICH THIS
 * WAS STILL NOT ASKING.
 *
 * D-56 answered "the whole visit" for the CLIENT and then substituted a
 * subtraction for the salon: `fitsFreedSpan(footprint, freedMinutes)`, a
 * minutes comparison against the length of the appointment that left. That is
 * exactly checkpoint 6's rule one screen over — *a read model that predicts a
 * chooser's answer must ask the chooser's question* — and it was wrong in both
 * directions at once. Too STRICT: a 55-minute cancellation on an otherwise
 * empty morning is three hours of sellable time, and a 185-minute cut and
 * colour was told nobody fits while the write accepted her at its start. Too
 * LOOSE: a range with a blow-dry sold into its front still measured its
 * original length, so the panel named a client and handed the desk a Book
 * button the database refused.
 *
 * So the comparison is gone and the ENGINE decides, through `computeSlotsIn`
 * — which exists (A-082) so that no offering surface can go around it, and
 * this one did. That brings the grid interval, the lead time, breaks, close,
 * the per-provider duration override and the room (`canSeat`) along for free,
 * which is the exact list of things a minutes comparison cannot see.
 *
 * THE RUN IS THE BOUND, NOT THE TEST. `freedSpanNow` derives the contiguous
 * free run the freed range now lives in; a candidate matches when the engine
 * offers a start for her WHOLE visit whose blocked range lies inside that run.
 * (Inside, not merely overlapping: an offered range is wholly free and
 * contiguous, so overlapping a MAXIMAL free run means containment. That is
 * also why the run's length is a sound cheap pre-filter.)
 *
 * THE FIT IS PER-ENTRY, SO THE READS ARE PER-SPAN. Every candidate can want a
 * different visit, but they all want it from the SAME provider — the one whose
 * time opened up — so one read of her qualifications carries the duration
 * override (SVC-02) and the buffers for every line of every candidate.
 * `composeVisit` is D-23's one copy of the composition rule and this calls it
 * rather than re-adding the buffers.
 *
 * DAY-PARTS ARE JUDGED ON THE OFFERED START, not on the freed one. "Mornings
 * only" is a statement about the appointment she would get, and on a run that
 * straddles noon those are two different answers.
 *
 * A LINE SHE IS NOT QUALIFIED FOR IS A REFUSAL, NOT A ZERO. An entry naming a
 * service this provider does not do (or one that has since been retired) has
 * no footprint at her chair at all, and dropping the line would compose a
 * SHORTER visit that fits more spans — the offered-then-refused class this
 * repo has caught four times. It is `null`, and `null` does not fit.
 */
/**
 * A-124/D-60 — the answer, and WHAT IT WAS ANSWERED ABOUT.
 *
 * `span` is `null` when there is nothing left to sell: wholly past, resold, or
 * the stylist is no longer working that day. Every door into this function has
 * to word that rather than draw a Book button, so the fact travels with the
 * list instead of being re-derived by each screen a moment later.
 */
export interface FreedSlotMatches {
  span: { run: FreeRun; remainder: FreeRun } | null;
  entries: MatchedEntry[];
}

export async function matchFreedSlot(db: Db, freed: FreedSlot): Promise<FreedSlotMatches> {
  const [business, provider] = await Promise.all([
    db.business.findUniqueOrThrow({ where: { id: freed.businessId }, select: { timezone: true } }),
    db.provider.findFirst({
      where: { id: freed.providerId, businessId: freed.businessId },
      select: { active: true },
    }),
  ]);
  if (provider === null) return { span: null, entries: [] };
  const zone = zoneId(business.timezone);

  // D-60 — THE RUN, DERIVED HERE AND NOT TAKEN FROM THE LINK. `null` is "there
  // is nothing left of it": wholly past, resold, or the stylist is off that
  // day now. Both doors word that rather than offering anybody.
  const span = await freedSpanNow(db, {
    businessId: freed.businessId,
    providerId: freed.providerId,
    timezone: business.timezone,
    blockedStart: freed.from,
    blockedEnd: freed.to,
    now: freed.now,
  });
  if (span === null) return { span: null, entries: [] };
  const runStart = fromDate(span.run.start);
  const runEnd = fromDate(span.run.end);
  // The day the entry's own date range is asked about: the freed range's, in
  // the salon's calendar, never the server's.
  const day = toLabel(fromDate(span.remainder.start), zone).day;

  const candidates = await db.waitlistEntry.findMany({
    where: {
      businessId: freed.businessId,
      status: 'active',
      fromDay: { lte: day },
      // A-110 — the same closing edge the standing queue now filters on.
      ...notExpiredOn(day),
      OR: [{ providerIds: { isEmpty: true } }, { providerIds: { has: freed.providerId } }],
    },
    select: {
      id: true,
      clientId: true,
      serviceIds: true,
      fromDay: true,
      toDay: true,
      dayParts: true,
      createdAt: true,
      client: { select: { name: true, phone: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (candidates.length === 0) return { span, entries: [] };

  // EVERYTHING THIS PROVIDER CAN DO, AND WHAT IT COSTS *HER* (SVC-02): the
  // junior stylist's longer cut composes at her duration, not the
  // catalogue's. One read for the whole list — the candidates differ in what
  // they want, never in whose time this is.
  const qualified = new Map(
    (
      await db.serviceProvider.findMany({
        where: { businessId: freed.businessId, providerId: freed.providerId },
        select: {
          serviceId: true,
          durationOverrideMinutes: true,
          priceOverrideCents: true,
          service: {
            select: {
              // The NAME rides along on the read that was happening anyway:
              // only a qualified line can reach the row below, so there is
              // no second catalogue lookup to do here.
              name: true,
              durationMinutes: true,
              bufferBeforeMinutes: true,
              bufferAfterMinutes: true,
              priceCents: true,
            },
          },
        },
      })
    ).map((row) => [row.serviceId, row]),
  );

  /** D-23's footprint for one entry at this provider, or `null` when she
   *  cannot do all of it. Price is carried only because `composeVisit` owns
   *  the composition rule and asks for it — nothing here reads the total. */
  const footprintFor = (serviceIds: string[]): { footprintMinutes: number; bodyMinutes: number } | null => {
    const lines = serviceIds.map((serviceId) => {
      const q = qualified.get(serviceId);
      return q === undefined
        ? null
        : {
            serviceId,
            // SVC-02's resolvers, not a fourth copy of `?? base`.
            durationMinutes: effectiveDurationMinutes(q.service.durationMinutes, q.durationOverrideMinutes),
            bufferBeforeMinutes: q.service.bufferBeforeMinutes,
            bufferAfterMinutes: q.service.bufferAfterMinutes,
            priceCents: effectivePriceCents(q.service.priceCents, q.priceOverrideCents),
          };
    });
    if (lines.length === 0 || lines.some((line) => line === null)) return null;
    const visit = composeVisit(lines as NonNullable<(typeof lines)[number]>[]);
    // Both numbers, because they answer different questions. The FOOTPRINT is
    // what the desk reads beside her name ("she needs 185 minutes"); the BODY
    // is the cheap bound on the run, because the body is what has to sit
    // inside it.
    return { footprintMinutes: serviceFootprintMinutes(visit), bodyMinutes: visit.durationMinutes };
  };

  /**
   * D-60 — THE ENGINE'S ANSWER FOR ONE WAITING CLIENT, or `null`.
   *
   * `holderKey` is her client id, not the default. The default is the STRICT
   * question — "could an anonymous stranger sit there?" — and a caller that
   * keeps it compiles, passes, and silently asks a question it already knows
   * the answer to (CLAUDE.md, A-082): she may share a chair with her own
   * overlapping envelope, and asking anonymously would offer fewer times than
   * the write accepts. This panel has had her id in its hand the whole time.
   *
   * `audience: 'staff'` because it is: the horizon and the lead time do not
   * cap a desk ringing round (D-21, D-25). No exclusion REASON leaves this
   * function, so the public-route rule is not in play.
   */
  const offeredFor = async (entry: { serviceIds: string[]; clientId: string }) => {
    // A departed stylist's engine offers nothing at all — `buildSlotQuery`
    // short-circuits on `provider.active`, and it is right to: booking HER is
    // refused. A-098's point stands either way, that the HOUR is still the
    // salon's most valuable thing and most likely to come free the week
    // somebody leaves, so the question becomes the one the desk will actually
    // ask on the other side of the Book link — "who can take this, then?" —
    // and it is the same engine, merged over the roster, not a looser test.
    if (!provider.active) {
      const times = await anyProviderTimes(db, {
        businessId: freed.businessId,
        serviceIds: entry.serviceIds,
        day,
        now: freed.now,
        audience: 'staff',
        holderKey: entry.clientId,
      });
      return times.map((t) => ({ start: fromDate(t.at), end: fromDate(t.endAt) }));
    }
    const { slots } = await computeDaySlots(db, {
      businessId: freed.businessId,
      providerId: freed.providerId,
      serviceIds: entry.serviceIds,
      day,
      now: freed.now,
      audience: 'staff',
      holderKey: entry.clientId,
    });
    return slots.map((slot) => ({ start: slot.start, end: slot.end }));
  };

  /**
   * ponytail: one engine pass per surviving candidate, run concurrently. The
   * cheap filters above it — the SQL window, the provider list, her
   * qualifications, and the footprint against the run — are what keep that
   * list short. If a salon ever waitlists hundreds at once, the fix is to
   * group candidates by their composed visit (identical service lists share an
   * answer) rather than to go back to comparing minutes.
   */
  const matched = await Promise.all(
    candidates.map(async (entry): Promise<MatchedEntry | null> => {
      const fit = footprintFor(entry.serviceIds);
      if (fit === null) return null;
      // A sound cheap bound, not the test: whatever the engine offers has its
      // body inside the maximal run, so a body longer than the run can never
      // be offered in it. Saves the engine call for everybody who was never
      // going to fit. NOT the footprint — see the containment note below;
      // that bound is too strict at a window edge and would drop real offers.
      if (!fitsFreedSpan(fit.bodyMinutes, span.run.minutes)) return null;

      const offer = (await offeredFor(entry)).find((slot) => {
        // INSIDE the run, BOTH EDGES. Asserting only the start would pass
        // against a visit whose tail runs past the end of the free time
        // (CLAUDE.md's A-093 rule: assert both edges of a range).
        //
        // The BODY, not the envelope, and this is the one subtlety here. The
        // engine's window predicate is on the body (`slot-engine.ts`), so a
        // visit starting at window open legitimately has its `bufferBefore`
        // sitting OUTSIDE the window and outside the run — there is nobody
        // before her to tidy up after. An envelope test would refuse the first
        // appointment of every day, which is the shape this whole item exists
        // to stop: a reader stricter than the write does not fail safe.
        if (slot.start < runStart || slot.end > runEnd) return false;
        // Day-parts and her date range are judged on the START SHE WOULD GET,
        // not on whatever freed the span: on a run straddling noon those are
        // two different answers, and "mornings only" is a statement about the
        // appointment.
        const label = toLabel(slot.start, zone);
        return (
          label.day >= entry.fromDay &&
          label.day <= entry.toDay &&
          matchesDayParts(entry.dayParts, tagsFor(label.day, label.time))
        );
      });
      if (offer === undefined) return null;

      return {
        id: entry.id,
        clientId: entry.clientId,
        clientName: entry.client.name,
        clientPhone: entry.client.phone,
        serviceIds: entry.serviceIds,
        serviceNames: entry.serviceIds.map((id) => qualified.get(id)!.service.name),
        footprintMinutes: fit.footprintMinutes,
        startAt: toDate(offer.start),
        fromDay: entry.fromDay,
        toDay: entry.toDay,
        dayParts: entry.dayParts,
        createdAt: entry.createdAt,
      };
    }),
  );
  // `Promise.all` keeps the query's order, so the list is still oldest first —
  // first come, first offered.
  return { span, entries: matched.flatMap((row) => (row === null ? [] : [row])) };
}
