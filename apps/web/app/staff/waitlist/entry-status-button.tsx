'use client';

import { useActionState } from 'react';
import { type FormState, updateEntryStatus } from '@/lib/waitlist/actions';

const initial: FormState = {};

/** One tap to close an entry out, in either direction — booked elsewhere
 *  (`fulfilled`) or no longer wanted (`cancelled`). A form per row, same
 *  reasoning as the call-down list's `ConfirmButton`: `useActionState` is one
 *  hook per instance, and each row needs its own pending state. */
export function EntryStatusButton({
  entryId,
  status,
  label,
}: {
  entryId: string;
  status: 'fulfilled' | 'cancelled';
  label: string;
}) {
  const [state, formAction, pending] = useActionState(updateEntryStatus, initial);

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="status" value={status} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-zinc-400 px-2 py-1 text-xs font-medium disabled:opacity-60 dark:border-zinc-600"
      >
        {pending ? '…' : label}
      </button>
      {state.message ? <span className="sr-only" aria-live="polite">{state.message}</span> : null}
    </form>
  );
}
