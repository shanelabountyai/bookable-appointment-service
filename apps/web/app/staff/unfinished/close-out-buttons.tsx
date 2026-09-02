'use client';

import { useActionState } from 'react';
import { type CloseOutState, closeOut } from '@/lib/appointments/close-out-actions';

const initial: CloseOutState = {};

/**
 * A-076 / D-46 — the two answers that actually apply at six o'clock.
 *
 * *She came* and *she didn't*. Not a status picker: the desk is not choosing
 * between eight states, it is answering one question about a client it
 * remembers, and every extra option is a row that stays open instead.
 *
 * A form per row, like A-061's and A-072's beside it: `useActionState` is one
 * hook per component instance, and a shared one would show row three's result
 * next to row one.
 */
export function CloseOutButtons({ appointmentId }: { appointmentId: string }) {
  const [state, action, pending] = useActionState(closeOut, initial);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <button
        name="came"
        value="yes"
        type="submit"
        disabled={pending}
        className="rounded-md border border-zinc-400 px-3 py-1.5 text-sm font-medium disabled:opacity-60 dark:border-zinc-600"
      >
        She came
      </button>
      {/* Not styled as a danger button. It is not a punishment, it is the other
          half of the truth — and CLIENT-04's counter is only worth anything if
          the desk taps this as readily as the one beside it. */}
      <button
        name="came"
        value="no"
        type="submit"
        disabled={pending}
        className="rounded-md border border-zinc-400 px-3 py-1.5 text-sm font-medium disabled:opacity-60 dark:border-zinc-600"
      >
        She didn&apos;t
      </button>
      {state.message ? (
        <span aria-live="polite" className="text-xs text-zinc-600 dark:text-zinc-400">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
