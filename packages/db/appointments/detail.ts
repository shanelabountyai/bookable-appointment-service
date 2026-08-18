/**
 * A-027 — THE APPOINTMENT DETAIL READ MODEL (APPT-07, CLIENT-03, BOOK-05, D-8).
 *
 * Four stories need this screen and no row built it, so it accumulated the
 * questions the front desk actually asks about one appointment:
 *
 *  - "What happened to this?"        → the append-only event log (APPT-07).
 *  - "Was she actually told?"        → the outbox rows for it (operator R-4).
 *  - "Why is this marked override?"  → the reason, stored at booking (BOOK-05).
 *  - "Is she allergic to anything?"  → the pinned client note, on every render.
 *
 * A READ MODEL, not a view: it returns facts, and the words a human reads are
 * chosen at the surface. The event log's plain-language rendering is a UI
 * concern precisely because it is the part that will be reworded.
 */
import { ACTIVE_STATUSES } from '../../core/scheduling';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface AppointmentEventRow {
  id: string;
  type: string;
  actor: string;
  actorRef: string | null;
  reason: string | null;
  payload: unknown;
  createdAt: Date;
}

export interface NotificationRow {
  id: string;
  template: string;
  channel: string;
  recipient: string | null;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  lastError: string | null;
}

export interface AppointmentDetail {
  id: string;
  status: string;
  startAt: Date;
  endAt: Date;
  isOverride: boolean;
  overrideReason: string | null;
  /** The per-visit note (CLIENT-03) — "bring the reference photo". Distinct
   *  from the pinned client note below, which is the long-lived one. */
  notes: string | null;
  providerId: string;
  providerName: string;
  services: { name: string; priceCents: number; durationMinutes: number }[];
  clientId: string | null;
  clientName: string | null;
  clientPhone: string | null;
  /** CLIENT-03's safety surface, on EVERY appointment render. */
  clientNotes: string | null;
  checkedInAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  confirmedAt: Date | null;
  /** AVAIL-05's marker: this appointment sits inside an absence. DERIVED here
   *  and on every render (operator R-7), never stored. */
  conflicted: boolean;
  conflictAcknowledgedAt: Date | null;
  conflictAcknowledgedReason: string | null;
  events: AppointmentEventRow[];
  notifications: NotificationRow[];
}

export async function loadAppointmentDetail(
  db: Db,
  args: { businessId: string; appointmentId: string },
): Promise<AppointmentDetail | null> {
  const appointment = await db.appointment.findFirst({
    where: { id: args.appointmentId, businessId: args.businessId },
    select: {
      id: true,
      status: true,
      startAt: true,
      endAt: true,
      isOverride: true,
      overrideReason: true,
      notes: true,
      providerId: true,
      checkedInAt: true,
      startedAt: true,
      endedAt: true,
      confirmedAt: true,
      conflictAckAt: true,
      conflictAckReason: true,
      provider: { select: { displayName: true } },
      client: { select: { id: true, name: true, phone: true, notes: true } },
      lines: {
        orderBy: { ordinal: 'asc' },
        select: { priceCents: true, durationMinutes: true, service: { select: { name: true } } },
      },
      // APPT-07. Oldest first: a log is a story, and reading it backwards is
      // how you mistake a correction for the thing it corrected.
      events: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, type: true, actor: true, actorRef: true, reason: true, payload: true, createdAt: true },
      },
      // Operator R-4's "was she actually told?" — the one indexed lookup the
      // `NotificationOutbox.appointmentId` column exists for. The dedupe key
      // cannot serve: the reminder key embeds the start instant (P1-7), so a
      // rescheduled appointment's messages no longer share a prefix.
      notifications: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          template: true,
          channel: true,
          recipient: true,
          status: true,
          createdAt: true,
          sentAt: true,
          lastError: true,
        },
      },
    },
  });

  if (!appointment) return null;

  const conflicted =
    (ACTIVE_STATUSES as readonly string[]).includes(appointment.status) &&
    (await overlapsAnAbsence(db, appointment.providerId, appointment.startAt, appointment.endAt));

  return {
    id: appointment.id,
    status: appointment.status,
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    isOverride: appointment.isOverride,
    overrideReason: appointment.overrideReason,
    notes: appointment.notes,
    providerId: appointment.providerId,
    providerName: appointment.provider.displayName,
    services: appointment.lines.map((line) => ({
      name: line.service.name,
      priceCents: line.priceCents,
      durationMinutes: line.durationMinutes,
    })),
    clientId: appointment.client?.id ?? null,
    clientName: appointment.client?.name ?? null,
    clientPhone: appointment.client?.phone ?? null,
    clientNotes: appointment.client?.notes ?? null,
    checkedInAt: appointment.checkedInAt,
    startedAt: appointment.startedAt,
    endedAt: appointment.endedAt,
    confirmedAt: appointment.confirmedAt,
    conflicted,
    conflictAcknowledgedAt: appointment.conflictAckAt,
    conflictAcknowledgedReason: appointment.conflictAckReason,
    events: appointment.events,
    notifications: appointment.notifications,
  };
}

/** Time off or an ad-hoc block over this appointment's own body. */
async function overlapsAnAbsence(db: Db, providerId: string, startAt: Date, endAt: Date): Promise<boolean> {
  const where = { providerId, startAt: { lt: endAt }, endAt: { gt: startAt } };
  const [timeOff, blocks] = await Promise.all([db.timeOff.count({ where }), db.adHocBlock.count({ where })]);
  return timeOff + blocks > 0;
}

/** The per-visit note (CLIENT-03). Kept apart from the pinned client note so
 *  "patch test done 12/4" does not accumulate on top of the allergy line. */
export async function setAppointmentNotes(
  db: Db,
  args: { businessId: string; appointmentId: string; notes: string },
): Promise<void> {
  await db.appointment.updateMany({
    where: { id: args.appointmentId, businessId: args.businessId },
    data: { notes: args.notes.trim() || null },
  });
}
