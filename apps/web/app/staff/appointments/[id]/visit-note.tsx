'use client';

import { useActionState } from 'react';
import { type DetailState, saveVisitNote } from '@/lib/appointments/actions';

const initial: DetailState = {};

/** CLIENT-03's PER-VISIT note — "bring the reference photo", "patch test done
 *  12/4". Deliberately separate from the pinned client note: mixing them
 *  buries the allergy line under six months of one-off reminders. */
export function VisitNote({ appointmentId, notes }: { appointmentId: string; notes: string }) {
  const [state, action, pending] = useActionState(saveVisitNote, initial);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <label htmlFor="visit-note" className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
        Note for this visit
      </label>
      <textarea
        id="visit-note"
        name="notes"
        rows={2}
        defaultValue={notes}
        className="rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-sm dark:border-zinc-600"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-zinc-600"
        >
          {pending ? 'Saving…' : 'Save note'}
        </button>
        <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
          {state.message ?? ''}
        </p>
      </div>
    </form>
  );
}
