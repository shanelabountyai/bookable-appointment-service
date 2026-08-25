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
  SLOT_FREEING_STATUSES,
  canTransition,
  isCorrection,
  staffCancellationStatus,
} from '../../core/scheduling';
import { fromDate } from '../../core/time';
import { worstCutoff } from '../../core/settings';
import type { Actor } from '../../core/auth';
import { enqueueNotification } from '../notifications';
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
  /**
   * A-036 (operator P-5). `false` = "I already rang her, don't text."
   *
   * Only ever consulted for a STAFF cancellation. A client who cancels through
   * her own manage link does not need telling what she just did, and nothing
   * in this product cancels on its own (A-021: no auto-cancel, ever).
   */
  notify?: boolean;
  /**
   * A-060 (APPT-06) — THE DESK PRESSES ONE CANCEL BUTTON AND THIS DECIDES.
   *
   * `'derive'`: `to` is ignored and the resolved cutoff picks `cancelled` or
   * `cancelled_late`. `'override'`: the desk deliberately downgrades a late
   * one — "she gave us proper notice", "this one's on us" — which requires a
   * reason and records the overruled classification in the event, so the
   * owner can ask how many were overruled and by whom.
   *
   * STAFF ONLY by construction: the customer's manage link names its own
   * status (A-013) and must keep doing so, because a token holder choosing
   * between two cancellation statuses is the tell TOKEN-03 forbids.
   */
  cancellation?: 'derive' | 'override';
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
        client: { select: { email: true, phone: true } },
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

    const context = {
      actor: input.actor.type,
      now: fromDate(input.now),
      startAt: fromDate(appointment.startAt),
      endAt: fromDate(appointment.endAt),
      cancellationCutoffMinutes: cutoff.minutes,
      reason: input.reason,
    };

    // A-060. The classification is the MACHINE'S, made here where the cutoff
    // has just been resolved from real rows — never the front desk's guess and
    // never a second copy of the arithmetic on a screen. `to` is whatever the
    // caller asked for in every other case, so nothing else moves.
    const classified = input.cancellation ? staffCancellationStatus(from, context) : null;
    const to = input.cancellation === 'derive' ? classified! : input.to;

    // What the desk overruled, and only when there was genuinely something to
    // overrule: pressing the escape on an appointment that was on time anyway
    // is an ordinary cancellation, and demanding a reason for it would train
    // the desk to type "." into the box that has to mean something.
    const overruled = input.cancellation === 'override' && classified === 'cancelled_late' ? classified : null;
    if (overruled && !input.reason?.trim()) throw new TransitionRefused(from, to, 'reason-required');

    const decision = canTransition(from, to, context);

    if (!decision.allowed) throw new TransitionRefused(from, to, decision.refusal);

    // THE WRITE IS CONDITIONAL ON THE STATUS WE DECIDED AGAINST.
    //
    // Not a belt-and-braces re-check: under READ COMMITTED two concurrent
    // transitions can both read `booked` and both write, producing one status
    // and two events that disagree about what happened. Scoping the UPDATE by
    // status makes the database itself the arbiter, the same reflex as the
    // exclusion constraint — never check-then-write as the mechanism.
    const written = await tx.appointment.updateMany({
      where: { id: appointment.id, status: from },
      data: { status: to, ...timestampsFor(to, input.now, isCorrection(from, to)) },
    });

    if (written.count === 0) {
      const actual = await tx.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        select: { status: true },
      });
      throw new AppointmentMovedFirst(from, actual.status);
    }

    const correction = isCorrection(from, to);
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
          to,
          // A-060: "we called this one on time, and the machine would not
          // have." The only record that the classification was a human's, so
          // the owner's drill-down can count them and name who.
          ...(overruled ? { overruled } : {}),
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

    // A-036: the other half of "nothing is silently cancelled". The row goes
    // in THIS transaction, so a cancellation that commits without its notice
    // is not a state the database can hold — the same coupling the booking
    // confirmation has had since A-009.
    //
    // Staff only, and derived from the status module rather than hand-typed
    // (CLAUDE.md: a status list is never one edit).
    if (
      input.actor.type === 'staff' &&
      input.notify !== false &&
      (SLOT_FREEING_STATUSES as readonly AppointmentStatus[]).includes(to)
    ) {
      await enqueueNotification(tx, {
        // One cancellation of an appointment is one fact, so the appointment
        // id IS the key: a retried write path does not text her twice.
        dedupeKey: `cancelled:${appointment.id}`,
        businessId: appointment.businessId,
        appointmentId: appointment.id,
        channel: appointment.client?.email ? 'email' : 'sms',
        template: 'appointment.cancelled',
        recipient: appointment.client?.email ?? appointment.client?.phone ?? null,
        payload: {
          appointmentId: appointment.id,
          startAt: appointment.startAt.toISOString(),
          // A-019's reason, forwarded. "Salon closed Saturday" is the entire
          // message as far as the client is concerned.
          reason: input.reason?.trim() || null,
        },
      });
    }

    return { id: appointment.id, from, to, isCorrection: correction };
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
