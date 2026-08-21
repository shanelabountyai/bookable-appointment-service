'use client';

import Link from 'next/link';
import { useActionState, useState, useTransition } from 'react';
import {
  type ClientChoice,
  type ComposedTime,
  type GridTime,
  type StaffBookingState,
  type WalkInChoice,
  bookAsStaff,
  createClientForBooking,
  findClientsForBooking,
  findWalkInOptions,
  instantForTime,
  staffSlotsFor,
} from '@/lib/booking/staff-actions';
import { readableReason } from '@/lib/scheduling-words';

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
  day: initialDay,
  services,
  provider,
  at,
  walkIn,
  initialServiceIds = [],
  initialClient = null,
  initialSlots = [],
}: {
  day: string;
  services: Service[];
  provider: { id: string; displayName: string } | null;
  at: string | null;
  walkIn: boolean;
  /** A-040's rebook, resolved on the server: every service the last visit
   *  had, in ITS order (VISIT-01), already filtered to what this provider can
   *  still do. */
  initialServiceIds?: string[];
  initialClient?: ClientChoice | null;
  /** Offered times for the prefilled combination, computed server-side so a
   *  rebook renders with its list already there. */
  initialSlots?: GridTime[];
}) {
  const [state, formAction, booking] = useActionState(bookAsStaff, initial);

  // A-039: the panel changes ITS OWN day rather than sending the desk back to
  // the grid to pick again — the URL's day is only where this screen started.
  const [day, setDay] = useState(initialDay);
  const [chosen, setChosen] = useState<string[]>(initialServiceIds);
  const [options, setOptions] = useState<WalkInChoice[]>([]);
  const [pick, setPick] = useState<{ providerId: string; at: string; label: string } | null>(null);
  const [loadingOptions, startLoadingOptions] = useTransition();
  const [slots, setSlots] = useState<GridTime[]>(initialSlots);
  // A-042: times the desk typed that the grid does not contain at all — after
  // close, before open. Composed to instants on the SERVER (D-4) and kept
  // beside the grid rather than mixed into it, because they are not offers.
  const [typed, setTyped] = useState<ComposedTime[]>([]);
  const [typedError, setTypedError] = useState<string | null>(null);
  const [wall, setWall] = useState('');
  const [composing, startComposing] = useTransition();
  // Deliberately NOT preselected on a rebook: "six weeks on Tuesday" names a
  // day, never a time, and defaulting to the morning's first slot would book
  // a time nobody chose. The list is there; the desk picks from it.
  const [chosenSlot, setChosenSlot] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<ClientChoice[]>([]);
  const [client, setClient] = useState<ClientChoice | null>(initialClient);
  const [searching, startSearching] = useTransition();
  const [creating, startCreating] = useTransition();

  const providerId = pick?.providerId ?? provider?.id ?? '';
  // A gap link is a STARTING POINT, not a bookable instant: gaps begin where
  // the previous appointment's buffer ends, which is rarely on the salon's
  // slot grid. The panel offers the real times and this is whichever one is
  // selected (found by demo checkpoint 2).
  const startAt = pick?.at ?? chosenSlot ?? '';
  const ready = chosen.length > 0 && providerId !== '' && startAt !== '';

  // Shared by "pick a service" and "pick a day" (A-039) — either one
  // invalidates whatever times were offered for the OLD combination.
  function loadFor(nextDay: string, nextServices: string[]) {
    setPick(null);
    setOptions([]);
    setSlots([]);
    setChosenSlot(null);
    // A typed 18:00 belongs to the day it was composed against — carrying it
    // across a day change would keep an instant from last Tuesday selected.
    setTyped([]);
    setTypedError(null);
    if (nextServices.length === 0) return;
    if (walkIn) {
      startLoadingOptions(async () => setOptions(await findWalkInOptions(nextServices, nextDay)));
      return;
    }
    if (provider) {
      startLoadingOptions(async () => {
        const offered = await staffSlotsFor(provider.id, nextServices, nextDay);
        setSlots(offered);
        // Preselect the first offered time at or after the gap the desk
        // tapped, so the ordinary case is one tap and the list is there to
        // correct it. Only on the day the gap actually came from — a gap's
        // instant means nothing once the desk has picked a different day.
        //
        // FALLING BACK TO `at` ITSELF, never to the day's first slot: if
        // nothing is offered at or after the requested time, the desk asked
        // for something the engine will not sell — an 18:00 with the salon
        // shut — and that has to reach the refusal so BOOK-05's override is
        // still on offer. Substituting the morning's first slot would book a
        // completely different appointment and call it success.
        //
        // BOOKABLE ONES ONLY (A-042). The list now carries the refused times
        // too, and preselecting one of those would arm the override for a desk
        // that only tapped a gap — which is precisely how an override marker
        // stops meaning anything.
        const anchor = nextDay === initialDay ? at : null;
        const bookable = offered.filter((slot) => slot.reasons.length === 0);
        setChosenSlot(bookable.find((slot) => !anchor || slot.at >= anchor)?.at ?? anchor ?? bookable[0]?.at ?? null);
      });
    }
  }

  function toggleService(id: string) {
    // ORDER MATTERS (VISIT-01): the buffers come from the ends, so "cut then
    // colour" is a different appointment from "colour then cut". Selection
    // order is the visit order.
    const next = chosen.includes(id) ? chosen.filter((s) => s !== id) : [...chosen, id];
    setChosen(next);
    loadFor(day, next);
  }

  function changeDay(nextDay: string) {
    setDay(nextDay);
    loadFor(nextDay, chosen);
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
        {/* The day just booked, not the day the panel was opened on — the
            desk may have moved forward from here (A-039). */}
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

      {/* A-039: change the day from right here — no trip back to the grid to
          pick again. Not shown for a walk-in standing at the desk today. */}
      {!walkIn ? (
        <label className="flex w-fit flex-col gap-1 text-sm">
          Which day?
          <input
            type="date"
            value={day}
            onChange={(event) => event.target.value && changeDay(event.target.value)}
            className={field}
          />
        </label>
      ) : null}

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
          ) : (
            <>
              {slots.length === 0 ? (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  She is not working that day. Type a time below if you mean to book her anyway.
                </p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {/* A-042 — the WHOLE column, offered and refused alike, in
                      one chronological list. A refused time is dimmed, says
                      why, and is still tappable: that tap is the only way to
                      reach BOOK-05's override from a screen, and the reason
                      beside it is what makes the tap a decision (D-8). */}
                  {slots.map((slot) => {
                    const why = slot.reasons.map(readableReason).join('; ');
                    return (
                      <li key={slot.at}>
                        <button
                          type="button"
                          aria-pressed={chosenSlot === slot.at}
                          onClick={() => setChosenSlot(slot.at)}
                          className={`rounded-md border px-3 py-2 text-left text-sm ${
                            chosenSlot === slot.at
                              ? 'border-zinc-900 bg-zinc-100 font-medium dark:border-zinc-100 dark:bg-zinc-800'
                              : why
                                ? 'border-dashed border-zinc-400 text-zinc-600 dark:border-zinc-600 dark:text-zinc-400'
                                : 'border-zinc-400 dark:border-zinc-600'
                          }`}
                        >
                          {slot.label}
                          {/* The space is a real text node, not the margin:
                              `ml-2` is invisible to an accessible name, and
                              without it the button is called "09:00— she
                              already has a client then". */}
                          {why ? <span className="ml-2 text-xs"> — {why}</span> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* The grid stops at the working windows: with candidates
                  anchored to window-open, 18:00 on a day that shuts at 17:00
                  is never a candidate and so can never appear above. That is
                  BOOK-05's first case ("book outside hours") and A-038's "move
                  her to 6pm, we'll stay late" — until now reachable only by
                  hand-typing a URL the product does not emit.

                  The wall time is sent to the SERVER and comes back an
                  instant (D-4). Composing it here would compose it in the
                  browser's timezone. */}
              <div className="mt-1 flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-sm">
                  Another time?
                  <input
                    type="time"
                    value={wall}
                    onChange={(event) => setWall(event.target.value)}
                    className={field}
                  />
                </label>
                <button
                  type="button"
                  disabled={composing || wall === ''}
                  onClick={() =>
                    startComposing(async () => {
                      const composed = await instantForTime(day, wall);
                      setTyped(composed.times);
                      setTypedError(composed.error ?? null);
                      // One answer is unambiguous, so select it and save the
                      // desk a tap. Two means the clocks went back and only a
                      // person can say which 01:30 she meant.
                      if (composed.times.length === 1) setChosenSlot(composed.times[0]!.at);
                    })
                  }
                  className={secondary}
                >
                  Use it
                </button>
              </div>
              {typedError ? (
                <p className="text-sm text-amber-800 dark:text-amber-300" aria-live="polite">
                  {typedError}
                </p>
              ) : null}
              {typed.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {typed.map((time) => (
                    <li key={time.at}>
                      <button
                        type="button"
                        aria-pressed={chosenSlot === time.at}
                        onClick={() => setChosenSlot(time.at)}
                        className={`rounded-md border px-3 py-2 text-sm ${chosenSlot === time.at ? 'border-zinc-900 bg-zinc-100 font-medium dark:border-zinc-100 dark:bg-zinc-800' : 'border-dashed border-zinc-400 dark:border-zinc-600'}`}
                      >
                        {time.label}
                        {time.note ? <span className="ml-2 text-xs"> ({time.note})</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
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

