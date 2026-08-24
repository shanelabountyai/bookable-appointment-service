/**
 * A-019 — THE IMPACT WORKFLOW (AVAIL-05).
 *
 * "Dana calls in sick" is the moment this product is judged. Nine clients are
 * booked, and the one thing the system must never do is deal with them
 * quietly: **nothing is silently cancelled, moved, or hidden.**
 *
 * THE CENTRAL DECISION (operator R-7): A CONFLICT IS DERIVED, NEVER STORED.
 * An appointment conflicts because it overlaps an absence, or because the
 * hours moved out from under it — both are facts about other rows, and a
 * stored `hasConflict` flag goes stale and lies on the day it matters. What
 * IS stored is the human acknowledgment ("we rang her, she's coming anyway"),
 * because that is not derivable from anything. It is cleared whenever the
 * overlapping absence changes, so the second person in on Saturday morning
 * does not re-ring three clients somebody already sorted.
 */
import type { Actor } from '../../core/auth';
import { ACTIVE_STATUSES, resolveWindow, wallTime } from '../../core/scheduling';
import { type ZoneId, calendarDay, fromDate, weekdayOf } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { resolveDayWindows } from './availability';

type Db = Prisma.TransactionClient | PrismaClient;

export interface ConflictingAppointment {
  id: string;
  startAt: Date;
  endAt: Date;
  /** A-047. The business-zone calendar day this sits on, stored `CHAR(10)`
   *  (never `@db.Date`). It is what "send the desk to the right day" needs,
   *  and taking it from the column rather than re-labelling `startAt` means
   *  the link cannot disagree with the row. */
  startDay: string;
  status: string;
  providerId: string;
  providerName: string;
  /** AVAIL-05 asks for names AND phones: the resolution to most of these is a
   *  phone call, and a list you have to click nine times to use is a list the
   *  front desk copies onto paper. */
  clientId: string | null;
  clientName: string | null;
  clientPhone: string | null;
  serviceIds: string[];
  serviceNames: string[];
  /** The stored acknowledgment, if somebody has already dealt with this one. */
  acknowledgedAt: Date | null;
  acknowledgedReason: string | null;
  /**
   * A-036: the most recent thing this client was told about this appointment,
   * from `NotificationOutbox.appointmentId` (operator R-4's index, R-8's
   * question turned around). The desk works down this list on the phone, and
   * "she already got a text an hour ago" changes what the next call says.
   */
  lastNotice: { template: string; status: string; deliveredBy: string | null; at: Date } | null;
}

const SELECT = {
  id: true,
  startAt: true,
  endAt: true,
  startDay: true,
  status: true,
  providerId: true,
  conflictAckAt: true,
  conflictAckReason: true,
  provider: { select: { displayName: true } },
  client: { select: { id: true, name: true, phone: true } },
  lines: { orderBy: { ordinal: 'asc' as const }, select: { serviceId: true, service: { select: { name: true } } } },
  notifications: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { template: true, status: true, deliveredBy: true, createdAt: true },
  },
} as const;

type Row = {
  id: string;
  startAt: Date;
  endAt: Date;
  startDay: string;
  status: string;
  providerId: string;
  conflictAckAt: Date | null;
  conflictAckReason: string | null;
  provider: { displayName: string };
  client: { id: string; name: string | null; phone: string | null } | null;
  lines: { serviceId: string; service: { name: string } }[];
  notifications: { template: string; status: string; deliveredBy: string | null; createdAt: Date }[];
};

const toConflict = (row: Row): ConflictingAppointment => ({
  id: row.id,
  startAt: row.startAt,
  endAt: row.endAt,
  startDay: row.startDay,
  status: row.status,
  providerId: row.providerId,
  providerName: row.provider.displayName,
  clientId: row.client?.id ?? null,
  clientName: row.client?.name ?? null,
  clientPhone: row.client?.phone ?? null,
  serviceIds: row.lines.map((l) => l.serviceId),
  serviceNames: row.lines.map((l) => l.service.name),
  acknowledgedAt: row.conflictAckAt,
  acknowledgedReason: row.conflictAckReason,
  lastNotice: row.notifications[0]
    ? {
        template: row.notifications[0].template,
        status: row.notifications[0].status,
        deliveredBy: row.notifications[0].deliveredBy,
        at: row.notifications[0].createdAt,
      }
    : null,
});

/**
 * What a new absence would strand — time off, an ad-hoc block, a sick day.
 *
 * An INSTANT-overlap predicate over the appointment's own body, and only over
 * ACTIVE statuses: a cancelled appointment cannot be stranded, and stranding a
 * completed one is a statement about the past.
 */
export async function appointmentsInRange(
  db: Db,
  args: { businessId: string; providerId: string; startAt: Date; endAt: Date },
): Promise<ConflictingAppointment[]> {
  const rows = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      providerId: args.providerId,
      status: { in: [...ACTIVE_STATUSES] },
      startAt: { lt: args.endAt },
      endAt: { gt: args.startAt },
    },
    orderBy: { startAt: 'asc' },
    select: SELECT,
  });
  return rows.map(toConflict);
}

/**
 * What an HOURS change would strand: appointments on that day whose body no
 * longer fits inside the provider's resolved working windows.
 *
 * Called AFTER the change is written, from inside the same transaction — the
 * windows have to be the new ones, and re-deriving "what would they be" from
 * an unsaved edit would be a second implementation of the precedence chain.
 */
export async function appointmentsOutsideHours(
  db: Db,
  args: { businessId: string; providerId: string; day: string },
): Promise<ConflictingAppointment[]> {
  const business = await db.business.findUniqueOrThrow({
    where: { id: args.businessId },
    select: { timezone: true },
  });
  const zone = business.timezone as ZoneId;
  const day = calendarDay(args.day);

  const resolved = await resolveDayWindows(db, {
    businessId: args.businessId,
    providerId: args.providerId,
    day: args.day,
    weekday: weekdayOf(day),
  });
  const windows = resolved.windows.map((w) =>
    resolveWindow(
      {
        open: wallTime(w.open),
        close: wallTime(w.close),
        endsNextDay: w.endsNextDay,
        breaks: w.breaks.map((b) => ({ open: wallTime(b.open), close: wallTime(b.close) })),
      },
      day,
      zone,
    ).span,
  );

  const rows = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      providerId: args.providerId,
      status: { in: [...ACTIVE_STATUSES] },
      startDay: args.day,
    },
    orderBy: { startAt: 'asc' },
    select: SELECT,
  });

  return rows
    .filter((row) => {
      const start = fromDate(row.startAt);
      const end = fromDate(row.endAt);
      // Contained in SOME window, whole. An appointment half inside a window
      // is stranded: the salon shuts underneath it.
      return !windows.some((w) => start >= w.start && end <= w.end);
    })
    .map(toConflict);
}

/**
 * A-047 — WHAT AN HOURS EDIT STRANDED (AVAIL-05, D-2).
 *
 * A-041 built `appointmentsOutsideHours` and wired ONE caller. The other four
 * availability writes — adding a weekly window, saving an override, and
 * REMOVING either — returned `{ ok: true }` and said nothing at all. Removing
 * a Thursday window *is* "I don't work Thursdays any more", and it orphaned
 * every Thursday booking on the books in silence.
 *
 * Nothing here refuses (D-2): the write has already happened when this is
 * called. This is the sentence that comes back with it.
 *
 * ONE DERIVATION FOR ALL FOUR, deliberately. It is tempting to reason per
 * case — "adding hours cannot strand anyone, removing an `isClosed` override
 * only frees time" — and every one of those arguments is a place to be wrong
 * once and never notice. Re-deriving *who no longer fits the resolved windows*
 * gives the right answer for all four and returns zero for the cases that
 * genuinely strand nobody. The precedence chain is asked, not re-implemented.
 */
export type HoursScope =
  /** An override: exactly one calendar day. */
  | { kind: 'day'; day: string }
  /** A weekly window: every FUTURE occurrence of that weekday. */
  | { kind: 'weekday'; weekday: number };

export async function strandedByHoursChange(
  db: Db,
  args: {
    businessId: string;
    /** `null` is a BUSINESS-level window (AVAIL-04) — it moves the ceiling for
     *  every provider, so every provider has to be re-checked. */
    providerId: string | null;
    scope: HoursScope;
    now: Date;
  },
): Promise<ConflictingAppointment[]> {
  const providerIds = args.providerId
    ? [args.providerId]
    : (await db.provider.findMany({ where: { businessId: args.businessId }, select: { id: true } })).map((p) => p.id);
  if (providerIds.length === 0) return [];

  const days = await daysToRecheck(db, { businessId: args.businessId, providerIds, scope: args.scope, now: args.now });

  const perDay = await Promise.all(
    days.flatMap((day) =>
      providerIds.map((providerId) => appointmentsOutsideHours(db, { businessId: args.businessId, providerId, day })),
    ),
  );

  // One entry per appointment however many ways it is reachable, and only what
  // is still AHEAD: an hours edit cannot strand a client who already came in,
  // and reporting last Tuesday's completed cut as "now stranded" is the kind of
  // false alarm that teaches the desk to stop reading the sentence.
  const byId = new Map(
    perDay
      .flat()
      .filter((conflict) => conflict.startAt >= args.now)
      .map((conflict) => [conflict.id, conflict]),
  );
  return [...byId.values()].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/**
 * A-047 — WHO MOVED THE HOURS OUT FROM UNDER HER.
 *
 * A deletion removes the row that carried `createdByActor`/`actorRef`, so
 * "who deleted Dana's Thursday?" has nowhere to live on the availability
 * tables — and since A-037 every other availability write can answer it. The
 * answer goes where the desk actually asks the question: on the appointment
 * that is now in conflict, in the append-only log it already reads (APPT-07).
 *
 * Written only for the appointments that were ACTUALLY stranded. An hours edit
 * that strands nobody is not an event about anybody's appointment, and a log
 * full of "nothing happened to you" is a log nobody reads.
 */
export type HoursChange = 'weekly_window_added' | 'weekly_window_removed' | 'override_saved' | 'override_removed';

export async function recordHoursStranding(
  db: Db,
  args: {
    businessId: string;
    conflicts: readonly ConflictingAppointment[];
    actor: Actor;
    change: HoursChange;
  },
): Promise<void> {
  if (args.conflicts.length === 0) return;
  await db.appointmentEvent.createMany({
    data: args.conflicts.map((conflict) => ({
      businessId: args.businessId,
      appointmentId: conflict.id,
      type: 'hours_changed_underneath',
      actor: args.actor.type,
      actorRef: args.actor.ref,
      payload: { change: args.change } satisfies Prisma.InputJsonValue,
    })),
  });
}

/**
 * Which calendar days the change could have moved.
 *
 * For a weekday change this is bounded by the BOOK, not by a horizon constant:
 * the days that actually hold a future appointment on that weekday. A salon
 * with nothing booked past Friday re-checks nothing, and one booked out eleven
 * months is still answered exactly. `startDay` is a stored `CHAR(10)`, so the
 * weekday comes from string arithmetic and never from a `Date`.
 */
async function daysToRecheck(
  db: Db,
  args: { businessId: string; providerIds: string[]; scope: HoursScope; now: Date },
): Promise<string[]> {
  if (args.scope.kind === 'day') return [args.scope.day];

  const rows = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      providerId: { in: args.providerIds },
      status: { in: [...ACTIVE_STATUSES] },
      startAt: { gte: args.now },
    },
    distinct: ['startDay'],
    select: { startDay: true },
  });

  const weekday = args.scope.weekday;
  return rows.map((row) => row.startDay).filter((day) => weekdayOf(calendarDay(day)) === weekday);
}

/**
 * What deactivating a provider would strand: everything still ahead of her.
 *
 * Moved out of A-025 (operator S-2), where it would have shipped tested
 * against an empty appointment table because no appointment could exist yet.
 */
export async function futureAppointments(
  db: Db,
  args: { businessId: string; providerId: string; from: Date },
): Promise<ConflictingAppointment[]> {
  const rows = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      providerId: args.providerId,
      status: { in: [...ACTIVE_STATUSES] },
      startAt: { gte: args.from },
    },
    orderBy: { startAt: 'asc' },
    select: SELECT,
  });
  return rows.map(toConflict);
}

/**
 * Every appointment on one day that is currently in conflict — the day view's
 * markers, derived on every render (AVAIL-05: "conflicting-but-kept
 * appointments render with a conflict marker until resolved").
 *
 * Both causes in one pass, because the front desk does not care which kind it
 * is: the client is booked and somebody has to do something about it.
 */
export async function conflictsForDay(
  db: Db,
  args: { businessId: string; day: string },
): Promise<ConflictingAppointment[]> {
  const providers = await db.provider.findMany({
    where: { businessId: args.businessId },
    select: { id: true },
  });

  const perProvider = await Promise.all(
    providers.map(async (provider) => {
      const [outside, absences] = await Promise.all([
        appointmentsOutsideHours(db, { businessId: args.businessId, providerId: provider.id, day: args.day }),
        db.timeOff
          .findMany({ where: { providerId: provider.id }, select: { startAt: true, endAt: true } })
          .then(async (timeOff) => [
            ...timeOff,
            ...(await db.adHocBlock.findMany({
              where: { providerId: provider.id },
              select: { startAt: true, endAt: true },
            })),
          ]),
      ]);

      const overlapping = await Promise.all(
        absences.map((absence) =>
          appointmentsInRange(db, {
            businessId: args.businessId,
            providerId: provider.id,
            startAt: absence.startAt,
            endAt: absence.endAt,
          }),
        ),
      );

      return [...outside, ...overlapping.flat()];
    }),
  );

  // One entry per appointment however many ways it conflicts.
  const byId = new Map(perProvider.flat().map((conflict) => [conflict.id, conflict]));
  return [...byId.values()]
    .filter((conflict) => conflict.startAt.toISOString().length > 0)
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/**
 * AVAIL-05's "keep-flagged": somebody rang her and she is coming anyway.
 *
 * The only thing this workflow STORES. Everything else about a conflict is
 * re-derived, so this is the one fact that would otherwise be lost — and the
 * one that stops the next person repeating the phone calls.
 */
export async function acknowledgeConflict(
  db: Db,
  args: { appointmentId: string; businessId: string; reason: string; actor: Actor; now: Date },
): Promise<void> {
  await db.appointment.updateMany({
    where: { id: args.appointmentId, businessId: args.businessId },
    data: { conflictAckAt: args.now, conflictAckReason: args.reason.trim() || null },
  });

  await db.appointmentEvent.create({
    data: {
      businessId: args.businessId,
      appointmentId: args.appointmentId,
      type: 'conflict_acknowledged',
      actor: args.actor.type,
      actorRef: args.actor.ref,
      reason: args.reason.trim() || null,
    },
  });
}
