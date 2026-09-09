'use client';

import { readableDay } from '@/lib/customer-format';

/**
 * A-106 — WHAT THE DESK SAYS AFTER "NOT THAT DAY".
 *
 * Three staff refusals dead-ended in the same sentence — "try another day" —
 * said to somebody on the phone who has just asked "when CAN you fit me in?".
 * The customer answers that for herself on `/manage/{token}`; this is the same
 * answer, on the surfaces the salon uses.
 *
 * ONE COMPONENT for all three, so the wording and the shape of the answer
 * cannot drift apart per surface. It renders only — the days come from one
 * server action per panel, both of which run the real engine (SLOT-07).
 *
 * `null` is "we have not looked yet" and renders nothing; `[]` is "we looked
 * and there is nothing", which is a different sentence and the one that must
 * not be silent. A component that treated them the same would say nothing
 * after a fortnight of nothing, and the desk would read the silence as a
 * screen that had not finished.
 *
 * No pending state of its own: both panels compute the days inside the same
 * transition as the times they explain, so this only ever renders once that
 * transition has settled — and a second spinner underneath the first would be
 * a lie about a request that is already done.
 */
export function OpenDays({ days, onPick }: { days: string[] | null; onPick: (day: string) => void }) {
  if (days === null) return null;
  if (days.length === 0) {
    return <p className="text-sm text-ink-muted">Nothing in the next fortnight either — try a date further out.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink-muted">The next days with room:</p>
      <ul className="flex flex-wrap gap-2">
        {days.map((day) => (
          <li key={day}>
            <button
              type="button"
              onClick={() => onPick(day)}
              className="rounded-md border border-zinc-400 px-3 py-2 text-sm dark:border-zinc-600"
            >
              {readableDay(day)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
