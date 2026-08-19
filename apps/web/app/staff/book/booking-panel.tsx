'use client';

import Link from 'next/link';
import { useActionState, useState, useTransition } from 'react';
import {
  type ClientChoice,
  type OfferedSlot,
  type StaffBookingState,
  type WalkInChoice,
  bookAsStaff,
  createClientForBooking,
  findClientsForBooking,
  findWalkInOptions,
  staffSlotsFor,
} from '@/lib/booking/staff-actions';

const initial: StaffBookingState = {};

interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const primary =
  'rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900';
const secondary = 'rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium dark:border-zinc-600';
const field = 'rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-sm dark:border-zinc-600';

/**
 * Services → who and when → client → book (BOOK-04).
 *
 * The refusal is a step, not a dead end (D-8): when the engine says no, the
 * reasons appear with an override box beside them, because "every platform he
 * abandoned died of a flat refusal". Typing a reason is the whole ceremony —
 * it is what makes the marker on the appointment mean something later.
 */
export function BookingPanel({
  day,
  services,
  provider,
  at,
  walkIn,
}: {
  day: string;
  services: Service[];
  provider: { id: string; displayName: string } | null;
  at: string | null;
  walkIn: boolean;
}) {
  const [state, formAction, booking] = useActionState(bookAsStaff, initial);

  const [chosen, setChosen] = useState<string[]>([]);
  const [options, setOptions] = useState<WalkInChoice[]>([]);
  const [pick, setPick] = useState<{ providerId: string; at: string; label: string } | null>(null);
  const [loadingOptions, startLoadingOptions] = useTransition();
  const [slots, setSlots] = useState<OfferedSlot[]>([]);
  const [chosenSlot, setChosenSlot] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<ClientChoice[]>([]);
  const [client, setClient] = useState<ClientChoice | null>(null);
  const [searching, startSearching] = useTransition();
  const [creating, startCreating] = useTransition();

  const providerId = pick?.providerId ?? provider?.id ?? '';
  // A gap link is a STARTING POINT, not a bookable instant: gaps begin where
  // the previous appointment's buffer ends, which is rarely on the salon's
  // slot grid. The panel offers the real times and this is whichever one is
  // selected (found by demo checkpoint 2).
  const startAt = pick?.at ?? chosenSlot ?? '';
  const ready = chosen.length > 0 && providerId !== '' && startAt !== '';

  function toggleService(id: string) {
    // ORDER MATTERS (VISIT-01): the buffers come from the ends, so "cut then
    // colour" is a different appointment from "colour then cut". Selection
    // order is the visit order.
    const next = chosen.includes(id) ? chosen.filter((s) => s !== id) : [...chosen, id];
    setChosen(next);
    setPick(null);
    setOptions([]);
    setSlots([]);
    setChosenSlot(null);
    if (walkIn && next.length > 0) {
      startLoadingOptions(async () => setOptions(await findWalkInOptions(next, day)));
      return;
    }
    if (!walkIn && next.length > 0 && provider) {
      startLoadingOptions(async () => {
        const offered = await staffSlotsFor(provider.id, next, day);
        setSlots(offered);
        // Preselect the first offered time at or after the gap the desk
        // tapped, so the ordinary case is one tap and the list is there to
        // correct it.
        //
        // FALLING BACK TO `at` ITSELF, never to the day's first slot: if
        // nothing is offered at or after the requested time, the desk asked
        // for something the engine will not sell — an 18:00 with the salon
        // shut — and that has to reach the refusal so BOOK-05's override is
        // still on offer. Substituting the morning's first slot would book a
        // completely different appointment and call it success.
        setChosenSlot(offered.find((slot) => !at || slot.at >= at)?.at ?? at ?? offered[0]?.at ?? null);
      });
    }
  }

  function search(text: string) {
    setQuery(text);
    startSearching(async () => {
      setCandidates(text.trim().length < 2 ? [] : await findClientsForBooking(text, startAt, chosen));
    });
  }

  if (state.ok) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-lg font-medium">{state.message}</p>
        <Link href={`/staff/day?day=${day}`} className={primary + ' self-start'}>
          Back to the day
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="at" value={startAt} />
      <input type="hidden" name="clientId" value={client?.id ?? ''} />
      {chosen.map((id) => (
        <input key={id} type="hidden" name="serviceIds" value={id} />
      ))}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          What is she having?
        </legend>
        <ul className="flex flex-wrap gap-2">
          {services.map((service) => {
            const index = chosen.indexOf(service.id);
            return (
              <li key={service.id}>
                <button
                  type="button"
                  aria-pressed={index >= 0}
                  onClick={() => toggleService(service.id)}
                  className={`rounded-md border px-3 py-2 text-sm ${index >= 0 ? 'border-zinc-900 bg-zinc-100 font-medium dark:border-zinc-100 dark:bg-zinc-800' : 'border-zinc-400 dark:border-zinc-600'}`}
                >
                  {index >= 0 && chosen.length > 1 ? <span className="mr-1 text-zinc-600 dark:text-zinc-400">{index + 1}.</span> : null}
                  {service.name}
                  <span className="ml-2 text-zinc-600 dark:text-zinc-400">
                    {service.durationMinutes} min · {money(service.priceCents)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {!walkIn ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            What time?
          </legend>
          {chosen.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Choose a service first.</p>
          ) : loadingOptions ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Looking…</p>
          ) : slots.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Nothing free that day for this service. Book it anyway below if you mean to.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {slots.map((slot) => (
                <li key={slot.at}>
                  <button
                    type="button"
                    aria-pressed={chosenSlot === slot.at}
                    onClick={() => setChosenSlot(slot.at)}
                    className={`rounded-md border px-3 py-2 text-sm ${chosenSlot === slot.at ? 'border-zinc-900 bg-zinc-100 font-medium dark:border-zinc-100 dark:bg-zinc-800' : 'border-zinc-400 dark:border-zinc-600'}`}
                  >
                    {slot.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      ) : null}

      {walkIn ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            Who can take her?
          </legend>
          {chosen.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Choose a service first.</p>
          ) : loadingOptions ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Looking…</p>
          ) : options.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Nobody is free for that today. Book a time from the day view instead.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {options.map((option) => {
                const selected = pick?.providerId === option.providerId && pick?.at === option.at;
                return (
                  <li key={option.providerId}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setPick({ providerId: option.providerId, at: option.at, label: option.label })}
                      className={`rounded-md border px-3 py-2 text-sm ${selected ? 'border-zinc-900 bg-zinc-100 font-medium dark:border-zinc-100 dark:bg-zinc-800' : 'border-zinc-400 dark:border-zinc-600'}`}
                    >
                      {option.providerName} at {option.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Who is she?
        </legend>

        {client ? (
          <p className="text-sm">
            <span className="font-medium">{client.name ?? 'No name'}</span>{' '}
            <span className="text-zinc-600 dark:text-zinc-400">{client.phone ?? ''}</span>{' '}
            <button type="button" onClick={() => setClient(null)} className="underline underline-offset-4">
              change
            </button>
            {/* Still showing AFTER she is chosen: a flag that disappears at
                the moment of the decision is a flag nobody acts on. */}
            {client.missed ? (
              <span className="mt-1 block text-amber-800 dark:text-amber-300">⚑ {client.missed}</span>
            ) : null}
          </p>
        ) : (
          <>
            <label htmlFor="client-search" className="sr-only">
              Find a client by name or phone number
            </label>
            <input
              id="client-search"
              value={query}
              onChange={(event) => search(event.target.value)}
              placeholder="Name or phone number"
              className={field}
            />

            {searching ? <p className="text-sm text-zinc-600 dark:text-zinc-400">Looking…</p> : null}

            {candidates.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      onClick={() => setClient(candidate)}
                      className="w-full rounded-md border border-zinc-400 px-3 py-2 text-left text-sm dark:border-zinc-600"
                    >
                      <span className="font-medium">{candidate.name ?? 'No name'}</span>{' '}
                      <span className="text-zinc-600 dark:text-zinc-400">{candidate.phone ?? ''}</span>
                      {/* D-17: a NOTE, never a refusal. One number can be a
                          household, and one person may hold two appointments. */}
                      {candidate.alreadyBooked ? (
                        <span className="block text-amber-800 dark:text-amber-300">⚠ {candidate.alreadyBooked}</span>
                      ) : null}
                      {/* CLIENT-04/D-27: the same shape — a flag, not a gate.
                          The website refuses her; the front desk does not. */}
                      {candidate.missed ? (
                        <span className="block text-amber-800 dark:text-amber-300">⚑ {candidate.missed}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={creating || query.trim().length < 2}
                onClick={() =>
                  startCreating(async () => {
                    const made = await createClientForBooking(query, query);
                    if (made) setClient(made);
                  })
                }
                className={secondary}
              >
                New client “{query.trim() || '…'}”
              </button>
              {/* BOOK-04: "walk-in, no name". Identity attaches later — a real
                  appointment with a null client, not a placeholder record. */}
              <button
                type="button"
                onClick={() => setClient({ id: '', name: 'Walk-in, no name', phone: null })}
                className={secondary}
              >
                No name
              </button>
            </div>
          </>
        )}
      </fieldset>

      {state.message && !state.ok ? (
        <div className="flex flex-col gap-3 rounded-md border border-amber-500 p-4">
          <p className="text-sm font-medium" aria-live="polite">
            {state.message}
          </p>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            {state.refusedReasons?.length
              ? `${state.refusedReasons.map(readableReason).join('; ')}.`
              : // No reasons means the engine never considered this time a
                // candidate — it is outside her working hours entirely, which
                // is BOOK-05's first override case rather than a dead end.
                'That time is outside her working hours.'}
          </p>

          {state.canOverride ? (
            <>
              {/* BOOK-05. The reason is the ceremony: it is what makes the
                  override marker mean something on the day view, in the event
                  log, and to whoever asks about it next week. */}
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" name="isOverride" />
                Book it anyway
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Why?
                <input name="overrideReason" required={false} className={field} placeholder="Wedding party, agreed with Dana" />
              </label>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={!ready || booking} className={primary}>
          {booking ? 'Booking…' : 'Book'}
        </button>
        {!ready ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {chosen.length === 0 ? 'Choose a service.' : 'Choose who and when.'}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/**
 * The engine's machine-readable reasons, in the words the front desk uses.
 *
 * Staff wording, not D-10's customer lexicon — this surface is allowed to say
 * "overlaps a buffer", and being specific is what lets somebody decide whether
 * an override is reasonable.
 */
function readableReason(reason: string): string {
  return REASONS[reason] ?? reason.replace(/-/g, ' ');
}

const REASONS: Record<string, string> = {
  'outside-working-window': 'outside her working hours',
  'inside-break': 'during her break',
  'crosses-window-close': 'it would run past closing',
  'overlaps-booking': 'she already has a client then',
  'overlaps-buffer': 'it runs into another appointment’s buffer',
  'overlaps-time-off': 'she is on time off',
  'overlaps-block': 'that time is blocked out',
  'in-the-past': 'that time has passed',
  'inside-lead-time': 'inside the booking lead time',
};
