'use client';

import { useActionState, useState, useTransition } from 'react';
import {
  type OfferedTime,
  type OpenDay,
  type RescheduleState,
  listRescheduleTimes,
  rescheduleToTime,
} from '@/lib/manage/actions';

const initial: RescheduleState = {};

/**
 * Two choices and a button (D-10: "reschedule", never "rebook" or "move slot").
 *
 * The days are rendered by the server; the times for the chosen day are
 * fetched, because computing 28 days of slots up front to show one day's worth
 * is 27 wasted engine runs on every page load.
 *
 * The radio's VALUE IS THE INSTANT (D-4), never the label the customer reads.
 * On the day the clocks go back, two of these labels say "01:30" and they are
 * an hour apart; posting the label back would be a coin flip.
 */
export function RescheduleForm({ token, days }: { token: string; days: OpenDay[] }) {
  const [state, formAction, submitting] = useActionState(rescheduleToTime, initial);
  const [day, setDay] = useState('');
  const [times, setTimes] = useState<OfferedTime[]>([]);
  const [loading, startLoading] = useTransition();

  // Fetched in the handler rather than in an effect: choosing a day IS the
  // event, so there is no state to synchronize and an effect would only add a
  // cascading render between the click and the request.
  function chooseDay(chosen: string) {
    setDay(chosen);
    startLoading(async () => {
      setTimes(chosen ? await listRescheduleTimes(token, chosen) : []);
    });
  }

  if (days.length === 0) {
    return <p className="text-sm text-zinc-500">There is nothing free in the next few weeks — please call us.</p>;
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />

      <div className="flex flex-col gap-1">
        <label htmlFor="reschedule-day" className="text-sm font-medium">
          Move to which day?
        </label>
        <select
          id="reschedule-day"
          value={day}
          onChange={(event) => chooseDay(event.target.value)}
          className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
        >
          <option value="">Choose a day…</option>
          {days.map((open) => (
            <option key={open.day} value={open.day}>
              {open.label}
            </option>
          ))}
        </select>
      </div>

      {day ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">What time?</legend>
          {loading ? (
            <p className="text-sm text-zinc-500">Looking…</p>
          ) : times.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing free that day. Try another.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {times.map((time) => (
                <li key={time.at}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-300 px-3 py-2 text-sm has-[:checked]:border-zinc-900 dark:border-zinc-700 dark:has-[:checked]:border-zinc-100">
                    <input type="radio" name="at" value={time.at} required />
                    {time.label}
                    {time.qualifier ? <span className="text-zinc-500">{time.qualifier}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting || times.length === 0}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {submitting ? 'Moving…' : 'Reschedule'}
        </button>
        <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
          {state.message ?? ''}
        </p>
      </div>
    </form>
  );
}
