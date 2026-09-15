/**
 * A-023 — waitlist entries and fit-aware matching (WAIT-01, WAIT-02).
 *
 * v1 is the staff panel only: entries, and "who wants this slot?" for one
 * freed interval. Automated offer-with-soft-hold is OQ-4's follow-on and
 * touches none of this — this module never SENDS anything, it only answers
 * "who".
 */
import { DAY_PART_TAGS, matchesDayParts, tagsFor } from '../../core/waitlist';
import type { CalendarDay, WallTime } from '../../core/time';
import { effectiveDurationMinutes, effectivePriceCents, fitsFreedSpan, serviceFootprintMinutes } from '../../core/settings';
import { composeVisit } from '../../core/scheduling';
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
  day: CalendarDay;
  time: WallTime;
  /** The length of what actually opened up — `blockedEnd - blockedStart` of
   *  the appointment that freed it, in minutes. Buffer-inclusive, because
   *  that is the range the exclusion constraint just let go of. */
  freedMinutes: number;
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
 * THE FIT IS PER-ENTRY NOW, SO THE READS ARE PER-SPAN. Every candidate can
 * want a different visit, but they all want it from the SAME provider — the
 * one whose time opened up — so one read of her qualifications carries the
 * duration override (SVC-02) and the buffers for every line of every
 * candidate. `composeVisit` is D-23's one copy of the composition rule and
 * this calls it rather than re-adding the buffers; `fitsFreedSpan` is A-109's
 * one copy of the comparison.
 *
 * A LINE SHE IS NOT QUALIFIED FOR IS A REFUSAL, NOT A ZERO. An entry naming a
 * service this provider does not do (or one that has since been retired) has
 * no footprint at her chair at all, and dropping the line would compose a
 * SHORTER visit that fits more spans — the offered-then-refused class this
 * repo has caught four times. It is `null`, and `null` does not fit.
 */
export async function matchFreedSlot(db: Db, freed: FreedSlot): Promise<MatchedEntry[]> {
  const candidates = await db.waitlistEntry.findMany({
    where: {
      businessId: freed.businessId,
      status: 'active',
      fromDay: { lte: freed.day },
      // A-110 — the same closing edge the standing queue now filters on.
      ...notExpiredOn(freed.day),
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
  if (candidates.length === 0) return [];

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
  const footprintFor = (serviceIds: string[]): number | null => {
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
    return serviceFootprintMinutes(composeVisit(lines as NonNullable<(typeof lines)[number]>[]));
  };

  const tags = tagsFor(freed.day, freed.time);
  return candidates.flatMap((entry) => {
    if (!matchesDayParts(entry.dayParts, tags)) return [];
    const footprintMinutes = footprintFor(entry.serviceIds);
    if (footprintMinutes === null || !fitsFreedSpan(footprintMinutes, freed.freedMinutes)) return [];
    return [
      {
        id: entry.id,
        clientId: entry.clientId,
        clientName: entry.client.name,
        clientPhone: entry.client.phone,
        serviceIds: entry.serviceIds,
        serviceNames: entry.serviceIds.map((id) => qualified.get(id)!.service.name),
        footprintMinutes,
        fromDay: entry.fromDay,
        toDay: entry.toDay,
        dayParts: entry.dayParts,
        createdAt: entry.createdAt,
      },
    ];
  });
}
