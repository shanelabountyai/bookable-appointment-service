'use client';

import { useActionState, useState } from 'react';
import { type VisitState, changeServices } from '@/lib/appointments/visit-actions';
import { readableReason } from '@/lib/scheduling-words';

const initial: VisitState = {};
const field = 'rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-sm dark:border-zinc-600';
const primary =
  'rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900';

export interface ServiceChoice {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * A-055 — "and can you do my roots while I'm here."
 *
 * THE SAME SHAPE AS THE BOOKING PANEL'S SERVICE PICKER, deliberately: the desk
 * has learned one way to say what a visit is made of, and a second idiom for
 * the same question is a second thing to learn under pressure. Selection order
 * is visit order (VISIT-01) and the numbered chips say so, because the buffers
 * come from the ends.
 *
 * The refusal is a step rather than a dead end (D-8): a visit that no longer
 * fits comes back with the engine's own reasons and BOOK-05's override beside
 * them.
 */
export function VisitPanel({
  appointmentId,
  services,
  current,
}: {
  appointmentId: string;
  services: ServiceChoice[];
  current: string[];
}) {
  const [state, action, pending] = useActionState(changeServices, initial);
  const [chosen, setChosen] = useState<string[]>(current);

  function toggle(id: string) {
    setChosen(chosen.includes(id) ? chosen.filter((s) => s !== id) : [...chosen, id]);
  }

  const unchanged =
    chosen.length === current.length && chosen.every((id, i) => id === current[i]);
  const minutes = chosen.reduce((total, id) => total + (services.find((s) => s.id === id)?.durationMinutes ?? 0), 0);
  const cents = chosen.reduce((total, id) => total + (services.find((s) => s.id === id)?.priceCents ?? 0), 0);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      {chosen.map((id) => (
        <input key={id} type="hidden" name="serviceIds" value={id} />
      ))}

      <ul className="flex flex-wrap gap-2">
        {services.map((service) => {
          const index = chosen.indexOf(service.id);
          return (
            <li key={service.id}>
              <button
                type="button"
                aria-pressed={index >= 0}
                onClick={() => toggle(service.id)}
                className={`rounded-md border px-3 py-2 text-sm ${
                  index >= 0
                    ? 'border-zinc-900 bg-zinc-100 font-medium dark:border-zinc-100 dark:bg-zinc-800'
                    : 'border-zinc-400 dark:border-zinc-600'
                }`}
              >
                {index >= 0 && chosen.length > 1 ? (
                  <span className="mr-1 text-zinc-600 dark:text-zinc-400">{index + 1}.</span>
                ) : null}
                {service.name}
                <span className="ml-2 text-zinc-600 dark:text-zinc-400">
                  {service.durationMinutes} min · {money(service.priceCents)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* The total as it WOULD be — a price already agreed never changes
          (D-18), so this is an estimate of the new visit and the appointment's
          own lines remain the record. */}
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {minutes} min · {money(cents)}
      </p>

      {state.message && !state.ok ? (
        <div className="flex flex-col gap-3 rounded-md border border-amber-500 p-4">
          <p className="text-sm font-medium" aria-live="polite">
            {state.message}
          </p>
          {state.canOverride ? (
            <>
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                {state.reasons?.length
                  ? `${state.reasons.map(readableReason).join('; ')}.`
                  : 'That time is outside her working hours.'}
              </p>
              {/* BOOK-05, and the reason is the ceremony — the same words and
                  the same shape the booking panel uses. */}
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" name="isOverride" />
                Do it anyway
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Why?
                <input name="overrideReason" className={field} placeholder="Staying late, agreed with Dana" />
              </label>
            </>
          ) : null}
        </div>
      ) : null}

      {state.ok ? (
        <p className="text-sm font-medium" aria-live="polite">
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Note (optional)
          <input name="reason" className={field} placeholder="Added at the chair" />
        </label>
        <button type="submit" disabled={pending || unchanged || chosen.length === 0} className={primary}>
          {pending ? 'Changing…' : 'Change what she is having'}
        </button>
      </div>
    </form>
  );
}
