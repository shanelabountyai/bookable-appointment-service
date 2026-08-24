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
  type PlannedOccurrence,
  bookableInstant,
  planOccurrences,
} from '../../core/scheduling';
import { type Actor } from '../../core/auth';
import { type ZoneId, calendarDay, toDate, wallTime } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { bookAppointment } from './book';
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

  const occurrences: SeriesOccurrenceResult[] = [];
  for (const occurrence of planned) {
    occurrences.push(await bookOne(prisma, input, series.id, occurrence));
  }

  return {
    seriesId: series.id,
    booked: occurrences.filter((o) => o.appointmentId).length,
    occurrences,
  };
}

async function bookOne(
  prisma: PrismaClient,
  input: CreateSeriesInput,
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
