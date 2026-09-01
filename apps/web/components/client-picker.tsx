'use client';

import { useState, useTransition } from 'react';
import type { ClientChoice } from '@/lib/booking/staff-actions';
import { createClientForBooking } from '@/lib/booking/staff-actions';

/**
 * THE client picker (CLIENT-01's "staff choose or create").
 *
 * Lifted out of the booking panel by A-068, which needed the same control on
 * the appointment detail — "who was this?" for a walk-in booked as nothing but
 * a time, and "no, the other Sarah Jones" for the one the desk picked wrong.
 * A second picker would be a second set of answers to the questions this one
 * has already settled: that a reliability flag is a NOTE and never a gate
 * (CLIENT-04, D-27), that a client already booked nearby is a NOTE and never a
 * refusal (D-17 — one number can be a household), and that "no name" produces
 * a real appointment with a null client rather than a placeholder record
 * (BOOK-04).
 *
 * The SEARCH is injected rather than hardcoded, because the note each caller
 * wants is computed against a different thing: the booking panel asks about
 * the slot it is in the middle of choosing, the detail panel about the
 * appointment that already exists. Everything else — the debounce, the
 * two-character floor, "New client …", "No name" — is identical and now
 * exists once.
 */

const secondary = 'rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium dark:border-zinc-600';
const field = 'rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-sm dark:border-zinc-600';

/** The sentinel BOOK-04's "no name" button selects. `id: ''` means "booked
 *  with nobody", which the form then sends as an empty `clientId`. */
export const NO_NAME: ClientChoice = { id: '', name: 'Walk-in, no name', phone: null };

export function ClientPicker({
  value,
  onChange,
  search,
  inputId = 'client-search',
  changeWord = 'change',
  allowNoName = true,
}: {
  value: ClientChoice | null;
  onChange: (client: ClientChoice | null) => void;
  /** Bound by the caller to whatever the note should be computed against. */
  search: (query: string) => Promise<ClientChoice[]>;
  /** Two of these can be on one page; the label has to point at the right one. */
  inputId?: string;
  changeWord?: string;
  /** Off where detaching is a separate, named action rather than a choice in
   *  the list — the appointment detail says "nobody" out loud (A-068). */
  allowNoName?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<ClientChoice[]>([]);
  const [searching, startSearching] = useTransition();
  const [creating, startCreating] = useTransition();

  function run(text: string) {
    setQuery(text);
    startSearching(async () => {
      setCandidates(text.trim().length < 2 ? [] : await search(text));
    });
  }

  if (value) {
    return (
      <p className="text-sm">
        <span className="font-medium">{value.name ?? 'No name'}</span>{' '}
        <span className="text-zinc-600 dark:text-zinc-400">{value.phone ?? ''}</span>{' '}
        <button type="button" onClick={() => onChange(null)} className="underline underline-offset-4">
          {changeWord}
        </button>
        {/* Still showing AFTER she is chosen: a flag that disappears at the
            moment of the decision is a flag nobody acts on. */}
        {value.missed ? <span className="mt-1 block text-amber-800 dark:text-amber-300">⚑ {value.missed}</span> : null}
      </p>
    );
  }

  return (
    <>
      <label htmlFor={inputId} className="sr-only">
        Find a client by name or phone number
      </label>
      <input
        id={inputId}
        value={query}
        onChange={(event) => run(event.target.value)}
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
                onClick={() => onChange(candidate)}
                className="w-full rounded-md border border-zinc-400 px-3 py-2 text-left text-sm dark:border-zinc-600"
              >
                <span className="font-medium">{candidate.name ?? 'No name'}</span>{' '}
                <span className="text-zinc-600 dark:text-zinc-400">{candidate.phone ?? ''}</span>
                {/* D-17: a NOTE, never a refusal. One number can be a
                    household, and one person may hold two appointments. */}
                {candidate.alreadyBooked ? (
                  <span className="block text-amber-800 dark:text-amber-300">⚠ {candidate.alreadyBooked}</span>
                ) : null}
                {/* CLIENT-04/D-27: the same shape — a flag, not a gate. The
                    website refuses her; the front desk does not. */}
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
              if (made) onChange(made);
            })
          }
          className={secondary}
        >
          New client “{query.trim() || '…'}”
        </button>
        {allowNoName ? (
          <button type="button" onClick={() => onChange(NO_NAME)} className={secondary}>
            No name
          </button>
        ) : null}
      </div>
    </>
  );
}
