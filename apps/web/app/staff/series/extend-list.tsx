'use client';

import { type ReactNode, useActionState, useEffect, useRef } from 'react';
import { type SeriesExtendState, extendSeriesAction } from '@/lib/appointments/series-actions';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { SeriesSummaryList } from '@/components/series-summary-list';

const initial: SeriesExtendState = {};

/**
 * A-152 (C11) — "extend by the same rule". One number and a button, like the
 * booking screen's repeat (D-35: no rule editor). The answer is the same
 * week-by-week list a new series gets, because it is the same partial booking.
 *
 * A-153 (E1) — ONE result for the whole list, rendered ABOVE it. A successful
 * extend is exactly what takes her row off the list (nothing runs out inside
 * the window any more), so a result inside the row unmounted itself the moment
 * it was written, and the focused button went with it. The result outlives
 * the row and takes focus.
 */
export function ExtendList({
  rows,
  empty,
}: {
  rows: { seriesId: string; requested: number; about: string; body: ReactNode }[];
  empty: ReactNode;
}) {
  const [state, submit, pending] = useActionState(extendSeriesAction, initial);
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.ok) result.current?.focus();
  }, [state]);

  return (
    <>
      <div ref={result} tabIndex={-1} className="flex flex-col gap-2 outline-none">
        {/* Always mounted, so the result is announced (C4). */}
        <p role="status" className={state.ok === false ? 'text-attention-ink' : 'font-medium'}>
          {state.message ? (state.about ? `${state.about}: ${state.message}` : state.message) : ''}
        </p>
        {state.series ? <SeriesSummaryList lines={state.series.lines} /> : null}
      </div>
      {rows.length === 0 ? (
        empty
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li
              key={row.seriesId}
              className="flex flex-col gap-2 rounded-control border border-line-hairline bg-ground-raised p-4 text-body"
            >
              {row.body}
              <form action={submit} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="seriesId" value={row.seriesId} />
                <input type="hidden" name="requested" value={row.requested} />
                <input type="hidden" name="about" value={row.about} />
                <Field id={`count-${row.seriesId}`} label="How many more">
                  {(control) => (
                    <Input
                      {...control}
                      type="number"
                      name="count"
                      min={1}
                      max={104}
                      defaultValue={Math.min(row.requested, 104)}
                      className="w-24"
                    />
                  )}
                </Field>
                <Button type="submit" pending={pending} aria-label={`Extend ${row.about}`}>
                  Extend
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
