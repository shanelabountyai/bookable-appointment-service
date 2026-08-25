'use client';

import { useActionState, useState, useTransition } from 'react';
import {
  type SeriesEndPreview,
  type SeriesEndState,
  endSeries,
  previewSeriesEnd,
} from '@/lib/appointments/series-actions';

const initial: SeriesEndState = {};

/**
 * A-057 (D-39) — one action to undo what one action created.
 *
 * PREVIEW FIRST, always: the desk is on the phone to the client, and the two
 * things it has to be able to say before agreeing to anything are which dates
 * are about to go and which of them count as a late cancellation. D-35 read
 * that per-occurrence variation as a reason the action could not exist; it is
 * the reason this list exists.
 *
 * Behind a `<details>` on purpose. Cancelling four appointments should not be
 * a button sitting open beside "Move this appointment".
 */
export function EndSeriesPanel({ appointmentId }: { appointmentId: string }) {
  const [state, submit, ending] = useActionState(endSeries, initial);
  const [preview, setPreview] = useState<SeriesEndPreview | null>(null);
  const [previewing, startPreview] = useTransition();

  const doomed = preview?.rows.filter((row) => !row.problem) ?? [];

  return (
    <details className="rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700">
      <summary className="cursor-pointer font-medium">End this series here</summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-zinc-600 dark:text-zinc-400">
          Cancels this appointment and the ones after it. The ones she has already had are not touched.
        </p>

        <button
          type="button"
          className="self-start rounded-md border border-zinc-400 px-3 py-1.5 font-medium dark:border-zinc-600"
          onClick={() => startPreview(async () => setPreview(await previewSeriesEnd(appointmentId)))}
        >
          {preview ? 'Check again' : 'Show me what goes'}
        </button>

        {previewing ? <p aria-live="polite">Checking…</p> : null}

        {preview ? (
          <>
            <ul className="flex flex-col gap-1">
              {preview.rows.map((row) => (
                <li key={row.appointmentId} className={row.problem ? 'text-amber-800 dark:text-amber-300' : ''}>
                  {row.when}
                  {/* The two facts the desk says out loud, per row. */}
                  {row.problem ? ` — stays: ${row.problem}` : row.insideCutoff ? ' — counts as a late cancellation' : ''}
                </li>
              ))}
            </ul>

            {preview.rows.length === 0 ? <p>There is nothing left to cancel.</p> : null}

            <form action={submit} className="flex flex-col gap-2">
              <input type="hidden" name="appointmentId" value={appointmentId} />
              <label className="flex flex-col gap-1">
                Why?
                <input
                  name="reason"
                  placeholder="She is moving away"
                  className="rounded-md border border-zinc-400 bg-transparent px-2 py-1 dark:border-zinc-600"
                />
              </label>
              {/* D-32: UNTICKED means she is told. The box exists for the desk
                  that rang her first — it is never the default. */}
              <label className="flex items-center gap-2">
                <input type="checkbox" name="skipNotice" />
                I have already rung her — do not send anything
              </label>
              <button
                type="submit"
                disabled={ending || !preview.canEnd}
                className="self-start rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {ending ? 'Cancelling…' : `Cancel ${doomed.length} appointment${doomed.length === 1 ? '' : 's'}`}
              </button>
            </form>
          </>
        ) : null}

        {state.message ? (
          <p aria-live="polite" className={state.ok ? '' : 'text-amber-800 dark:text-amber-300'}>
            {state.message}
          </p>
        ) : null}
      </div>
    </details>
  );
}
