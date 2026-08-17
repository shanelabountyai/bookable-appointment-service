'use client';

import { useActionState, useState, useTransition } from 'react';
import type { ClientSummary } from '@bookable/db/clients';
import { type FormState, findClients, mergeClientRecords } from '@/lib/clients/actions';

const initial: FormState = {};

/**
 * CLIENT-01's "staff merge duplicates".
 *
 * Search-and-pick rather than a list of same-number records: duplicates most
 * often exist BECAUSE the number was typed wrong the second time, so matching
 * on the number would miss exactly the case staff are trying to fix.
 *
 * The direction is stated in words on the button, not implied by which record
 * you happened to open. A merge is not reversible by a second merge, and "into
 * which one?" is the whole decision.
 */
export function MergePanel({ survivorId, survivorName }: { survivorId: string; survivorName: string }) {
  const [state, formAction, merging] = useActionState(mergeClientRecords, initial);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<ClientSummary[]>([]);
  const [searching, startSearching] = useTransition();

  function search(text: string) {
    setQuery(text);
    startSearching(async () => {
      setCandidates(text.trim().length < 2 ? [] : (await findClients(text)).filter((c) => c.id !== survivorId));
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Merge a duplicate</h2>
      <p className="text-sm text-zinc-500">
        Find the duplicate record. Its appointments and notes move into {survivorName}, and its phone number keeps
        finding this record afterwards.
      </p>

      <label htmlFor="merge-search" className="sr-only">
        Find a duplicate record
      </label>
      <input
        id="merge-search"
        value={query}
        onChange={(event) => search(event.target.value)}
        placeholder="Name or phone number"
        className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
      />

      {searching ? (
        <p className="text-sm text-zinc-500">Looking…</p>
      ) : candidates.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {candidates.map((candidate) => (
            <li key={candidate.id} className="flex items-center justify-between gap-3">
              <span className="text-sm">
                {candidate.name ?? 'No name'} <span className="text-zinc-500">{candidate.phone ?? ''}</span>
              </span>
              <form action={formAction}>
                <input type="hidden" name="survivorId" value={survivorId} />
                <input type="hidden" name="losingId" value={candidate.id} />
                <button
                  type="submit"
                  disabled={merging}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium disabled:opacity-60 dark:border-zinc-700"
                >
                  Merge into {survivorName}
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}

      <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
        {state.message ?? ''}
      </p>
    </section>
  );
}
