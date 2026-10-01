'use client';

import { useActionState } from 'react';
import { type SeriesExtendState, extendSeriesAction } from '@/lib/appointments/series-actions';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { SeriesSummaryList } from '@/components/series-summary-list';

const initial: SeriesExtendState = {};

/**
 * A-152 (C11) — "extend by the same rule". One number and a button, like the
 * booking screen's repeat (D-35: no rule editor). The answer is the same
 * week-by-week list a new series gets, because it is the same partial booking.
 */
export function ExtendForm({
  seriesId,
  requested,
  defaultCount,
  about,
}: {
  seriesId: string;
  requested: number;
  defaultCount: number;
  about: string;
}) {
  const [state, submit, pending] = useActionState(extendSeriesAction, initial);

  return (
    <div className="flex flex-col gap-2">
      {state.ok ? null : (
        <form action={submit} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="seriesId" value={seriesId} />
          <input type="hidden" name="requested" value={requested} />
          <Field id={`count-${seriesId}`} label="How many more">
            {(control) => (
              <Input {...control} type="number" name="count" min={1} max={104} defaultValue={defaultCount} className="w-24" />
            )}
          </Field>
          <Button type="submit" pending={pending} aria-label={`Extend ${about}`}>
            Extend
          </Button>
        </form>
      )}
      {/* Always mounted, so the result is announced (C4). */}
      <p role="status" className={state.ok === false ? 'text-attention-ink' : 'font-medium'}>
        {state.message ?? ''}
      </p>
      {state.series ? <SeriesSummaryList lines={state.series.lines} /> : null}
    </div>
  );
}
