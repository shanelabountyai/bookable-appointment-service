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
  lastNotice: { template: string; status: string; at: Date } | null;
}

const SELECT = {
  id: true,
  startAt: true,
  endAt: true,
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
    select: { template: true, status: true, createdAt: true },
  },
} as const;

type Row = {
  id: string;
  startAt: Date;
  endAt: Date;
  status: string;
  providerId: string;
  conflictAckAt: Date | null;
  conflictAckReason: string | null;
  provider: { displayName: string };
  client: { id: string; name: string | null; phone: string | null } | null;
  lines: { serviceId: string; service: { name: string } }[];
  notifications: { template: string; status: string; createdAt: Date }[];
};

const toConflict = (row: Row): ConflictingAppointment => ({
  id: row.id,
  startAt: row.startAt,
  endAt: row.endAt,
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
    ? { template: row.notifications[0].template, status: row.notifications[0].status, at: row.notifications[0].createdAt }
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
