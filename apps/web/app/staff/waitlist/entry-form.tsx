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
 * A-110 — what the booking panel already knew, carried across.
 *
 * Every field is a DEFAULT, not a value: the desk is reading this off
 * somebody on the phone who is still changing her mind, and a prefill that
 * cannot be corrected is worse than none.
 */
export interface EntryPrefill {
  client: ClientSummary | null;
  /** The whole refused visit, in ITS order (VISIT-01). The first is what the
   *  entry is for; the rest are named on screen, because a two-service visit
   *  waitlisted as one service is a promise this form cannot keep. */
  serviceIds: string[];
  providerIds: string[];
  fromDay: string | null;
  toDay: string | null;
  dayParts: string[];
}

/**
 * WAIT-01's entry form — service + acceptable providers + date range +
 * day-parts, against a client found the same way A-017's booking flow and
 * A-015's merge picker find one.
 */
export function EntryForm({
  services,
  providers,
  weekdays,
  prefill,
}: {
  services: Service[];
  providers: Provider[];
  /** A-110 — the weekdays this salon is ever open, 0 = Sunday. */
  weekdays: number[];
  prefill: EntryPrefill;
}) {
  const [state, formAction, adding] = useActionState(addWaitlistEntry, initial);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<ClientSummary[]>([]);
  const [client, setClient] = useState<ClientSummary | null>(prefill.client);
  const [searching, startSearching] = useTransition();
  // The services she was refused, minus the one this entry is for. Named, not
  // dropped: `matchFreedSlot` will offer her a span long enough for a cut and
  // whoever rings has to know she also wanted the colour.
  const alsoAsked = prefill.serviceIds
    .slice(1)
    .map((id) => services.find((service) => service.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  // A-110 — the days the salon opens, PLUS whatever day the prefill actually
  // carries. Picking a shut day off a list of seven is the bug; arriving from
  // "she is not working that Monday" with Monday checked is the fact she rang
  // about, and a checkbox that silently vanished would drop it without
  // saying so. Rendered in weekday order by construction.
  const dayChoices = WEEKDAY_TAGS.filter(
    (day, weekday) => weekdays.includes(weekday) || prefill.dayParts.includes(day),
  );

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
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Add to the waitlist</h2>

      {client ? (
        <p className="text-sm">
          For <span className="font-medium">{client.name ?? 'No name'}</span>{' '}
          <span className="text-ink-muted">{client.phone ?? ''}</span>{' '}
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
            <span className="text-xs text-ink-muted">Looking…</span>
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
                    {candidate.name ?? 'No name'} <span className="text-ink-muted">{candidate.phone ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm">
        Service
        <select name="serviceId" required defaultValue={prefill.serviceIds[0] ?? undefined} className={field}>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </select>
      </label>
      {/* OUTSIDE the label on purpose: inside, this becomes part of the
          select's accessible name, and the control is called "Service She
          also asked for Cut…". */}
      {alsoAsked.length ? (
        <p className="-mt-2 text-xs text-ink-muted">
          They also asked for {alsoAsked.join(' and ')} — one service per entry, so say so when you ring them.
        </p>
      ) : null}

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend>Acceptable providers (none checked = any)</legend>
        <div className="flex flex-wrap gap-3">
          {providers.map((provider) => (
            <label key={provider.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                name="providerIds"
                value={provider.id}
                defaultChecked={prefill.providerIds.includes(provider.id)}
              />
              {provider.displayName}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          From
          <input type="date" name="fromDay" required defaultValue={prefill.fromDay ?? undefined} className={field} />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          To
          <input type="date" name="toDay" required defaultValue={prefill.toDay ?? undefined} className={field} />
        </label>
      </div>

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend>Which days (none checked = any)</legend>
        <div className="flex flex-wrap gap-3">
          {/* A-110 — only the days the salon actually opens. All seven let a
              client be waitlisted for Sunday and Monday only, which
              `matchesDayParts` then refuses against every slot that ever
              frees, forever, with nothing on any screen saying why. */}
          {dayChoices.map((day) => (
            <label key={day} className="flex items-center gap-1.5 capitalize">
              <input type="checkbox" name="dayParts" value={day} defaultChecked={prefill.dayParts.includes(day)} />
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
              <input type="checkbox" name="dayParts" value={band} defaultChecked={prefill.dayParts.includes(band)} />
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
