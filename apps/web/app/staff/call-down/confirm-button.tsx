'use client';

import { useActionState } from 'react';
import { type DetailState, changeStatus } from '@/lib/appointments/actions';

const initial: DetailState = {};

/**
 * One tap for "she said yes" — the desk is already on the phone with her, so
 * this asks the same `changeStatus` action the appointment detail page's
 * status controls do (booked → confirmed, `actor: 'staff'`), not a new path.
 *
 * A form per row rather than one shared action state, because `useActionState`
 * is one hook per component instance and this list has many rows — each needs
 * its own pending/message, or confirming row three would show its result next
 * to row one.
 */
export function ConfirmButton({ appointmentId }: { appointmentId: string }) {
  const [state, formAction, pending] = useActionState(changeStatus, initial);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="to" value="confirmed" />
      <input type="hidden" name="expectedFrom" value="booked" />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-zinc-400 px-2 py-1 text-xs font-medium disabled:opacity-60 dark:border-zinc-600"
      >
        {pending ? 'Confirming…' : 'Confirmed'}
      </button>
      {state.message ? <span className="text-xs text-zinc-500">{state.message}</span> : null}
    </form>
  );
}
