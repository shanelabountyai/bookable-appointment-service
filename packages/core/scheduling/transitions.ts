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

  const clauses = TRANSITIONS[from]?.[to];
  if (!clauses || clauses.length === 0) return { allowed: false, refusal: 'not-permitted' };

  const mine = clauses.filter((c) => c.actor === context.actor);
  if (mine.length === 0) return { allowed: false, refusal: 'actor-not-permitted' };

  // The first refusal is kept only if NO clause for this actor passes — a
  // status may be reachable by more than one route for the same actor.
  let firstRefusal: TransitionRefusal | null = null;
  for (const clause of mine) {
    const refusal = check(clause, context);
    if (refusal === null) return { allowed: true, isCorrection: isCorrection(from, to) };
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

function check(clause: Clause, context: TransitionContext): TransitionRefusal | null {
  if (clause.requiresReason && !context.reason?.trim()) return 'reason-required';

  switch (clause.precondition) {
    case 'after-start':
      return context.now >= context.startAt ? null : 'before-appointment-start';
    case 'outside-cutoff':
      return insideCutoff(context) ? 'inside-cancellation-cutoff' : null;
    case 'inside-cutoff':
      return insideCutoff(context) ? null : 'outside-cancellation-cutoff';
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
 */
function insideCutoff(context: TransitionContext): boolean {
  return context.now >= context.startAt - context.cancellationCutoffMinutes * 60_000;
}
