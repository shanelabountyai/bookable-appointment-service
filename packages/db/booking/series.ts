/**
 * A-049 — creating a standing appointment (the database half).
 *
 * PARTIAL BY DESIGN, and that is a reuse rather than a new idea. "Book Ada
 * every four weeks for the next six" meets a book that already has things in
 * it: the fourth Tuesday is somebody else's, the fifth is a bank holiday the
 * salon closed, the sixth crosses spring-forward and her time does not exist
 * that week. Refusing all six because one is taken is the answer nobody wants;
 * silently skipping one is the answer this whole product exists to forbid.
 *
 * So it books what it can and NAMES WHAT IT DID NOT — the same shape D-26 gave
 * the column push ("moves every appointment that can move and reports the
 * rest") and A-019 gave the bulk reassign. The desk reads a list and makes
 * three phone calls, which is what it was going to do anyway.
 *
 * Each occurrence goes through `bookAppointment` UNCHANGED. That matters more
 * than it looks: the exclusion constraint, the chair assignment, the engine
 * re-check, the idempotency key, the outbox row and the event log all apply
 * per occurrence, because an occurrence IS an appointment. Nothing here is a
 * second way to write one.
 */
import {
  ACTIVE_STATUSES,
  type PlannedOccurrence,
  bookableInstant,
  planOccurrences,
} from '../../core/scheduling';
import { type Actor } from '../../core/auth';
import { type ZoneId, addDays, calendarDay, fromDate, instant, toDate, wallTime } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { assertBookingIdsOfBusiness, bookAppointment } from './book';
import { NoResourceFree, SlotNotOffered, SlotTaken } from './errors';

export interface CreateSeriesInput {
  businessId: string;
  providerId: string;
  clientId: string | null;
  serviceIds: string[];
  /** The first appointment's calendar day and wall time — the rule's anchor. */
  anchorDay: string;
  time: string;
  intervalWeeks: number;
  count: number;
  now: Date;
  actor: Actor;
  notes?: string | null;
}

/** Why one occurrence is not in the book. Every arm is a sentence the desk can
 *  act on, never a status code. */
export type SkipReason =
  /** The wall time does not exist that week (spring-forward). Never coerced —
   *  spec DST-8. */
  | { kind: 'no-such-time' }
  /** Somebody else has the provider, or the room is full. */
  | { kind: 'taken' }
  /** The salon is closed, she is off, or the engine declined for its own
   *  reasons — carried verbatim so the desk sees the real one. */
  | { kind: 'not-offered'; reasons: string[] }
  | { kind: 'no-chair' };

export interface SeriesOccurrenceResult {
  ordinal: number;
  day: string;
  /** Set when it was booked. */
  appointmentId?: string;
  /** Set when it was not. */
  skipped?: SkipReason;
  /** True when the wall time happened TWICE that week and the earlier one was
   *  taken. Booked, but worth saying out loud. */
  doubledHour?: boolean;
}

export interface CreateSeriesResult {
  seriesId: string;
  booked: number;
  occurrences: SeriesOccurrenceResult[];
}

/**
 * Creates the rule, then books its occurrences one at a time.
 *
 * NOT one transaction, deliberately. Wrapping six bookings in a single
 * transaction would make the fourth one's lost race roll back the three that
 * already succeeded — turning a partial result into an all-or-nothing refusal,
 * which is the behaviour D-26 already rejected once. It would also hold D-24's
 * advisory lock across six engine runs on the busiest surface in the salon.
 *
 * The series row is written FIRST so every occurrence can carry its id, and it
 * survives even if nothing books: "we tried to set up Ada's Tuesdays and every
 * single one was taken" is a fact worth keeping, and an empty series is
 * visible where a silent nothing is not.
 */
export async function createSeries(prisma: PrismaClient, input: CreateSeriesInput): Promise<CreateSeriesResult> {
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: input.businessId },
    select: { timezone: true },
  });
  const zone = business.timezone as ZoneId;

  // Pure, and it throws InvalidSeries before anything is written — a bad rule
  // must not leave a series row behind.
  const planned = planOccurrences(
    {
      anchorDay: calendarDay(input.anchorDay),
      time: wallTime(input.time),
      intervalWeeks: input.intervalWeeks,
      count: input.count,
    },
    zone,
  );

  await assertBookingIdsOfBusiness(prisma, input.businessId, input);
  const series = await prisma.appointmentSeries.create({
    data: {
      businessId: input.businessId,
      providerId: input.providerId,
      clientId: input.clientId,
      anchorDay: input.anchorDay,
      wallTime: input.time,
      intervalWeeks: input.intervalWeeks,
      requested: input.count,
      createdByActor: input.actor.type,
      actorRef: input.actor.ref,
    },
    select: { id: true },
  });

  return bookOccurrences(prisma, input, series.id, planned);
}

/** What booking one occurrence needs — the rule's who and what, never its when. */
type OccurrenceInput = Pick<
  CreateSeriesInput,
  'businessId' | 'providerId' | 'clientId' | 'serviceIds' | 'now' | 'actor' | 'notes'
>;

/** One at a time, partially — shared by the create and the extend so the two
 *  cannot drift into different ideas of what "booked what it could" means. */
async function bookOccurrences(
  prisma: PrismaClient,
  input: OccurrenceInput,
  seriesId: string,
  planned: PlannedOccurrence[],
): Promise<CreateSeriesResult> {
  const occurrences: SeriesOccurrenceResult[] = [];
  for (const occurrence of planned) {
    occurrences.push(await bookOne(prisma, input, seriesId, occurrence));
  }

  return {
    seriesId,
    booked: occurrences.filter((o) => o.appointmentId).length,
    occurrences,
  };
}

async function bookOne(
  prisma: PrismaClient,
  input: OccurrenceInput,
  seriesId: string,
  occurrence: PlannedOccurrence,
): Promise<SeriesOccurrenceResult> {
  const at = bookableInstant(occurrence);
  if (at === null) {
    // Spring-forward: her time genuinely does not happen that week. The desk
    // picks a different one; this function will not pick for her.
    return { ordinal: occurrence.ordinal, day: occurrence.day, skipped: { kind: 'no-such-time' } };
  }

  try {
    const booked = await bookAppointment(prisma, {
      businessId: input.businessId,
      providerId: input.providerId,
      clientId: input.clientId,
      serviceIds: input.serviceIds,
      startAt: toDate(at),
      now: input.now,
      actor: input.actor,
      // Staff-shaped from the first call (operator S-3): a standing
      // appointment is set up at the desk, so it is not bound by the lead time
      // or the booking horizon a customer is.
      audience: 'staff',
      notes: input.notes ?? null,
      // The natural key of the FACT, not of the attempt (NOTIF-01's rule
      // applied to bookings): re-running a series creation that half-succeeded
      // rebooks nothing it already booked.
      idempotencyKey: `series:${seriesId}:${occurrence.ordinal}`,
      seriesId,
      seriesOrdinal: occurrence.ordinal,
    });

    return {
      ordinal: occurrence.ordinal,
      day: occurrence.day,
      appointmentId: booked.id,
      ...(occurrence.kind === 'ambiguous' ? { doubledHour: true } : {}),
    };
  } catch (error) {
    return { ordinal: occurrence.ordinal, day: occurrence.day, skipped: skipReasonFor(error) };
  }
}

/**
 * The engine's and the constraint's refusals, as things a person can act on.
 *
 * An unknown error is RE-THROWN rather than folded into a skip. A series that
 * quietly reports "couldn't book that one" when the database is actually down
 * would be the silent failure this item is supposed to be the opposite of.
 */
function skipReasonFor(error: unknown): SkipReason {
  if (error instanceof SlotTaken) return { kind: 'taken' };
  if (error instanceof NoResourceFree) return { kind: 'no-chair' };
  if (error instanceof SlotNotOffered) return { kind: 'not-offered', reasons: [...error.reasons] };
  throw error;
}

/** Every occurrence of a series, in order — for the detail panel's "3rd of 6"
 *  and for the day the desk wants to see the rest of them. */
export async function listSeriesOccurrences(
  db: Prisma.TransactionClient | PrismaClient,
  seriesId: string,
): Promise<{ id: string; startAt: Date; status: string; seriesOrdinal: number | null }[]> {
  return db.appointment.findMany({
    where: { seriesId },
    orderBy: { startAt: 'asc' },
    select: { id: true, startAt: true, status: true, seriesOrdinal: true },
  });
}

/**
 * A-152 (C11) — "EXTEND BY THE SAME RULE".
 *
 * The next `count` occurrences after the last one the rule ever asked for —
 * ordinals `requested .. requested + count - 1`, on the same calendar arithmetic
 * from the same anchor. Booked exactly as `createSeries` books, partially, and
 * described the same way, so the desk reads one kind of summary for both.
 *
 * The SAME series row, not a new one: the ordinals continue ("7th of 9"), the
 * idempotency keys stay `series:<id>:<ordinal>` and stay unique, and ending it
 * later (D-39) still reaches every occurrence.
 *
 * `expectedRequested` is the number the desk was looking at. Two people
 * extending the same series from two screens is a Saturday; the second one is
 * refused rather than booking her another six on top.
 */
export class SeriesExtendRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeriesExtendRefused';
  }
}

export async function extendSeries(
  prisma: PrismaClient,
  input: { businessId: string; seriesId: string; count: number; expectedRequested: number; now: Date; actor: Actor },
): Promise<CreateSeriesResult & { requested: number; intervalWeeks: number; wallTime: string }> {
  const series = await prisma.appointmentSeries.findFirst({
    where: { id: input.seriesId, businessId: input.businessId },
    select: {
      anchorDay: true,
      wallTime: true,
      intervalWeeks: true,
      requested: true,
      endedAt: true,
      providerId: true,
      clientId: true,
      business: { select: { timezone: true } },
      // The visit to repeat is the LATEST one the rule asked for — the desk
      // may have changed her services on an occurrence since the series began.
      appointments: {
        orderBy: [{ seriesOrdinal: 'desc' }, { startAt: 'desc' }],
        take: 1,
        select: { lines: { orderBy: { ordinal: 'asc' }, select: { serviceId: true } } },
      },
    },
  });
  if (!series) throw new SeriesExtendRefused('That standing appointment no longer exists.');
  if (series.endedAt) throw new SeriesExtendRefused('This series was ended. Set up a new one from the booking screen.');
  const serviceIds = series.appointments[0]?.lines.map((line) => line.serviceId) ?? [];
  if (serviceIds.length === 0) throw new SeriesExtendRefused('Nothing was ever booked on this series to repeat.');

  // Pure, and it throws InvalidSeries before anything is written. Planned from
  // the day the next ordinal falls on, so the 104 ceiling is per extension.
  const anchor = calendarDay(series.anchorDay.trim());
  const planned = planOccurrences(
    {
      anchorDay: addDays(anchor, series.requested * series.intervalWeeks * 7),
      time: wallTime(series.wallTime.trim()),
      intervalWeeks: series.intervalWeeks,
      count: input.count,
    },
    series.business.timezone as ZoneId,
  ).map((occurrence) => ({ ...occurrence, ordinal: occurrence.ordinal + series.requested }));

  // The claim. Conditional on the number the desk saw, so a double submit
  // books once.
  const claimed = await prisma.appointmentSeries.updateMany({
    where: { id: input.seriesId, requested: input.expectedRequested, endedAt: null },
    data: { requested: input.expectedRequested + input.count },
  });
  if (claimed.count === 0) {
    throw new SeriesExtendRefused('Somebody extended this series a moment ago. Check the list again.');
  }

  const result = await bookOccurrences(
    prisma,
    {
      businessId: input.businessId,
      providerId: series.providerId,
      clientId: series.clientId,
      serviceIds,
      now: input.now,
      actor: input.actor,
    },
    input.seriesId,
    planned,
  );
  return {
    ...result,
    requested: input.expectedRequested + input.count,
    intervalWeeks: series.intervalWeeks,
    wallTime: series.wallTime.trim(),
  };
}

/** A-152 — how far ahead "ending soon" looks by default: one six-week colour
 *  cycle, so she is asked at the visit before her last one. */
export const SERIES_ENDING_WEEKS = 6;

export interface EndingSeries {
  seriesId: string;
  clientId: string;
  name: string | null;
  phone: string | null;
  providerName: string;
  intervalWeeks: number;
  wallTime: string;
  requested: number;
  /** Her last appointment the series still holds. */
  lastAt: Date;
  serviceNames: string[];
}

/**
 * A-152 (C11) — STANDING APPOINTMENTS THAT ARE ABOUT TO RUN OUT.
 *
 * A series is a number the desk typed once — "the next six" — and on the
 * seventh week she simply is not in the book. Nobody decided that; it ran out.
 *
 * Listed when the series still has something AHEAD (it has not run out yet —
 * one that already has is the lapsed report's) and nothing beyond `weeks` from
 * now. Not listed when it was ended on purpose (D-39, `endedAt`) or belongs to
 * a merged-away record (the merge re-points series; the filter is for rows
 * written before it did). Cancelled occurrences do not count as "ahead": a
 * cancelled last week is a week she is not coming.
 *
 * Soonest to run out first.
 */
export async function listSeriesEnding(
  db: Prisma.TransactionClient | PrismaClient,
  args: { businessId: string; now: Date; weeks?: number },
): Promise<EndingSeries[]> {
  const weeks = args.weeks ?? SERIES_ENDING_WEEKS;
  const horizon = toDate(instant(fromDate(args.now) + weeks * 7 * 86_400_000));
  const active = { in: [...ACTIVE_STATUSES] };

  const rows = await db.appointmentSeries.findMany({
    where: {
      businessId: args.businessId,
      endedAt: null,
      clientId: { not: null },
      client: { mergedIntoClientId: null },
      AND: [
        { appointments: { some: { status: active, startAt: { gt: args.now } } } },
        { appointments: { none: { status: active, startAt: { gt: horizon } } } },
      ],
    },
    select: {
      id: true,
      clientId: true,
      intervalWeeks: true,
      wallTime: true,
      requested: true,
      client: { select: { name: true, phone: true } },
      provider: { select: { displayName: true } },
      appointments: {
        where: { status: active },
        orderBy: { startAt: 'desc' },
        take: 1,
        select: {
          startAt: true,
          lines: { orderBy: { ordinal: 'asc' }, select: { service: { select: { name: true } } } },
        },
      },
    },
  });

  return rows
    .map((row) => {
      const last = row.appointments[0]!;
      return {
        seriesId: row.id,
        clientId: row.clientId!,
        name: row.client!.name,
        phone: row.client!.phone,
        providerName: row.provider.displayName,
        intervalWeeks: row.intervalWeeks,
        wallTime: row.wallTime.trim(),
        requested: row.requested,
        lastAt: last.startAt,
        serviceNames: last.lines.map((line) => line.service.name),
      };
    })
    .sort((a, b) => fromDate(a.lastAt) - fromDate(b.lastAt) || a.seriesId.localeCompare(b.seriesId));
}
