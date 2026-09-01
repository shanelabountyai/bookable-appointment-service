/**
 * A-055 — AN APPOINTMENT CAN BECOME A DIFFERENT APPOINTMENT (VISIT-01, D-6,
 * D-18, D-23).
 *
 * The operator review at the Phase 5 close called this the biggest hole in the
 * product, and the sentence is worth keeping: *"the one thing a booked
 * appointment cannot do in this system is become a different appointment."*
 *
 * Mrs Hall is booked for a cut with Dana at 11:00. She sits down and says "and
 * can you do my roots while I'm here." Before this file the desk had three
 * answers and all three were wrong:
 *
 *  - CANCEL AND REBOOK — writes `cancelled_late` on a client who did nothing
 *    wrong, fires a cancellation notice at her while she is sitting in the
 *    chair, and poisons the one number A-024's dashboard exists to report.
 *  - A SECOND ADJACENT APPOINTMENT — refused by
 *    `appointment_block_no_overlap` the moment the cut's `bufferAfter` meets
 *    the colour's `bufferBefore`. D-23 spells this case out and forbids it.
 *  - AN OVERRIDE — trains the desk to dismiss the marker D-8 rests on, which
 *    is precisely how an override marker stops meaning anything.
 *
 * And the reverse costs more: she books a full head, arrives wanting a root
 * touch-up, and ninety minutes of a Saturday stays on the book unsellable
 * because nothing can shorten a visit.
 *
 * WHY THIS IS NOT `rescheduleAppointment`. That file's header says services
 * are deliberately not its business, and it is right — a reschedule MOVES an
 * appointment and must not re-sell it. This is the opposite operation: the
 * start does not move, the visit changes. What is shared is the SHAPE (D-6):
 * one row, one `UPDATE`, one transaction, conditional on what we decided
 * against, with the engine re-asked inside it.
 *
 * WHY IT ACCEPTS `in_progress` WHEN A RESCHEDULE DOES NOT. The two questions
 * look alike and have opposite answers — you cannot move an appointment once
 * she has sat down, and changing one is most often something you do precisely
 * because she has. `SERVICE_EDITABLE_STATUSES` is its own allow-list in the
 * one module that owns status lists, never a second copy.
 */
import {
  type VisitLine,
  canChangeServices,
  composeVisit,
  computeSlots,
} from '../../core/scheduling';
import { effectiveDurationMinutes, effectivePriceCents, visitPattern } from '../../core/settings';
import { type ZoneId, fromDate, instant, toDate, toLabel } from '../../core/time';
import type { Actor } from '../../core/auth';
import { BookingRejected, NoResourceFree, SlotNotOffered, SlotTaken } from '../booking/errors';
import { chairForMove, findFreeResource, requiredResourceTypeId, resourceTypeName } from '../booking/resources';
import { isSlotTakenError } from '../errors';
import { enqueueNotification } from '../notifications';
import { buildSlotQuery } from '../scheduling';
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { repointManageTokens } from './manage-token';

const MIN = 60_000;

/** The appointment is in a state whose services cannot be changed — finished,
 *  cancelled, or a no-show. Distinct from a refusal about the TIME. */
export class VisitNotEditable extends Error {
  readonly status: string;
  constructor(status: string) {
    super(`An appointment that is ${status.replace('_', ' ')} cannot have its services changed.`);
    this.name = 'VisitNotEditable';
    this.status = status;
  }
}

/** Somebody else changed this visit while we were deciding. The same shape as
 *  `AppointmentAlreadyMoved`, for the same reason: the conditional write. */
export class VisitAlreadyChanged extends Error {
  constructor() {
    super('This appointment has already been changed by somebody else.');
    this.name = 'VisitAlreadyChanged';
  }
}

export interface ChangeVisitServicesInput {
  appointmentId: string;
  /**
   * The WHOLE new ordered list, not a delta.
   *
   * Add, remove and reorder are one operation because order is load-bearing
   * (VISIT-01: the buffers come from the ends, so "cut then colour" is a
   * different appointment from "colour then cut"). A delta API would have to
   * invent an answer for "insert where?" that the caller already knows.
   */
  serviceIds: string[];
  /** Injected, never read from the clock here. */
  now: Date;
  actor: Actor;
  /** Staff by default — this is a desk action, and D-21/D-25's customer
   *  restrictions have no business refusing an add-on at the chair. */
  audience?: 'public' | 'staff';
  /** BOOK-05's door, for a lengthened visit the engine will not offer. */
  isOverride?: boolean;
  overrideReason?: string | null;
  reason?: string | null;
}

export interface ChangedVisit {
  id: string;
  endAt: Date;
  previousEndAt: Date;
  durationMinutes: number;
  totalPriceCents: number;
  /** Service names, for the sentence the desk reads back. */
  added: string[];
  removed: string[];
  /** True when the visit got shorter — the tail is now sellable, and
   *  `/staff/opened` shows it on the next read because it derives. */
  freedMinutes: number;
}

/**
 * Changes what an appointment is FOR, keeping its id, its start and its
 * provider.
 *
 * ONE TRANSACTION. The lines are deleted and rewritten inside it, which is the
 * distinction D-6 draws for reschedule restated for lines: delete-then-insert
 * is fine inside a single transaction; what is forbidden is two.
 */
export async function changeVisitServices(
  prisma: PrismaClient,
  input: ChangeVisitServicesInput,
): Promise<ChangedVisit> {
  const audience = input.audience ?? 'staff';
  const serviceIds = input.serviceIds.map((id) => id.trim()).filter(Boolean);
  if (serviceIds.length === 0) {
    throw new BookingRejected('serviceIds', 'A visit needs at least one service.');
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        const appointment = await tx.appointment.findUniqueOrThrow({
          where: { id: input.appointmentId },
          select: {
            id: true,
            businessId: true,
            providerId: true,
            status: true,
            startAt: true,
            endAt: true,
            resourceId: true,
            // A-063 — which chair is admissible depends on WHOSE it is.
            clientId: true,
            isOverride: true,
            bufferBeforeMinutes: true,
            bufferAfterMinutes: true,
            client: { select: { email: true, phone: true } },
            business: { select: { timezone: true } },
            lines: {
              orderBy: { ordinal: 'asc' },
              select: { serviceId: true, durationMinutes: true, priceCents: true, service: { select: { name: true } } },
            },
          },
        });

        if (!canChangeServices(appointment.status)) throw new VisitNotEditable(appointment.status);

        // The provider must be qualified for everything in the NEW list —
        // A-019's SVC-02 rule reused rather than restated. A service Dana
        // cannot do is a reschedule-with-provider, not an edit.
        const links = await resolveLinks(tx, appointment.providerId, serviceIds);

        // D-18, AND THE PART OF IT THAT IS NOT OBVIOUS: a line the client has
        // already agreed to keeps the price and duration it was booked with,
        // while a line added today takes today's. Re-pricing the cut she
        // booked in January because she added a colour in August is the same
        // defect D-18 exists to prevent, arriving through a door D-18 never
        // imagined.
        const kept = new Map<string, { durationMinutes: number; priceCents: number }[]>();
        for (const line of appointment.lines) {
          const list = kept.get(line.serviceId) ?? [];
          list.push({ durationMinutes: line.durationMinutes, priceCents: line.priceCents });
          kept.set(line.serviceId, list);
        }

        const lines: VisitLine[] = links.map((row) => {
          // Greedy per serviceId, so a visit that already held two cuts keeps
          // both snapshots rather than duplicating the first.
          const previous = kept.get(row.serviceId)?.shift();
          return {
            serviceId: row.serviceId,
            durationMinutes:
              previous?.durationMinutes ??
              effectiveDurationMinutes(row.service.durationMinutes, row.durationOverrideMinutes),
            priceCents: previous?.priceCents ?? effectivePriceCents(row.service.priceCents, row.priceOverrideCents),
            // BUFFERS ARE READ LIVE, and that is not an oversight. The
            // appointment snapshots only the COMPOSED pair, so a per-line
            // buffer from booking time is not recoverable — and buffers are
            // the salon's operational padding rather than something the client
            // agreed to, which is the same reasoning `slotsForMove` gives for
            // letting the query's buffers stand.
            bufferBeforeMinutes: row.service.bufferBeforeMinutes,
            bufferAfterMinutes: row.service.bufferAfterMinutes,
          };
        });

        const visit = composeVisit(lines);
        const endAt = toDate(instant(fromDate(appointment.startAt) + visit.durationMinutes * MIN));
        const previousEndAt = appointment.endAt;
        const unchanged =
          appointment.lines.length === lines.length &&
          appointment.lines.every((line, i) => line.serviceId === lines[i]!.serviceId);
        if (unchanged) {
          // Writing an event that says nothing happened, and re-pointing a
          // token that has not moved, is the same refusal `rescheduleAppointment`
          // makes for a move to where it already is.
          throw new BookingRejected('serviceIds', 'That is what she is already booked for.');
        }

        // D-29's snapshot, re-taken because the SHAPE of the visit genuinely
        // changed — a colour's processing gap is now part of this appointment
        // and the block trigger has to know.
        const segmentPattern = visitPattern(
          links.map((row, i) => ({
            durationMinutes: lines[i]!.durationMinutes,
            serviceDurationMinutes: row.service.durationMinutes,
            segments: row.service.segments,
          })),
        );

        const zone = appointment.business.timezone as ZoneId;
        const label = toLabel(fromDate(appointment.startAt), zone);

        // THE ENGINE, RE-ASKED WITH THE NEW DURATION. The exclusion constraint
        // is what actually enforces the overlap (D-2) and it is the backstop
        // below — but a lengthened visit that now runs past closing, or into
        // her break, is a question only the engine answers, and BOOK-05's
        // override is reached from this refusal.
        if (!input.isOverride && visit.durationMinutes > bookedMinutes(appointment.lines)) {
          await assertStillOffered(tx, {
            appointment,
            lines,
            visit,
            day: label.day,
            now: input.now,
            audience,
          });
        }

        // The chair, for the NEW envelope. A longer visit may not fit the
        // chair it is in even though the stylist is free — the axis A-034
        // separated.
        const blockedStart = toDate(instant(fromDate(appointment.startAt) - visit.bufferBeforeMinutes * MIN));
        const blockedEnd = toDate(instant(fromDate(endAt) + visit.bufferAfterMinutes * MIN));
        const resourceId = await chairFor(tx, appointment, serviceIds, blockedStart, blockedEnd, {
          // A-063 — the body is what a longer visit actually grows; the
          // envelope grows with it, and only the buffers may share.
          key: appointment.clientId,
          bodyStart: appointment.startAt,
          bodyEnd: endAt,
        });

        const written = await tx.appointment.updateMany({
          // CONDITIONAL ON THE END WE DECIDED AGAINST — two desks adding two
          // different services would otherwise both pass their re-checks and
          // both write, leaving one duration and two events that disagree.
          where: { id: appointment.id, endAt: appointment.endAt, status: appointment.status },
          data: {
            endAt,
            segmentPattern,
            bufferBeforeMinutes: visit.bufferBeforeMinutes,
            bufferAfterMinutes: visit.bufferAfterMinutes,
            ...(appointment.resourceId || resourceId ? { resourceId } : {}),
            // blockedStart/blockedEnd are recomputed by the A-003 trigger on
            // UPDATE, so the constraint and the busy set follow without this
            // file knowing the buffer arithmetic.
          },
        });
        if (written.count === 0) throw new VisitAlreadyChanged();

        // Rewritten wholesale rather than diffed: ordinal is positional, so a
        // reorder touches every row anyway, and a diff would be a second way
        // to be wrong about the order the buffers come from.
        await tx.appointmentServiceLine.deleteMany({ where: { appointmentId: appointment.id } });
        await tx.appointmentServiceLine.createMany({
          data: lines.map((line, ordinal) => ({
            businessId: appointment.businessId,
            appointmentId: appointment.id,
            serviceId: line.serviceId,
            ordinal,
            priceCents: line.priceCents,
            durationMinutes: line.durationMinutes,
          })),
        });

        // The link is RE-POINTED, never reissued — the expiry derives from the
        // end, which just moved. Reissuing would kill the link in the message
        // she is holding (D-28, and D-38's reading of it).
        await repointManageTokens(tx, appointment.id, endAt);

        const names = new Map(links.map((row) => [row.serviceId, row.service.name]));
        const before = appointment.lines.map((l) => l.serviceId);
        const after = lines.map((l) => l.serviceId);
        const added = difference(after, before).map((id) => names.get(id) ?? id);
        const removedIds = difference(before, after);
        const removed = removedIds.map((id) => appointment.lines.find((l) => l.serviceId === id)?.service.name ?? id);

        await tx.appointmentEvent.create({
          data: {
            businessId: appointment.businessId,
            appointmentId: appointment.id,
            type: 'services_changed',
            actor: input.actor.type,
            actorRef: input.actor.ref,
            reason: input.reason?.trim() || null,
            payload: {
              added,
              removed,
              // A-067. The names are what the log reads back; the IDS are what
              // "who else wants a colour on Saturday?" needs — `matchFreedSlot`
              // filters the waitlist on one `serviceId`, and the service she
              // DROPPED is the one to ring about, not the one she kept.
              removedServiceIds: removedIds,
              fromEndAt: previousEndAt.toISOString(),
              // A-067. The BLOCKED end, not just the body's: what a shortened
              // visit actually let go of runs to the end of the buffer it used
              // to carry, and that tail is genuinely sellable. Recorded here
              // because the row no longer holds it a millisecond after the
              // trigger recomputes — the same reason D-31 puts both sides of a
              // reschedule in the payload.
              fromBlockedEnd: toDate(instant(fromDate(previousEndAt) + appointment.bufferAfterMinutes * MIN)).toISOString(),
              toEndAt: endAt.toISOString(),
              durationMinutes: visit.durationMinutes,
              totalPriceCents: visit.totalPriceCents,
              ...(input.isOverride ? { override: true } : {}),
            } satisfies Prisma.InputJsonValue,
          },
        });

        // She is told the visit changed — the end time moved, which is the
        // part she plans her afternoon around. NOT a cancellation, which is
        // the entire point of this file existing.
        await enqueueNotification(tx, {
          businessId: appointment.businessId,
          // Keyed on the resulting END: changing twice is two messages,
          // retrying once is one (P1-7's shape).
          dedupeKey: `services:${appointment.id}:${fromDate(endAt)}`,
          appointmentId: appointment.id,
          channel: appointment.client?.email ? 'email' : 'sms',
          template: 'appointment.services_changed',
          recipient: appointment.client?.email ?? appointment.client?.phone ?? null,
          payload: {
            appointmentId: appointment.id,
            startAt: appointment.startAt.toISOString(),
            endAt: endAt.toISOString(),
            previousEndAt: previousEndAt.toISOString(),
            added,
            removed,
          },
        });

        return {
          id: appointment.id,
          endAt,
          previousEndAt,
          durationMinutes: visit.durationMinutes,
          totalPriceCents: visit.totalPriceCents,
          added,
          removed,
          freedMinutes: Math.max(0, Math.round((fromDate(previousEndAt) - fromDate(endAt)) / MIN)),
        };
      },
      { timeout: 15_000 },
    );
  } catch (error) {
    if (isSlotTakenError(error)) {
      // The constraint refused it: lengthening ran into the next client. She
      // still HAS her appointment as it was, which is why no alternatives are
      // computed — the honest answer is "that will not fit, hers is unchanged".
      throw new SlotTaken([]);
    }
    throw error;
  }
}

// ─────────────────────────── internals ───────────────────────────

/** The provider's own qualification rows, in the CALLER's order — the buffers
 *  come from the ends, so the order is the appointment. */
async function resolveLinks(tx: Prisma.TransactionClient, providerId: string, serviceIds: string[]) {
  const found = await tx.serviceProvider.findMany({
    where: { providerId, serviceId: { in: serviceIds } },
    include: { service: { include: { segments: { where: { status: 'active' }, orderBy: { ordinal: 'asc' } } } } },
  });
  const byService = new Map(found.map((row) => [row.serviceId, row]));
  return serviceIds.map((serviceId) => {
    const row = byService.get(serviceId);
    if (!row) {
      throw new BookingRejected('serviceIds', `This stylist is not qualified for service ${serviceId}.`);
    }
    return row;
  });
}

const bookedMinutes = (lines: readonly { durationMinutes: number }[]): number =>
  lines.reduce((total, line) => total + line.durationMinutes, 0);

/**
 * Would the engine still offer this start, now that the visit is longer?
 *
 * Only asked when it GREW. Shortening a visit can never make it less
 * bookable — it releases time — and running the check anyway would refuse a
 * downgrade on a day whose hours have since changed underneath the booking,
 * which is A-047's problem and not this one's.
 */
async function assertStillOffered(
  tx: Prisma.TransactionClient,
  args: {
    appointment: { id: string; businessId: string; providerId: string; startAt: Date };
    lines: VisitLine[];
    visit: { durationMinutes: number; bufferBeforeMinutes: number; bufferAfterMinutes: number };
    day: string;
    now: Date;
    audience: 'public' | 'staff';
  },
): Promise<void> {
  const { query } = await buildSlotQuery(tx, {
    businessId: args.appointment.businessId,
    providerId: args.appointment.providerId,
    serviceIds: args.lines.map((l) => l.serviceId),
    day: args.day,
    now: args.now,
    audience: args.audience,
    // It must not block its own new length — the same exclusion a move needs.
    excludeAppointmentId: args.appointment.id,
  });

  const result = computeSlots({
    ...query,
    service: {
      ...query.service,
      durationMinutes: args.visit.durationMinutes,
      bufferBeforeMinutes: args.visit.bufferBeforeMinutes,
      bufferAfterMinutes: args.visit.bufferAfterMinutes,
    },
    explain: true,
  });

  const start = fromDate(args.appointment.startAt);
  if (result.slots.some((slot) => slot.start === start)) return;

  const reasons = result.excluded.find((e) => e.candidateStart === start)?.reasons ?? [];
  // The same three-way split the booking and move paths make, so the desk gets
  // the same sentence for the same cause wherever it happens.
  if (
    reasons.includes('overlaps-booking') ||
    reasons.includes('overlaps-buffer') ||
    reasons.includes('overlaps-time-off') ||
    reasons.includes('overlaps-block')
  ) {
    throw new SlotTaken([...result.slots]);
  }
  if (reasons.includes('no-resource-free')) {
    throw new NoResourceFree(await resourceTypeName(tx, args.lines.map((l) => l.serviceId)));
  }
  throw new SlotNotOffered(reasons, [...result.slots]);
}

/**
 * The chair for the new envelope.
 *
 * Three cases, and the third is the one worth naming: a visit that GAINS a
 * service needing a chair when it had none (an override, or a service that
 * needs no resource) has to acquire one, so this cannot simply carry the old
 * `resourceId` forward.
 */
async function chairFor(
  tx: Prisma.TransactionClient,
  appointment: { id: string; businessId: string; resourceId: string | null; isOverride: boolean },
  serviceIds: string[],
  start: Date,
  end: Date,
  holder: { key: string | null; bodyStart: Date; bodyEnd: Date },
): Promise<string | null> {
  // An override holds no chair, by the same reasoning as D-8's zero-width
  // range: the room must never be what refuses staff a knowing decision.
  if (appointment.isOverride) return null;

  const resourceTypeId = await requiredResourceTypeId(tx, serviceIds);
  if (!resourceTypeId) return null;

  if (appointment.resourceId) {
    const kept = await chairForMove(tx, {
      businessId: appointment.businessId,
      appointmentId: appointment.id,
      resourceId: appointment.resourceId,
      start,
      end,
      holder,
    });
    if (!kept) throw new NoResourceFree(await resourceTypeName(tx, serviceIds));
    return kept;
  }

  const found = await findFreeResource(tx, { businessId: appointment.businessId, resourceTypeId, start, end, holder });
  if (!found) throw new NoResourceFree(await resourceTypeName(tx, serviceIds));
  return found;
}

/** Ids in `a` that are not in `b`, counting duplicates once — a visit that
 *  drops one of two identical services reports nothing added or removed, which
 *  is honest: what changed is the count, and the event carries the duration. */
function difference(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return [...new Set(a.filter((id) => !other.has(id)))];
}
