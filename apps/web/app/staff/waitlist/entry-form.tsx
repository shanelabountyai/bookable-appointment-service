'use client';

import { useActionState, useState, useTransition } from 'react';
import { TIME_BAND_TAGS, WEEKDAY_TAGS } from '@bookable/core/waitlist';
import type { ClientSummary } from '@bookable/db/clients';
import { type FormState, addWaitlistEntry, findClients } from '@/lib/waitlist/actions';

const initial: FormState = {};
const field = 'rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-sm dark:border-zinc-600';

interface Service {
  id: string;
  name: string;
}
interface Provider {
  id: string;
  displayName: string;
}

/**
 * WAIT-01's entry form — service + acceptable providers + date range +
 * day-parts, against a client found the same way A-017's booking flow and
 * A-015's merge picker find one.
 */
export function EntryForm({ services, providers }: { services: Service[]; providers: Provider[] }) {
  const [state, formAction, adding] = useActionState(addWaitlistEntry, initial);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<ClientSummary[]>([]);
  const [client, setClient] = useState<ClientSummary | null>(null);
  const [searching, startSearching] = useTransition();

  function search(text: string) {
    setQuery(text);
    startSearching(async () => {
      setCandidates(text.trim().length < 2 ? [] : await findClients(text));
    });
  }

  // A successful add clears the picker, so the next entry doesn't start
  // pre-filled with the last client. Adjusted DURING render (React's own
  // pattern for "state changed, react to it") rather than in an effect —
  // an effect here would set state synchronously on mount of the very render
  // it was triggered by, one extra cascading render for nothing.
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state.ok) {
      setClient(null);
      setQuery('');
    }
  }

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Add to the waitlist</h2>

      {client ? (
        <p className="text-sm">
          For <span className="font-medium">{client.name ?? 'No name'}</span>{' '}
          <span className="text-zinc-500">{client.phone ?? ''}</span>{' '}
          <button type="button" onClick={() => setClient(null)} className="text-xs underline underline-offset-4">
            change
          </button>
          <input type="hidden" name="clientId" value={client.id} />
        </p>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          Client
          <input
            value={query}
            onChange={(event) => search(event.target.value)}
            placeholder="Name or phone number"
            className={field}
          />
          {searching ? (
            <span className="text-xs text-zinc-500">Looking…</span>
          ) : candidates.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setClient(candidate);
                      setCandidates([]);
                    }}
                    className="text-sm underline underline-offset-4"
                  >
                    {candidate.name ?? 'No name'} <span className="text-zinc-500">{candidate.phone ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm">
        Service
        <select name="serviceId" required className={field}>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend>Acceptable providers (none checked = any)</legend>
        <div className="flex flex-wrap gap-3">
          {providers.map((provider) => (
            <label key={provider.id} className="flex items-center gap-1.5">
              <input type="checkbox" name="providerIds" value={provider.id} />
              {provider.displayName}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          From
          <input type="date" name="fromDay" required className={field} />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          To
          <input type="date" name="toDay" required className={field} />
        </label>
      </div>

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend>Which days (none checked = any)</legend>
        <div className="flex flex-wrap gap-3">
          {WEEKDAY_TAGS.map((day) => (
            <label key={day} className="flex items-center gap-1.5 capitalize">
              <input type="checkbox" name="dayParts" value={day} />
              {day}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend>Time of day (none checked = any)</legend>
        <div className="flex flex-wrap gap-3">
          {TIME_BAND_TAGS.map((band) => (
            <label key={band} className="flex items-center gap-1.5 capitalize">
              <input type="checkbox" name="dayParts" value={band} />
              {band}
            </label>
          ))}
        </div>
      </fieldset>

      <button
        type="submit"
        disabled={adding || !client}
        className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {adding ? 'Adding…' : 'Add to waitlist'}
      </button>

      <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-300">
        {state.message ?? ''}
      </p>
    </form>
  );
}
