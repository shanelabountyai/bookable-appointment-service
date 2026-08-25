/**
 * THE SINGLE SOURCE OF TRUTH FOR APPOINTMENT STATUS (D-7).
 *
 * CLAUDE.md: "A status enum is never one edit." Every list that reads
 * appointment status — the exclusion-constraint predicate, the busy-set query,
 * reminder eligibility, day-view filters, the transition table — lives here or
 * is derived from here. Adding a state means changing this file and then
 * following the compiler and the tests to every reader.
 *
 * The rental build's `VERIFIED` defect was exactly this: a new state added to
 * the enum, and four readers that silently kept the old list. Here the readers
 * are enumerated below and a migration test asserts the DATABASE's constraint
 * predicate still matches ACTIVE_STATUSES — so the SQL and the TypeScript
 * cannot drift apart without a red test.
 */

export const APPOINTMENT_STATUSES = [
  'booked',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'no_show',
  'cancelled',
  'cancelled_late',
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * The statuses that FREE the slot. Only these two.
 *
 * Note that this is NOT the same as "terminal": `completed` and `no_show` are
 * terminal but still OCCUPY their time (D-7). Confusing the two sets is what
 * makes an appointment that already happened stop blocking its own slot, so the
 * day view shows a gap where a client was actually sitting.
 */
export const SLOT_FREEING_STATUSES = ['cancelled', 'cancelled_late'] as const;

/**
 * The constraint's partial predicate (D-15) and the busy set, derived — never
 * hand-typed a second time.
 *
 * The spec's literal SQL said `<> 'cancelled'`, which predates D-7's split and
 * would leave every late cancellation blocking its own slot forever. D-2's
 * phrase "the terminal set" is not a safe substitute either, for the reason
 * above.
 */
export const ACTIVE_STATUSES = APPOINTMENT_STATUSES.filter(
  (s): s is Exclude<AppointmentStatus, (typeof SLOT_FREEING_STATUSES)[number]> =>
    !(SLOT_FREEING_STATUSES as readonly string[]).includes(s),
);

/**
 * CLIENT-04's rolling counters: what "she has missed appointments" is made of.
 *
 * Two lists, deliberately not one. BOTH are counted and shown to staff — a
 * client who cancels an hour before, three times, has cost the salon the same
 * three slots as one who simply did not arrive. Only `no_show` COUNTS TOWARD
 * THE BLOCK, because the PRD's lever is "after N no-shows" and blocking on
 * late cancels would punish the client who did the more considerate thing.
 *
 * Here rather than in the counting query for the reason this whole file
 * exists: a ninth status would otherwise be counted by the day view and
 * ignored by the block, and nothing would fail.
 */
export const MISSED_STATUSES = ['no_show', 'cancelled_late'] as const;
export const SELF_SERVE_BLOCKING_STATUSES = ['no_show'] as const;

/**
 * NOTIF-02: who still gets a reminder. `booked` and `confirmed` only — a
 * positive allow-list rather than "not terminal", because `checked_in` and
 * `in_progress` are also non-terminal and already past their own start time,
 * so `TERMINAL_STATUSES` would let them through by accident.
 */
export const REMINDER_ELIGIBLE_STATUSES = ['booked', 'confirmed'] as const;

/** Terminal states: no transition leaves them, except the ≤7d staff correction
 *  between `no_show` and `completed` (APPT-06 — mis-taps are daily and the
 *  alternative is SQL surgery). */
export const TERMINAL_STATUSES = ['completed', 'no_show', 'cancelled', 'cancelled_late'] as const;

/**
 * A-055 (VISIT-01) — whose SERVICES may still be changed.
 *
 * A POSITIVE ALLOW-LIST, and deliberately NOT `canReschedule`'s list, which is
 * the whole point of the item. Rescheduling refuses `in_progress` because an
 * appointment already in the chair cannot be moved to Thursday — and "she is
 * in the chair and wants her roots doing too" is the exact scenario A-055
 * exists for. The two questions look alike and have opposite answers:
 *
 *   move it   → not once she has sat down
 *   change it → most often once she has sat down
 *
 * `checked_in` and `in_progress` are therefore IN. Everything terminal is out:
 * re-selling a completed visit is a refund or a new appointment, not an edit,
 * and adding a service to a no-show is a data-entry error with a price on it.
 */
export const SERVICE_EDITABLE_STATUSES = ['booked', 'confirmed', 'checked_in', 'in_progress'] as const;

/** Can this appointment's service lines still be changed (A-055)? */
export const canChangeServices = (status: AppointmentStatus): boolean =>
  (SERVICE_EDITABLE_STATUSES as readonly string[]).includes(status);

/** Does this status still occupy its time in the busy set? (D-7) */
export const occupiesTime = (status: AppointmentStatus): boolean =>
  (ACTIVE_STATUSES as readonly string[]).includes(status);

/** Renders the predicate for the hand-written migration, so the SQL in the
 *  migration and this module are provably the same list. The migration test
 *  compares the live constraint definition against this string. */
export const activeStatusSqlList = (): string =>
  ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ');

export const slotFreeingSqlList = (): string =>
  SLOT_FREEING_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * A-057 (D-39) — whose occurrences "End this series here" may cancel in bulk.
 *
 * A POSITIVE ALLOW-LIST again, and narrower than `SERVICE_EDITABLE_STATUSES`
 * on purpose. `checked_in` and `in_progress` are IN that list and OUT of this
 * one, because the two actions mean opposite things about the same client:
 *
 *   change it → she is in the chair, so of course
 *   end the series → she is in the chair, so NOT this one
 *
 * Cancelling an in-progress visit is a walk-out — a single deliberate act with
 * its own required reason (§7) — and folding it into a bulk action would text
 * a cancellation to a client who is sitting in front of the person who sent
 * it. The terminal four are out because they already happened or are already
 * cancelled: D-39's "there is no third reading for anybody to mean".
 *
 * Left-out occurrences are still LISTED by the preview with the reason. This
 * list decides what the action touches, never what the desk gets to see.
 */
export const SERIES_CANCELLABLE_STATUSES = ['booked', 'confirmed'] as const;

/** May this occurrence be cancelled as part of ending its series (A-057)? */
export const canEndSeriesAt = (status: AppointmentStatus): boolean =>
  (SERIES_CANCELLABLE_STATUSES as readonly string[]).includes(status);

/**
 * A-059 (APPT-03) — who is still ON THEIR WAY, and so still worth ringing.
 *
 * A POSITIVE ALLOW-LIST, and the third one in this file for the third time the
 * same trap was avoidable: a ninth status would otherwise land in the ring-list
 * by not being terminal, and the desk would ring a client who is sitting in
 * the waiting area.
 *
 * `checked_in` is OUT and that is the whole point: she is in the building, so
 * "we are running forty behind" is said to her face, and a phone call about it
 * is the salon looking like it does not know who is in its own waiting room.
 * `in_progress` is out because she is in the chair, and the terminal four are
 * out because there is nothing left to tell her.
 *
 * The same two members as `REMINDER_ELIGIBLE_STATUSES` today, deliberately not
 * the same constant: a reminder goes out the night before and this is a call
 * made in the next two hours, so the day one of them gains a member the other
 * must be able to refuse it.
 */
export const STILL_ON_THEIR_WAY_STATUSES = ['booked', 'confirmed'] as const;

/** Is this client still on her way, and so still worth a call (A-059)? */
export const isStillOnTheirWay = (status: AppointmentStatus): boolean =>
  (STILL_ON_THEIR_WAY_STATUSES as readonly string[]).includes(status);
