'use client';

import { useActionState } from 'react';
import { type DetailState, saveVisitNote } from '@/lib/appointments/actions';

const initial: DetailState = {};

/**
 * A-070 — WRITING "6.3 + 20 VOL" WHERE THE STYLIST IS STANDING (CLIENT-03).
 *
 * The note existed and was editable on exactly one screen: the appointment
 * detail panel, three taps and a page load away. The operator's sentence is
 * the specification — *"if it takes three taps to write '6.3 + 20vol' it goes
 * on the scribble column instead"* — and the scribble column is paper that
 * gets binned at six, so next time you are guessing at the formula.
 *
 * A native `<details>`, the same reflex as the desk switcher (A-037): it costs
 * one line when closed, needs no state, and is keyboard-operable and
 * screen-reader-announced for free. Open, type, save — and the same server
 * action the detail panel uses, so there is one writer of this column and not
 * two.
 *
 * It lives on the STYLIST'S OWN LIST rather than on the grid chip because a
 * chip is `minutes * 1.5` pixels tall and the seeded fringe trim is ten of
 * them. A textarea does not fit; this list reflows.
 */
export function QuickNote({ appointmentId, notes }: { appointmentId: string; notes: string }) {
  const [state, action, pending] = useActionState(saveVisitNote, initial);

  return (
    <details className="w-full text-sm">
      <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
        {notes ? 'Change the note for this visit' : 'Add a note for this visit'}
      </summary>
      <form action={action} className="mt-2 flex flex-wrap items-start gap-2">
        <input type="hidden" name="appointmentId" value={appointmentId} />
        <label htmlFor={`quick-note-${appointmentId}`} className="sr-only">
          Note for this visit
        </label>
        <textarea
          id={`quick-note-${appointmentId}`}
          name="notes"
          rows={2}
          defaultValue={notes}
          placeholder="6.3 + 20 vol, 35 min"
          className="min-w-56 flex-1 rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-sm dark:border-zinc-600"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-zinc-400 px-3 py-2 font-medium disabled:opacity-60 dark:border-zinc-600"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <p aria-live="polite" className="w-full text-zinc-600 dark:text-zinc-400">
          {state.message ?? ''}
        </p>
      </form>
    </details>
  );
}
