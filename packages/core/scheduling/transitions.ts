/**
 * THE §7 TRANSITION TABLE (APPT-01, APPT-05, APPT-06; D-7). Pure.
 *
 * The PRD's table is normative and this is its only encoding. Nothing else in
 * the repo may decide whether a status change is legal — a second `if
 * (status === 'cancelled')` somewhere is the rental `VERIFIED` defect starting
 * over, and it starts silently.
 *
 * Companion to `status.ts`, which owns the SETS (which statuses are active,
 * which free the slot, which are terminal). This file owns the EDGES. Between
 * them they are the whole of "what is a status allowed to be and do".
 *
 * Reschedule is deliberately not a state here (D-6). It is an event on a
 * surviving row, permitted from `booked`/`confirmed` only, and it lives in
 * A-014 — modelling it as a transition would make the same-row UPDATE look
 * like a cancel-and-rebook, which is exactly the two-transaction shape D-6
 * forbids.
 */
import type { ActorType } from '../auth';
import type { Instant } from './types';
import { TERMINAL_STATUSES, type AppointmentStatus } from './status';

/** APPT-06's grace period, in physical milliseconds.
 *
 *  Deliberately a DURATION and not seven calendar days: a grace period is a
 *  physical span, and counting calendar days across a DST transition would
 *  make the window an hour longer or shorter depending on the month. Seven
 *  days is seven days. */
export const CORRECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Why a transition was refused. Machine-readable on purpose: a caller has to
 *  be able to tell "you may not do that" from "not yet" from "too late", and a
 *  human-readable string is not something a route can branch on. The customer
 *  wording (D-10) is chosen at the surface, never here. */
export type TransitionRefusal =
  | 'same-status'
  | 'not-permitted'
  | 'actor-not-permitted'
  | 'before-appointment-start'
  | 'inside-cancellation-cutoff'
  | 'outside-cancellation-cutoff'
  | 'correction-window-closed'
  | 'reason-required';

export type TransitionDecision =
  | { allowed: true; isCorrection: boolean }
  | { allowed: false; refusal: TransitionRefusal };

export interface TransitionContext {
  actor: ActorType;
  now: Instant;
  startAt: Instant;
  /** The appointment's scheduled end — the correction window counts from here
   *  (APPT-06: "within 7 days of appointment end"). */
  endAt: Instant;
  /**
   * The cutoff that applies to THIS appointment, already resolved.
   *
   * Resolution is the database layer's job: D-19 lets a service override the
   * business default and a visit may carry several service lines, so picking
   * the applicable one needs rows this module must not see. Passing the
   * resolved number keeps the table pure and keeps the resolution in one
   * place that can be tested against real services.
   */
  cancellationCutoffMinutes: number;
  reason?: string | null | undefined;
}

type Precondition = 'after-start' | 'outside-cutoff' | 'inside-cutoff' | 'within-correction-window';

interface Clause {
  actor: ActorType;
  precondition?: Precondition;
  requiresReason?: boolean;
}

/**
 * §7, transcribed. Rows = from, keys = to. An absent key is `·`.
 *
 * `system` appears nowhere, and that is a statement rather than an omission:
 * no automatic transition exists in v1. Nothing marks an appointment
 * `no_show` because the clock passed it — a stylist running forty minutes late
 * would otherwise watch the book cancel her afternoon. When an automatic
 * transition is wanted it gets a row here and a clause with `actor: 'system'`,
 * and every test below reacts.
 */
const TRANSITIONS: Partial<Record<AppointmentStatus, Partial<Record<AppointmentStatus, readonly Clause[]>>>> = {
  booked: {
    confirmed: [{ actor: 'staff' }, { actor: 'customer_token' }],
    checked_in: [{ actor: 'staff' }],
    in_progress: [{ actor: 'staff' }],
    // "only after startAt" — marking a no-show before the appointment has even
    // begun is always a mis-tap, and it would free nothing anyway (D-7).
    no_show: [{ actor: 'staff', precondition: 'after-start' }],
    cancelled: [{ actor: 'staff' }, { actor: 'customer_token', precondition: 'outside-cutoff' }],
    cancelled_late: [{ actor: 'staff' }, { actor: 'customer_token', precondition: 'inside-cutoff' }],
  },
  confirmed: {
    checked_in: [{ actor: 'staff' }],
    in_progress: [{ actor: 'staff' }],
    no_show: [{ actor: 'staff', precondition: 'after-start' }],
    cancelled: [{ actor: 'staff' }, { actor: 'customer_token', precondition: 'outside-cutoff' }],
    cancelled_late: [{ actor: 'staff' }, { actor: 'customer_token', precondition: 'inside-cutoff' }],
  },
  checked_in: {
    in_progress: [{ actor: 'staff' }],
    completed: [{ actor: 'staff' }],
    // no_show is absent on purpose: they are standing at the desk.
    cancelled: [{ actor: 'staff' }],
  },
  in_progress: {
    completed: [{ actor: 'staff' }],
    // A walk-out. Reason required — it is the only record of why a service in
    // progress produced no service.
    cancelled: [{ actor: 'staff', requiresReason: true }],
  },
  // APPT-06's terminal corrections, the ONLY edges leaving a terminal state.
  completed: {
    no_show: [{ actor: 'staff', precondition: 'within-correction-window', requiresReason: true }],
  },
  no_show: {
    completed: [{ actor: 'staff', precondition: 'within-correction-window', requiresReason: true }],
  },
  // cancelled and cancelled_late have no outgoing edges at all. Reinstating a
  // cancellation is a NEW booking, because the slot was genuinely released and
  // may already have been sold to somebody else.
};

/**
 * May this appointment move from `from` to `to`?
 *
 * The single decision point. Routes, server actions and the database layer all
 * ask this and none of them re-implement any part of it.
 */
export function canTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
  context: TransitionContext,
): TransitionDecision {
  if (from === to) return { allowed: false, refusal: 'same-status' };

  const decision = decide(TRANSITIONS[from]?.[to], context);
  return decision.allowed ? { allowed: true, isCorrection: isCorrection(from, to) } : decision;
}

/**
 * MAY THIS APPOINTMENT BE MOVED (D-6, APPT-05)?
 *
 * Reschedule is not a status, so it has no cell in §7 — but it is the same
 * KIND of question, so it is answered here, by the same clause machinery, and
 * never by a route deciding for itself.
 *
 * The cutoff clause is the point. APPT-05: "Customer reschedule inside the
 * cutoff is refused identically — a reschedule is a cancellation with extra
 * steps." Without it the cutoff is decorative: a customer inside it simply
 * moves the appointment to next month and abandons it, and the salon has lost
 * the slot with none of the record that a late cancellation leaves.
 *
 * `checked_in` and `in_progress` are absent for staff too, deliberately: the
 * client is in the building. Moving an appointment that is happening is not a
 * reschedule, it is a correction to when it started (APPT-03), and that is
 * A-018's timestamps rather than this.
 */
export function canReschedule(from: AppointmentStatus, context: TransitionContext): RescheduleDecision {
  return decide(RESCHEDULABLE[from], context);
}

export type RescheduleDecision = { allowed: true } | { allowed: false; refusal: TransitionRefusal };

/** Rows = the status being moved FROM. An absent key means "not movable" —
 *  the four terminal states and the two in-the-chair ones. */
const RESCHEDULABLE: Partial<Record<AppointmentStatus, readonly Clause[]>> = {
  booked: [{ actor: 'staff' }, { actor: 'customer_token', precondition: 'outside-cutoff' }],
  confirmed: [{ actor: 'staff' }, { actor: 'customer_token', precondition: 'outside-cutoff' }],
};

/** The clause loop, shared by both questions above. The first refusal is kept
 *  only if NO clause for this actor passes — a move may be permitted by more
 *  than one clause for the same actor. */
function decide(clauses: readonly Clause[] | undefined, context: TransitionContext): RescheduleDecision {
  if (!clauses || clauses.length === 0) return { allowed: false, refusal: 'not-permitted' };

  const mine = clauses.filter((c) => c.actor === context.actor);
  if (mine.length === 0) return { allowed: false, refusal: 'actor-not-permitted' };

  let firstRefusal: TransitionRefusal | null = null;
  for (const clause of mine) {
    const refusal = check(clause, context);
    if (refusal === null) return { allowed: true };
    firstRefusal ??= refusal;
  }
  return { allowed: false, refusal: firstRefusal! };
}

/** A terminal→terminal move: APPT-06's `no_show ↔ completed` mis-tap fix.
 *  Surfaced so callers can log it as a CORRECTION rather than as an ordinary
 *  status change — "we got this wrong" is a different fact from "this
 *  happened", and the operator asked for it to read that way. */
export function isCorrection(from: AppointmentStatus, to: AppointmentStatus): boolean {
  const terminal = TERMINAL_STATUSES as readonly string[];
  return terminal.includes(from) && terminal.includes(to);
}

/** Every status reachable from here by anyone, ignoring preconditions. For
 *  building a staff UI's action list; never for authorising one. */
export function possibleTransitionsFrom(from: AppointmentStatus): AppointmentStatus[] {
  return Object.keys(TRANSITIONS[from] ?? {}) as AppointmentStatus[];
}

/**
 * WHAT THIS ACTOR MAY DO TO THIS APPOINTMENT RIGHT NOW (A-035).
 *
 * `possibleTransitionsFrom` answers a question about the TABLE; this answers
 * one about an appointment — the same edges, filtered by the preconditions
 * that depend on the clock and the actor. It exists because two surfaces now
 * draw status buttons (the detail panel and the day chip), and a surface that
 * assembles this list for itself is the rental `VERIFIED` defect starting
 * over: two screens quietly disagreeing about what is allowed.
 *
 * `reason` is supplied by the CALLER's context. Passing a placeholder asks
 * "would this be allowed if a reason were given?", which is the right question
 * for a form that has a reason box; leaving it empty asks "is this allowed
 * with no reason at all?", which is the right question for a bare button. The
 * write path re-asks either way — nothing here is trusted.
 */
export function availableTransitions(
  from: AppointmentStatus,
  context: TransitionContext,
): AppointmentStatus[] {
  return possibleTransitionsFrom(from).filter((to) => canTransition(from, to, context).allowed);
}

function check(clause: Clause, context: TransitionContext): TransitionRefusal | null {
  if (clause.requiresReason && !context.reason?.trim()) return 'reason-required';

  switch (clause.precondition) {
    case 'after-start':
      return context.now >= context.startAt ? null : 'before-appointment-start';
    case 'outside-cutoff':
      return isInsideCancellationCutoff(context) ? 'inside-cancellation-cutoff' : null;
    case 'inside-cutoff':
      return isInsideCancellationCutoff(context) ? null : 'outside-cancellation-cutoff';
    case 'within-correction-window':
      return context.now - context.endAt <= CORRECTION_WINDOW_MS ? null : 'correction-window-closed';
    case undefined:
    default:
      return null;
  }
}

/**
 * Is `now` within the cancellation cutoff of the appointment's START?
 *
 * Boundary: exactly ON the cutoff counts as INSIDE. A cutoff of 24 hours means
 * "we need a day's notice", so an appointment cancelled with precisely 24
 * hours to go has given the notice — but the arithmetic here compares against
 * the cutoff instant, and landing exactly on it is the ambiguous case. It is
 * resolved toward the salon, deliberately and only once: the customer at the
 * boundary is told it counts as late, which is recoverable by a phone call,
 * whereas the reverse silently loses the salon a chargeable slot.
 *
 * EXPORTED for A-057, which has to decide `cancelled` vs `cancelled_late` for
 * several occurrences at once and show that answer in a preview BEFORE the
 * write. Every other caller reaches it through a precondition above; a bulk
 * action cannot, because §7 lets staff write either status unconditionally —
 * so the choice is the caller's, and it must be made with this arithmetic
 * rather than a second copy of it.
 */
export function isInsideCancellationCutoff(context: TransitionContext): boolean {
  return context.now >= context.startAt - context.cancellationCutoffMinutes * 60_000;
}

/**
 * A-060 (APPT-06, D-19) — WHICH KIND OF CANCELLATION IS THIS?
 *
 * §7 lets staff write either cancellation status unconditionally, which is
 * right — the table is about what is PERMITTED. But a permission is not a
 * default, and until this item the front desk was handed two buttons a
 * thumb-width apart and no guidance, so `cancelled` vs `cancelled_late` was
 * an artifact of which one was nearer. That value then lands on the client's
 * rolling late-cancel count (CLIENT-04) and on the owner's staffing decisions.
 *
 * The system already knows the answer: it has the cutoff and it has the clock.
 * So the desk presses ONE button and this decides, with the SAME arithmetic
 * the customer's own manage link meets — no second copy of it anywhere.
 *
 * THE `canTransition` CHECK IS NOT BELT-AND-BRACES. From `checked_in` and
 * `in_progress` §7 permits `cancelled` only, and it is right to: a client
 * standing at the desk or sitting in the chair has not cancelled late, she has
 * arrived and something else has happened. Deriving `cancelled_late` from the
 * clock alone would produce a status the table refuses, and the one button
 * would then fail on exactly the walk-out it is most needed for.
 */
export function staffCancellationStatus(
  from: AppointmentStatus,
  context: TransitionContext,
): 'cancelled' | 'cancelled_late' {
  if (!isInsideCancellationCutoff(context)) return 'cancelled';
  return canTransition(from, 'cancelled_late', context).allowed ? 'cancelled_late' : 'cancelled';
}

/** Is a cancellation of ANY kind on the table right now (A-060)? The two
 *  statuses collapse to one button, so a surface asks this rather than looking
 *  for either one in `availableTransitions`. */
export function canCancel(from: AppointmentStatus, context: TransitionContext): boolean {
  return (
    canTransition(from, 'cancelled', context).allowed ||
    canTransition(from, 'cancelled_late', context).allowed
  );
}
