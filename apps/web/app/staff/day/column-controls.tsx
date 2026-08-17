'use client';

import { useActionState, useState, useTransition } from 'react';
import {
  type DayActionState,
  type PreviewShape,
  clearColumnRunningLate,
  confirmColumnPush,
  previewColumnPush,
  setColumnRunningLate,
} from '@/lib/day/actions';

const initial: DayActionState = {};
const field = 'w-16 rounded-md border border-zinc-400 bg-transparent px-2 py-1 text-sm dark:border-zinc-600';
const small = 'rounded-md border border-zinc-400 px-2 py-1 text-xs font-medium dark:border-zinc-600';

/**
 * A-018's two controls, side by side on the column header, because they answer
 * two different questions the desk asks in the same breath:
 *
 *  - "Dana is running forty behind" — a claim, one tap, changes no times.
 *  - "Push everything from 2pm" — an action, previewed, that changes them all.
 *
 * They look different on purpose. Anything that made them feel like the same
 * button would eventually make one do the other's job.
 */
export function ColumnControls({
  providerId,
  providerName,
  day,
  runningLateMinutes,
  pushFrom,
}: {
  providerId: string;
  providerName: string;
  day: string;
  runningLateMinutes: number | null;
  /** The instant "from here" means: the first appointment still to come. Null
   *  when there is nothing left to push. */
  pushFrom: string | null;
}) {
  const [lateState, setLate, settingLate] = useActionState(setColumnRunningLate, initial);
  const [, clearLate, clearing] = useActionState(clearColumnRunningLate, initial);
  const [pushState, doPush, pushing] = useActionState(confirmColumnPush, initial);

  const [minutes, setMinutes] = useState('15');
  const [preview, setPreview] = useState<PreviewShape | null>(null);
  const [previewing, startPreview] = useTransition();

  return (
    <div className="flex flex-col gap-2 pb-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {runningLateMinutes ? (
          <>
            <span className="rounded-sm bg-amber-200 px-2 py-1 font-semibold text-amber-950 dark:bg-amber-900 dark:text-amber-100">
              +{runningLateMinutes} min
            </span>
            <form action={clearLate}>
              <input type="hidden" name="providerId" value={providerId} />
              <input type="hidden" name="day" value={day} />
              <button type="submit" disabled={clearing} className={small}>
                Back on time
              </button>
            </form>
          </>
        ) : (
          <form action={setLate} className="flex items-center gap-1">
            <input type="hidden" name="providerId" value={providerId} />
            <input type="hidden" name="day" value={day} />
            <label htmlFor={`late-${providerId}`} className="text-zinc-600 dark:text-zinc-400">
              Behind by
            </label>
            <input id={`late-${providerId}`} name="minutes" defaultValue="15" inputMode="numeric" className={field} />
            <button type="submit" disabled={settingLate} className={small}>
              Set
            </button>
          </form>
        )}
      </div>

      {lateState.message && !lateState.ok ? (
        <p aria-live="polite" className="text-amber-800 dark:text-amber-300">
          {lateState.message}
        </p>
      ) : null}

      {pushFrom ? (
        <details className="rounded-md border border-zinc-300 p-2 dark:border-zinc-700">
          <summary className="cursor-pointer font-medium">Push the column</summary>
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex items-center gap-1">
              <label htmlFor={`push-${providerId}`} className="text-zinc-600 dark:text-zinc-400">
                {/* Not "By": it is a substring of "Behind by" just above,
                    which makes the two controls sound the same read aloud. */}
                Push by
              </label>
              <input
                id={`push-${providerId}`}
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                inputMode="numeric"
                className={field}
              />
              <button
                type="button"
                className={small}
                onClick={() =>
                  startPreview(async () => {
                    setPreview(await previewColumnPush(providerId, day, pushFrom, Number(minutes)));
                  })
                }
              >
                Preview
              </button>
            </div>

            {previewing ? <p className="text-zinc-600 dark:text-zinc-400">Checking…</p> : null}

            {preview ? (
              <>
                <ul className="flex flex-col gap-1">
                  {preview.rows.map((row) => (
                    <li key={row.appointmentId} className={row.problem ? 'text-amber-800 dark:text-amber-300' : ''}>
                      {row.from} → {row.to} {row.clientName ?? 'Walk-in'}
                      {/* APPT-04's collision preview: named, before anything
                          moves, because a column that half-moved is worse
                          than one that did not. */}
                      {row.problem === 'past-closing' ? ' — would fall past closing' : ''}
                    </li>
                  ))}
                </ul>

                {preview.rows.length === 0 ? <p>Nothing left to move.</p> : null}

                <form action={doPush} className="flex flex-col gap-2">
                  <input type="hidden" name="providerId" value={providerId} />
                  <input type="hidden" name="day" value={day} />
                  <input type="hidden" name="fromAt" value={pushFrom} />
                  <input type="hidden" name="minutes" value={minutes} />
                  <label className="flex flex-col gap-1">
                    Why?
                    <input
                      name="reason"
                      placeholder={`${providerName} is running behind`}
                      className="rounded-md border border-zinc-400 bg-transparent px-2 py-1 dark:border-zinc-600"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={pushing || !preview.canPush}
                    className="self-start rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    {pushing ? 'Moving…' : `Move ${preview.rows.length} and tell them`}
                  </button>
                </form>
              </>
            ) : null}

            {pushState.message ? (
              <p aria-live="polite" className={pushState.ok ? '' : 'text-amber-800 dark:text-amber-300'}>
                {pushState.message}
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
