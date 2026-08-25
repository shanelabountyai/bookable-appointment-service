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
import { patternGapSpans, worstCutoff } from '../../core/settings';
import { ACTIVE_STATUSES } from '../../core/scheduling';
import { resolveStaffNames } from '../auth';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface AppointmentEventRow {
  id: string;
  type: string;
  actor: string;
  actorRef: string | null;
  /**
   * A-037: the person behind `actorRef`, when it is a staff id that still
   * resolves. Null for a customer token, for `system`, and for a staff id
   * whose row has been deleted — the log then falls back to "the front desk",
   * which is what every event said before this item.
   *
   * Resolved HERE rather than by the screen, because `actorRef` is a bare
   * string with no foreign key (it holds token ids too), so there is no
   * relation for a select to follow.
   */
  actorName: string | null;
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
  /** A-048. Which adapter handled it — the per-ROW answer to "was she
   *  actually told?", replacing a predicate about the running build. */
  deliveredBy: string | null;
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
  /**
   * A-046 (RES-01, D-30). WHICH CHAIR she is in, and null when this
   * appointment holds none — a staff override, a service that needs no
   * resource, or a business with no resources defined at all. Until this item
   * the room was invisible on every screen while the desk was being refused
   * bookings on its authority; `resourceTypeName` is carried alongside so the
   * surface can say "Chair 2" without a second lookup and without hardcoding
   * the word "chair", which is a salon's word and not the product's.
   */
  resourceName: string | null;
  resourceTypeName: string | null;
  /** A-055 added `serviceId`: the visit panel posts the ordered ids back, and
   *  a name is not an identity — two services can share one. */
  services: { serviceId: string; name: string; priceCents: number; durationMinutes: number }[];
  /**
   * A-060 (D-19) — THE CUTOFF THAT ACTUALLY APPLIES TO THIS VISIT.
   *
   * Resolved HERE, by the same `worstCutoff` the write path uses, because a
   * multi-service visit meets the strictest of its services' cutoffs and the
   * business default is only the floor. The screen labels its one Cancel
   * button from this number; a screen that used the business default would
   * promise "on time" and the server would then correctly write
   * `cancelled_late`, which is the exact disagreement A-060 exists to end.
   */
  cancellationCutoffMinutes: number;
  /** SEG-03/D-29 — minutes of this appointment the provider is not needed for,
   *  from its own `segmentPattern` snapshot. Zero for an unsegmented visit. */
  gapMinutes: number;
  /** The primary (first-ordinal) service line. A-023's "who wants this slot?"
   *  link needs a single serviceId to match against — a multi-service visit
   *  (VISIT-01) only offers its lead service to the waitlist; matching a
   *  freed visit's SECOND service is a real gap, deferred until it matters. */
  primaryServiceId: string;
  /** Body ± buffers (D-16) — the range the exclusion constraint actually
   *  frees on cancellation, wider than `startAt`/`endAt` alone. */
  blockedStart: Date;
  blockedEnd: Date;
  clientId: string | null;
  clientName: string | null;
  clientPhone: string | null;
  /** CLIENT-03's safety surface, on EVERY appointment render. */
  clientNotes: string | null;
  checkedInAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  confirmedAt: Date | null;
  /**
   * A-049 (D-34) — the standing appointment this one is an occurrence of, or
   * null for an ordinary booking.
   *
   * `ordinal` is the position in the PLAN, and `requested` is how many weeks
   * were asked for — so "3rd of 6" stays true even when the fourth week was
   * never bookable. The link SURVIVES cancelling and rescheduling as
   * provenance: an occurrence detaches from the rule's future, not from its
   * own history.
   */
  series: { id: string; ordinal: number; intervalWeeks: number; requested: number } | null;
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
      blockedStart: true,
      blockedEnd: true,
      segmentPattern: true,
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
      seriesId: true,
      seriesOrdinal: true,
      series: { select: { intervalWeeks: true, requested: true } },
      provider: { select: { displayName: true } },
      // The hold and not `Appointment.resource` — same row in practice, but
      // the hold is what the exclusion constraint ranges over, so reading it
      // means the screen can never show a chair the database is not defending.
      resourceHold: { select: { resource: { select: { name: true, resourceType: { select: { name: true } } } } } },
      client: { select: { id: true, name: true, phone: true, notes: true } },
      business: { select: { cancellationCutoffMinutes: true } },
      lines: {
        orderBy: { ordinal: 'asc' },
        select: {
          serviceId: true,
          priceCents: true,
          durationMinutes: true,
          service: { select: { name: true, cancellationCutoffMinutes: true } },
        },
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
          deliveredBy: true,
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
    blockedStart: appointment.blockedStart,
    blockedEnd: appointment.blockedEnd,
    isOverride: appointment.isOverride,
    overrideReason: appointment.overrideReason,
    notes: appointment.notes,
    providerId: appointment.providerId,
    providerName: appointment.provider.displayName,
    resourceName: appointment.resourceHold?.resource.name ?? null,
    resourceTypeName: appointment.resourceHold?.resource.resourceType.name ?? null,
    primaryServiceId: appointment.lines[0]?.serviceId ?? '',
    cancellationCutoffMinutes: worstCutoff(
      appointment.business.cancellationCutoffMinutes,
      appointment.lines.map((l) => ({
        id: l.serviceId,
        name: l.service.name,
        cancellationCutoffMinutes: l.service.cancellationCutoffMinutes,
      })),
    ).minutes,
    gapMinutes: patternGapSpans(appointment.segmentPattern).reduce((sum, gap) => sum + gap.minutes, 0),
    services: appointment.lines.map((line) => ({
      serviceId: line.serviceId,
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
    // Guarded on the RELATION, not on `seriesId`: the column is `SetNull`, so
    // deleting a rule leaves the booked client exactly where she is and this
    // screen stops claiming she is the third of six of something gone.
    series: appointment.series
      ? {
          id: appointment.seriesId!,
          ordinal: appointment.seriesOrdinal ?? 0,
          intervalWeeks: appointment.series.intervalWeeks,
          requested: appointment.series.requested,
        }
      : null,
    conflicted,
    conflictAcknowledgedAt: appointment.conflictAckAt,
    conflictAcknowledgedReason: appointment.conflictAckReason,
    events: await withActorNames(db, appointment.events),
    notifications: appointment.notifications,
  };
}

/**
 * Puts a name on every staff-stamped event, in ONE query for the whole log.
 *
 * Deactivated people are included deliberately — the whole reason off-boarding
 * deactivates rather than deletes is that "who moved this appointment" must
 * still have an answer after somebody leaves.
 */
async function withActorNames(
  db: Db,
  events: Omit<AppointmentEventRow, 'actorName'>[],
): Promise<AppointmentEventRow[]> {
  // `db` may be a transaction client mid-write; `resolveStaffNames` wants a
  // full PrismaClient. Every caller of `loadAppointmentDetail` reads outside
  // any transaction (it is a read model), so the cast is a type gap, not a
  // behavioural one — this file has always queried `db.staffUser` directly.
  const names = await resolveStaffNames(
    db as PrismaClient,
    events.filter((e) => e.actor === 'staff' && e.actorRef).map((e) => e.actorRef!),
  );
  return events.map((event) => ({
    ...event,
    actorName: (event.actor === 'staff' && event.actorRef ? names.get(event.actorRef) : undefined) ?? null,
  }));
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
