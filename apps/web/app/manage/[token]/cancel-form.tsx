'use client';

import { useActionState } from 'react';
import { type CancelState, cancelAppointment } from '@/lib/manage/actions';

const initial: CancelState = {};

/**
 * The token travels in a hidden field rather than an appointment id, so no
 * internal identifier is ever in the page for a customer to see or a browser
 * extension to read (TOKEN-03). The server resolves it again on submit — this
 * form carries no authority of its own.
 */
export function CancelForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(cancelAppointment, initial);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
      >
        {pending ? 'Cancelling…' : 'Cancel this appointment'}
      </button>
      <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
        {state.message ?? ''}
      </p>
    </form>
  );
}
