'use client';

import { useActionState, useState, useTransition } from 'react';
import { type MoveOption, type MoveState, moveAppointment, staffMoveOptions } from '@/lib/appointments/reschedule-actions';

const initial: MoveState = {};

/**
 * "Can you push my 3 o'clock to 4?" — the most common phone call in the salon,
 * and until A-033 the desk had no answer but cancel-and-rebook.
 *
 * A NATIVE DATE INPUT, not a list of days with openings. The customer's flow
 * offers a curated 28-day list because she is browsing; the desk is not
 * browsing — it is on the phone with somebody who has already said "next
 * Tuesday" or "same time in six weeks". A date box answers that in one gesture
 * and costs no engine runs at all, where the day list costs one per day.
 * Staff are uncapped by the booking horizon (D-21), so there is nothing to
 * clamp it to either.
 *
 * The radio's VALUE IS THE INSTANT (D-4). On the day the clocks go back two of
 * these labels read "01:30" an hour apart, and posting the label back would be
 * a coin flip.
 */
export function MovePanel({
  appointmentId,
  currentDay,
  currentProviderId,
  providers,
}: {
  appointmentId: string;
  currentDay: string;
  currentProviderId: string;
  /** Active and qualified for the WHOLE visit, decided on the server
   *  (SVC-02). This component never filters them. */
  providers: { id: string; name: string }[];
}) {
  const [state, formAction, submitting] = useActionState(moveAppointment, initial);
  const [day, setDay] = useState(currentDay);
  const [providerId, setProviderId] = useState(currentProviderId);
  const [times, setTimes] = useState<MoveOption[]>([]);
  const [looked, setLooked] = useState(false);
  const [loading, startLoading] = useTransition();

  // Fetched on the change event rather than in an effect: choosing a day or a
  // stylist IS the event, so there is nothing to synchronize. Both re-ask,
  // because the times are the DESTINATION provider's — A-038's whole point is
  // that Dana's calendar says nothing about Priya's two o'clock.
  function look(nextDay: string, nextProviderId: string) {
    setDay(nextDay);
    setProviderId(nextProviderId);
    setLooked(false);
    startLoading(async () => {
      setTimes(nextDay ? await staffMoveOptions(appointmentId, nextDay, nextProviderId) : []);
      setLooked(Boolean(nextDay));
    });
  }

  return (
    <form
      action={formAction}
      id="move"
      className="flex flex-col gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
    >
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="toProviderId" value={providerId} />

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="move-day" className="text-sm font-medium">
            Move to which day?
          </label>
          <input
            id="move-day"
            type="date"
            value={day}
            onChange={(event) => look(event.target.value, providerId)}
            className="w-fit rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-sm dark:border-zinc-600"
          />
        </div>

        {providers.length > 1 ? (
          <div className="flex flex-col gap-1">
            <label htmlFor="move-provider" className="text-sm font-medium">
              With whom?
            </label>
            <select
              id="move-provider"
              value={providerId}
              onChange={(event) => look(day, event.target.value)}
              className="w-fit rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-sm dark:border-zinc-600"
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">What time?</legend>
        {loading ? (
          <p className="text-sm text-zinc-500">Looking…</p>
        ) : times.length === 0 ? (
          <p className="text-sm text-zinc-500">
            {looked ? 'Nothing free that day for this visit. Try another day.' : 'Pick a day to see her free times.'}
          </p>
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

      {/* Optional, and recorded on the event when given. Not required: the
          desk is on the phone, and a mandatory field on a busy surface gets
          filled with "." within a week (D-27's reasoning, same trap). */}
      <label className="flex flex-col gap-1 text-sm">
        Why? (optional)
        <input
          name="reason"
          placeholder="Client called — running late this week"
          className="rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-sm dark:border-zinc-600"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting || times.length === 0}
          className="rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-zinc-600"
        >
          {submitting ? 'Moving…' : 'Move this appointment'}
        </button>
        <p aria-live="polite" className="text-sm text-zinc-700 dark:text-zinc-300">
          {state.message ?? ''}
        </p>
      </div>
    </form>
  );
}
