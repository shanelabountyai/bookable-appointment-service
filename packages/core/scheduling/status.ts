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

/** Terminal states: no transition leaves them, except the ≤7d staff correction
 *  between `no_show` and `completed` (APPT-06 — mis-taps are daily and the
 *  alternative is SQL surgery). */
export const TERMINAL_STATUSES = ['completed', 'no_show', 'cancelled', 'cancelled_late'] as const;

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
