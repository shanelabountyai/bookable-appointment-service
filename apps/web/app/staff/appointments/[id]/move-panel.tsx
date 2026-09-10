'use client';

import { useActionState, useState, useTransition } from 'react';
import {
  type MoveOption,
  type MoveState,
  moveAppointment,
  staffMoveDays,
  staffMoveOptions,
} from '@/lib/appointments/reschedule-actions';
import { OpenDays } from '@/components/open-days';

const initial: MoveState = {};

/**
 * "Can you push my 3 o'clock to 4?" — the most common phone call in the salon,
 * and until A-033 the desk had no answer but cancel-and-rebook.
 *
 * A NATIVE DATE INPUT, and — since A-106 — a list of open days BESIDE it,
 * never instead of it. The date box answers "she already said next Tuesday" in
 * one gesture and costs no engine runs at all; the day list answers "when CAN
 * you fit me in?", which the box cannot, and costs one engine pass per day. So
 * the list is computed only after a day comes back empty, which is exactly
 * when the desk needs it and never otherwise.
 *
 * This is where `/staff/conflicts`'s per-row "Move her" link lands, so it is
 * the rescue for a sick stylist — and until A-106 it was the one surface that
 * could not say which day she is back. Staff are uncapped by the booking
 * horizon (D-21); the fortnight is the length of a useful sentence, not a
 * horizon.
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
  // A-106 — `null` until the refusal has actually been answered. Fetched in
  // the SAME transition as the times, off the same result, so the screen can
  // never show a day list belonging to a different (day, stylist) pair than
  // the empty times above it.
  const [openDays, setOpenDays] = useState<string[] | null>(null);

  // Fetched on the change event rather than in an effect: choosing a day or a
  // stylist IS the event, so there is nothing to synchronize. Both re-ask,
  // because the times are the DESTINATION provider's — A-038's whole point is
  // that Dana's calendar says nothing about Priya's two o'clock.
  function look(nextDay: string, nextProviderId: string) {
    setDay(nextDay);
    setProviderId(nextProviderId);
    setLooked(false);
    setOpenDays(null);
    startLoading(async () => {
      const found = nextDay ? await staffMoveOptions(appointmentId, nextDay, nextProviderId) : [];
      setTimes(found);
      setLooked(Boolean(nextDay));
      // Only on the refusal. The walk is a fortnight of engine passes and the
      // ordinary answer is the list above — asking every time would spend it
      // on every successful lookup in the salon's day.
      if (nextDay && found.length === 0) setOpenDays(await staffMoveDays(appointmentId, nextDay, nextProviderId));
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
          <p className="text-sm text-ink-muted">Looking…</p>
        ) : times.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">
              {looked ? 'Nothing free that day for this visit.' : 'Pick a day to see free times.'}
            </p>
            {/* Picking a day here re-runs `look`, so the times below are the
                ones for the day just chosen — the list is a shortcut into the
                date box, not a second way to choose. */}
            <OpenDays days={openDays} onPick={(next) => look(next, providerId)} />
          </div>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {times.map((time) => (
              <li key={time.at}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-300 px-3 py-2 text-sm has-[:checked]:border-zinc-900 dark:border-zinc-700 dark:has-[:checked]:border-zinc-100">
                  <input type="radio" name="at" value={time.at} required />
                  {time.label}
                  {time.qualifier ? <span className="text-ink-muted">{time.qualifier}</span> : null}
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
