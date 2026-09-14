/**
 * NOTIF-02's window, pure (spec X-3, X-4).
 *
 * TWO DECISIONS, both already made by the spec review rather than left for a
 * caller to improvise:
 *
 *  - PHYSICAL 24 HOURS, not "the same wall time yesterday" (X-3). Both
 *    readings are defensible; the spec's point is that only one may be
 *    undocumented, and it picked instant arithmetic — DST-proof by the same
 *    integer-epoch-millis reasoning the engine core uses everywhere. On a
 *    spring-forward morning the reminder for a 09:00 appointment fires at what
 *    the wall clock the day before calls 08:00, and that is intended, not a
 *    bug to chase.
 *  - A 5-MINUTE WIDTH (X-4), so an interval trigger firing at least that often
 *    never leaves a gap between one tick's window and the next. Two ticks
 *    catching the same appointment — a late trigger, a retry — is a harmless
 *    duplicate at `enqueueNotification`'s dedupeKey, never a double send.
 */
import { type Instant, instant } from '../time';

/**
 * The template name every reader of "was she reminded?" asks about. It lived
 * as a private copy in `stale.ts` and a string literal in `reminders.ts`, and
 * A-108 needed a third — which is one more than this repo lets a fact have.
 */
export const REMINDER_TEMPLATE = 'appointment.reminder';

export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;
export const REMINDER_WINDOW_MS = 5 * 60 * 1000;

export interface ReminderWindow {
  /** Inclusive. */
  readonly start: Instant;
  /** Exclusive — half-open, same convention as every other interval here. */
  readonly end: Instant;
}

/** The appointments due a reminder right now: those starting in
 *  `[now + 24h, now + 24h + 5m)`. */
export function reminderWindow(now: Instant): ReminderWindow {
  return {
    start: instant(now + REMINDER_LEAD_MS),
    end: instant(now + REMINDER_LEAD_MS + REMINDER_WINDOW_MS),
  };
}

/**
 * THE IDENTITY OF ONE REMINDER — the appointment AND the instant it is a
 * reminder FOR, which the schema has required since P1-7 and which this
 * function now makes the only way to say.
 *
 * A-117 exported it because the second reader got it wrong. `sendDueReminders`
 * built this string inline; `listMissedReminders` asked instead whether the
 * appointment held ANY reminder row, and those two are the same question only
 * until somebody moves. A client reminded for Saturday and moved to Wednesday
 * holds a row keyed to Saturday's instant — so she vanished off the list of
 * people nobody has told, while the Wednesday sweep correctly wrote her a
 * second key. The wrong half was the one that decides what the desk SEES.
 *
 * Takes an `Instant`, not a `Date`: the key is an instant identity (D-4), and
 * a caller that has a `Date` converts through the one module that may.
 */
export function reminderDedupeKey(appointmentId: string, startAt: Instant): string {
  return `reminder-24h:${appointmentId}:${startAt}`;
}
