'use client';

import { useActionState } from 'react';
import { type FormState, saveClientNotes } from '@/lib/clients/actions';

const initial: FormState = {};

/** CLIENT-03's long-lived note: formula, allergies. Distinct from the
 *  per-visit note on the appointment, which is where "bring the reference
 *  photo" goes — mixing them buries the allergy line under six months of
 *  one-off reminders. */
export function NotesForm({ clientId, notes }: { clientId: string; notes: string }) {
  const [state, formAction, pending] = useActionState(saveClientNotes, initial);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="clientId" value={clientId} />
      <label htmlFor="notes" className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Pinned note
      </label>
      <p className="text-sm text-zinc-500">Shown on every appointment for this client. Formula, allergies, anything that must not be missed.</p>
      <textarea
        id="notes"
        name="notes"
        rows={3}
        defaultValue={notes}
        className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-zinc-700"
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
