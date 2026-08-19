'use client';

import { useActionState } from 'react';
import { type ConfirmState, confirmAppointment } from '@/lib/manage/actions';

const initial: ConfirmState = {};

/** Same shape as `CancelForm` (TOKEN-03): the token travels in a hidden
 *  field, never an appointment id. */
export function ConfirmForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(confirmAppointment, initial);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {pending ? 'Confirming…' : "I'll be there"}
      </button>
      <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
        {state.message ?? ''}
      </p>
    </form>
  );
}
