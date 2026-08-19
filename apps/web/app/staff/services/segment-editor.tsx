'use client';

import { useActionState, useState } from 'react';
import { type FormState, saveSegments } from '@/lib/settings/service-actions';

const initial: FormState = {};

export interface SegmentDraft {
  durationMinutes: number;
  isGap: boolean;
}

/**
 * SEG-01's editor. A service is either one duration (no rows) or an ordered
 * list of parts; the total is shown live because the parts ARE the total —
 * `replaceSegments` writes the service's duration from them.
 *
 * Rows are held in local state and posted as parallel `segmentMinutes` /
 * `segmentIsGap` arrays, so ordinal is position and cannot drift.
 */
export function SegmentEditor({
  serviceId,
  serviceName,
  durationMinutes,
  segments,
}: {
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  segments: SegmentDraft[];
}) {
  const [state, action, pending] = useActionState(saveSegments, initial);
  const [rows, setRows] = useState<SegmentDraft[]>(segments);

  const total = rows.reduce((sum, r) => sum + (Number.isFinite(r.durationMinutes) ? r.durationMinutes : 0), 0);
  const gapTotal = rows.filter((r) => r.isGap).reduce((sum, r) => sum + r.durationMinutes, 0);
  const update = (i: number, patch: Partial<SegmentDraft>) =>
    setRows(rows.map((row, j) => (i === j ? { ...row, ...patch } : row)));

  return (
    <details>
      <summary className="mt-2 cursor-pointer text-sm text-zinc-500">
        Parts ({rows.length === 0 ? `one, ${durationMinutes} min` : `${rows.length}, ${gapTotal} min of it a gap`})
      </summary>

      <p className="mt-2 text-xs text-zinc-500">
        A <strong>gap</strong> is time the client is here but you are not needed — colour developing. Splitting a
        service does not change how it is booked yet; it makes the free minutes visible on the day so the desk can use
        them.
      </p>

      <form action={action} className="mt-3 flex flex-col gap-2">
        <input type="hidden" name="serviceId" value={serviceId} />

        {rows.map((row, i) => (
          // Position IS the identity here: ordinal is the array index, rows
          // have no id until they are saved, and editing is add/remove.
          <div key={i} className="flex items-center gap-2">
            <span className="w-6 text-xs text-zinc-400">{i + 1}.</span>
            <label className="sr-only" htmlFor={`${serviceId}-seg-${i}-min`}>
              Part {i + 1} minutes for {serviceName}
            </label>
            <input
              id={`${serviceId}-seg-${i}-min`}
              name="segmentMinutes"
              type="number"
              min={1}
              value={Number.isFinite(row.durationMinutes) ? row.durationMinutes : ''}
              onChange={(e) => update(i, { durationMinutes: Number(e.target.value) })}
              className="w-20 rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <span className="text-xs text-zinc-500">min</span>
            <input type="hidden" name="segmentIsGap" value={row.isGap ? 'true' : 'false'} />
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={row.isGap}
                onChange={(e) => update(i, { isGap: e.target.checked })}
                className="h-4 w-4"
              />
              Gap
            </label>
            <button
              type="button"
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
              className="ml-auto rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Remove part {i + 1}
            </button>
          </div>
        ))}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() =>
              setRows([
                ...rows,
                // A new part defaults to whatever is unaccounted for, so
                // splitting a 120-minute colour in two is two clicks and no
                // arithmetic.
                { durationMinutes: rows.length === 0 ? durationMinutes : Math.max(1, durationMinutes - total), isGap: false },
              ])
            }
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Add a part
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {pending ? 'Saving…' : 'Save parts'}
          </button>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {rows.length === 0 ? `Unsegmented — ${durationMinutes} min` : `Total ${total} min`}
          </p>
        </div>

        <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
          {state.errors?.segments ?? (state.ok ? state.message : '')}
        </p>
      </form>
    </details>
  );
}
