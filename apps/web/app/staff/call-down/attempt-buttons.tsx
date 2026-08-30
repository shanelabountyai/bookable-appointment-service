'use client';

import { useActionState } from 'react';
import type { CallAttempt, CallAttemptOutcome } from '@bookable/db/appointments';
import { type AttemptState, recordAttempt } from '@/lib/appointments/call-down-actions';

const initial: AttemptState = {};

/**
 * A-061 — "we already rang her" (APPT-02).
 *
 * The desk gets through nine of eighteen, three of them no answer, and then a
 * walk-in arrives. Without this the list at 4pm is identical to the list at
 * 2pm, so the next person starts at the top and rings six people twice — which
 * reads to the client as a salon that does not know what it is doing, and is
 * exactly why a paper list ends up beside the screen.
 *
 * TWO OUTCOMES, NOT A TICK. "No answer" is still on the list to try again;
 * "left a message" is the ball in her court. A boolean would make a tried row
 * unactionable, which is the state the Post-it existed to escape.
 *
 * A form per row, like `ConfirmButton` beside it: `useActionState` is one hook
 * per component instance, and a shared one would show row three's result next
 * to row one.
 */
export function AttemptButtons({
  appointmentId,
  attempt,
}: {
  appointmentId: string;
  attempt: CallAttempt | null;
}) {
  const [state, formAction, pending] = useActionState(recordAttempt, initial);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="appointmentId" value={appointmentId} />

      {/* Both stay available on a tried row: "no answer at 2, left a message
          at 4" re-stamps the same row, so correcting a mis-pressed outcome
          needs no separate control. */}
      <button name="outcome" value="no_answer" type="submit" disabled={pending} className={button(attempt, 'no_answer')}>
        No answer
      </button>
      <button
        name="outcome"
        value="left_message"
        type="submit"
        disabled={pending}
        className={button(attempt, 'left_message')}
      >
        Left a message
      </button>

      {/* The undo. A mis-tap on a SHARED screen marks the wrong client as
          rung, which silently skips her — the harm this row exists to prevent,
          inverted — so it has to be reversible by the same hand. */}
      {attempt ? (
        <button
          name="outcome"
          value="clear"
          type="submit"
          disabled={pending}
          className="text-xs text-zinc-500 underline underline-offset-4 disabled:opacity-60"
        >
          Not rung
        </button>
      ) : null}

      {state.message ? (
        <span aria-live="polite" className="text-xs text-zinc-500">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

/** The pressed outcome reads as pressed. `aria-pressed` is not available on a
 *  submit button that is also the form's payload, so the state is carried by
 *  the visible style and by the sentence on the row beside it. */
const button = (attempt: CallAttempt | null, outcome: CallAttemptOutcome) =>
  [
    'rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-60',
    attempt?.outcome === outcome
      ? 'border-zinc-800 bg-zinc-800 text-zinc-50 dark:border-zinc-200 dark:bg-zinc-200 dark:text-zinc-900'
      : 'border-zinc-400 dark:border-zinc-600',
  ].join(' ');

/** What the row says it knows, in the words the desk would use. TOTAL over the
 *  enum, so a third outcome is a compile error rather than a raw value on a
 *  screen — the same discipline `STATUS_ACTION_LABELS` uses. */
export const ATTEMPT_WORDS = {
  no_answer: 'No answer',
  left_message: 'Left a message',
} satisfies Record<CallAttemptOutcome, string>;
