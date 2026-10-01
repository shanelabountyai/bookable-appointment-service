'use client';

import { useActionState, useState } from 'react';
import { type FormState, saveClientNotes } from '@/lib/clients/actions';

const initial: FormState = {};

/** CLIENT-03's long-lived note: formula, allergies. Distinct from the
 *  per-visit note on the appointment, which is where "bring the reference
 *  photo" goes — mixing them buries the allergy line under six months of
 *  one-off reminders. */
export function NotesForm({
  clientId,
  notes,
  versionId,
  lastChangedBy,
}: {
  clientId: string;
  notes: string;
  /** The version the page loaded, or `null` if this client has no note
   *  history yet. Round-tripped as `baseVersionId` — OQ-23(a) refuses a save
   *  whose base no longer matches what is on the row. */
  versionId: string | null;
  lastChangedBy: string | null;
}) {
  const [state, formAction, pending] = useActionState(saveClientNotes, initial);
  // A refusal hands back the CURRENT version id, so submitting a second time
  // (a deliberate overwrite, once the person has read both texts) goes
  // through rather than refusing again.
  const [baseVersionId, setBaseVersionId] = useState(versionId);
  // React resets a `<form action>`'s own uncontrolled fields once the action
  // returns — including a REFUSED submit, which would otherwise wipe what she
  // typed at the exact moment OQ-23(a) needs her to still have it. Controlled,
  // and re-seeded from what the refused submit actually carried.
  const [text, setText] = useState(notes);
  const [handledConflictAt, setHandledConflictAt] = useState<string | null>(null);

  if (state.conflict && state.conflict.baseVersionId !== handledConflictAt) {
    setBaseVersionId(state.conflict.baseVersionId);
    setText(state.conflict.attemptedText);
    setHandledConflictAt(state.conflict.baseVersionId);
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="baseVersionId" value={baseVersionId ?? ''} />
      <label htmlFor="notes" className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
        Pinned note
      </label>
      <p className="text-sm text-ink-muted">Shown on every appointment for this client. Formula, allergies, anything that must not be missed.</p>
      {lastChangedBy ? <p className="text-xs text-ink-muted">Last changed by {lastChangedBy}.</p> : null}
      {/* A-154 (E2): the alert exists before the conflict does; `empty:hidden`
          keeps it from drawing a box until there is something in it. */}
      <div
        role="alert"
        className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm empty:hidden dark:border-amber-900 dark:bg-amber-950/30"
      >
        {state.conflict ? (
          <>
          <p>
            Someone changed this note{state.conflict.currentAuthor ? ` (${state.conflict.currentAuthor})` : ''} while
            you had it open. Your save was not applied. What&rsquo;s on file now:
          </p>
          <p className="whitespace-pre-wrap rounded-md bg-white/60 p-2 dark:bg-black/20">{state.conflict.currentText || '(cleared)'}</p>
          <p>Copy what you still need into the box below, then save again to keep it.</p>
          </>
        ) : null}
      </div>
      <textarea
        id="notes"
        name="notes"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
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
          {state.conflict ? '' : (state.message ?? '')}
        </p>
      </div>
    </form>
  );
}
