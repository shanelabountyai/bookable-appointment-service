/**
 * A-012 — moving an appointment through its lifecycle (APPT-01, 05, 06, 07).
 *
 * The ONE place a status is written. Everything about *whether* a move is
 * legal lives in `packages/core/scheduling/transitions.ts`; everything here is
 * the database work of doing it: resolving the cutoff from real rows, writing
 * the status with the actual timestamps that go with it, and appending the
 * event that makes it auditable.
 *
 * The busy set takes care of itself. `blockedStart`/`blockedEnd` are never
 * touched by a transition — the exclusion constraint and the busy-set query
 * are both partial over `ACTIVE_STATUSES` (D-15), so cancelling frees the time
 * by the status change alone and `completed`/`no_show` keep occupying it
 * (D-7). Any code here that adjusted the blocked range would be a second,
 * disagreeing mechanism.
 */
import {
  type AppointmentStatus,
  type TransitionRefusal,
  canTransition,
  isCorrection,
} from '../../core/scheduling';
import { fromDate } from '../../core/time';
import { worstCutoff } from '../../core/settings';
import type { Actor } from '../../core/auth';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = PrismaClient;

/** The move is not legal. Carries the machine-readable reason so a route can
 *  map it — 409 for a lost race, 403 for the wrong actor, 422 for a missing
 *  reason — instead of flattening every refusal into one status code. */
export class TransitionRefused extends Error {
  readonly refusal: TransitionRefusal;
  readonly from: AppointmentStatus;
  readonly to: AppointmentStatus;
  constructor(from: AppointmentStatus, to: AppointmentStatus, refusal: TransitionRefusal) {
    super(`Cannot move an appointment from ${from} to ${to}: ${refusal}.`);
    this.name = 'TransitionRefused';
    this.refusal = refusal;
    this.from = from;
    this.to = to;
  }
}

/**
 * Somebody else moved this appointment first.
 *
 * Two people at the front desk tapping "check in" on the same client is an
 * ordinary Saturday, not an exotic race. Carries the status actually found so
 * the screen can say "Priya already checked her in" rather than "conflict".
 */
export class AppointmentMovedFirst extends Error {
  readonly expected: AppointmentStatus;
  readonly actual: AppointmentStatus;
  constructor(expected: AppointmentStatus, actual: AppointmentStatus) {
    super(`Expected the appointment to still be ${expected}, but it is ${actual}.`);
    this.name = 'AppointmentMovedFirst';
    this.expected = expected;
    this.actual = actual;
  }
}

export interface TransitionInput {
  appointmentId: string;
  to: AppointmentStatus;
  actor: Actor;
  /** Injected, never read from the clock here — the cutoff and the
   *  seven-day correction window both depend on it, so a test that cannot
   *  freeze it cannot test either boundary (CLAUDE.md). */
  now: Date;
  /** Required by APPT-06 corrections and by the in-progress walk-out. */
  reason?: string | null;
  /**
   * The status the caller believes it is moving FROM.
   *
   * Optional, and worth passing from any screen that showed the user a status:
   * it turns "the button did nothing surprising" into an explicit
   * `AppointmentMovedFirst`. Omitted, the current row's status is used and the
   * update is still atomic — see the conditional write below.
   */
  expectedFrom?: AppointmentStatus;
}

export interface TransitionResult {
  id: string;
  from: AppointmentStatus;
  to: AppointmentStatus;
  isCorrection: boolean;
}

export async function transitionAppointment(db: Db, input: TransitionInput): Promise<TransitionResult> {
  return db.$transaction(async (tx) => {
    const appointment = await tx.appointment.findUniqueOrThrow({
      where: { id: input.appointmentId },
      select: {
        id: true,
        businessId: true,
        status: true,
        startAt: true,
        endAt: true,
        checkedInAt: true,
        startedAt: true,
        endedAt: true,
        business: { select: { cancellationCutoffMinutes: true } },
        lines: { select: { service: { select: { id: true, name: true, cancellationCutoffMinutes: true } } } },
      },
    });

    const from = appointment.status;
    if (input.expectedFrom && input.expectedFrom !== from) {
      throw new AppointmentMovedFirst(input.expectedFrom, from);
    }

    // D-19: a service may demand more notice than the business default, and a
    // visit may carry several. The most restrictive one governs — reusing the
    // same `worstCutoff` the settings form validates against, so the rule a
    // customer meets is the rule the owner was shown.
    const cutoff = worstCutoff(
      appointment.business.cancellationCutoffMinutes,
      appointment.lines.map((l) => ({
        id: l.service.id,
        name: l.service.name,
        cancellationCutoffMinutes: l.service.cancellationCutoffMinutes,
      })),
    );

    const decision = canTransition(from, input.to, {
      actor: input.actor.type,
      now: fromDate(input.now),
      startAt: fromDate(appointment.startAt),
      endAt: fromDate(appointment.endAt),
      cancellationCutoffMinutes: cutoff.minutes,
      reason: input.reason,
    });

    if (!decision.allowed) throw new TransitionRefused(from, input.to, decision.refusal);

    // THE WRITE IS CONDITIONAL ON THE STATUS WE DECIDED AGAINST.
    //
    // Not a belt-and-braces re-check: under READ COMMITTED two concurrent
    // transitions can both read `booked` and both write, producing one status
    // and two events that disagree about what happened. Scoping the UPDATE by
    // status makes the database itself the arbiter, the same reflex as the
    // exclusion constraint — never check-then-write as the mechanism.
    const written = await tx.appointment.updateMany({
      where: { id: appointment.id, status: from },
      data: { status: input.to, ...timestampsFor(input.to, input.now, isCorrection(from, input.to)) },
    });

    if (written.count === 0) {
      const actual = await tx.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        select: { status: true },
      });
      throw new AppointmentMovedFirst(from, actual.status);
    }

    const correction = isCorrection(from, input.to);
    await tx.appointmentEvent.create({
      data: {
        businessId: appointment.businessId,
        appointmentId: appointment.id,
        // A correction is a different fact from a status change — "we got this
        // wrong" rather than "this happened" — and the detail panel renders
        // them differently (APPT-07).
        type: correction ? 'status_corrected' : 'status_changed',
        actor: input.actor.type,
        actorRef: input.actor.ref,
        reason: input.reason?.trim() || null,
        payload: {
          from,
          to: input.to,
          // Kept because the update above may have cleared them: a no-show did
          // not arrive, so its arrival timestamps must not survive the
          // correction, and the log is then the only record they existed.
          ...(correction
            ? {
                clearedCheckedInAt: appointment.checkedInAt?.toISOString() ?? null,
                clearedStartedAt: appointment.startedAt?.toISOString() ?? null,
                clearedEndedAt: appointment.endedAt?.toISOString() ?? null,
              }
            : {}),
        } satisfies Prisma.InputJsonValue,
      },
    });

    return { id: appointment.id, from, to: input.to, isCorrection: correction };
  });
}

/**
 * The ACTUAL timestamps (D-7's "actual-vs-scheduled").
 *
 * `startAt`/`endAt` stay as scheduled forever; these record what really
 * happened, which is what makes "she was forty minutes late" answerable and
 * what A-018's running-late column is built on.
 *
 * Correcting to `no_show` CLEARS them, because a client who never arrived
 * cannot have a check-in time — leaving one behind would let a no-show report
 * and an arrival report disagree, and the prior values are preserved in the
 * event payload. Correcting the other way sets nothing: nobody knows when a
 * visit that was mis-marked as a no-show actually ended, and inventing
 * `now` — days later, at correction time — would be a fabricated measurement.
 */
function timestampsFor(to: AppointmentStatus, now: Date, correction: boolean) {
  // A correction happens DAYS after the fact (up to seven, APPT-06), so `now`
  // is not when anything happened. It may only clear, never stamp.
  if (correction) {
    return to === 'no_show' ? { checkedInAt: null, startedAt: null, endedAt: null } : {};
  }

  switch (to) {
    case 'confirmed':
      return { confirmedAt: now };
    case 'checked_in':
      return { checkedInAt: now };
    case 'in_progress':
      return { startedAt: now };
    case 'completed':
      return { endedAt: now };
    case 'no_show':
      return { checkedInAt: null, startedAt: null, endedAt: null };
    default:
      return {};
  }
}
