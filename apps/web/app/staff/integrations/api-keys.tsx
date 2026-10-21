'use client';

import { useActionState } from 'react';
import { type ApiKeyState, type IntegrationKeyRow, issueIntegrationKey, revokeIntegrationKey } from '@/lib/auth/api-key-actions';

const initial: ApiKeyState = {};
const field = 'rounded-md border border-zinc-400 bg-transparent px-2 py-1 text-sm dark:border-zinc-600';
const small = 'rounded-md border border-zinc-400 px-2 py-1 text-xs font-medium dark:border-zinc-600';

/** What each scope lets a key do, in the owner's words (API PRD §5, §6.8, W-D2). */
const SCOPES = [
  { value: 'read', label: 'Read', hint: 'services, stylists, open times, the day, clients', checked: true },
  { value: 'write', label: 'Write', hint: 'book, move, cancel, check in, add clients', checked: false },
  { value: 'prices', label: 'Prices', hint: 'include prices in the service list', checked: false },
  { value: 'contacts', label: 'Contacts', hint: 'full phone and email on one client', checked: false },
] as const;

/**
 * W-001 — API keys. The minted key appears ONCE, in the action's response,
 * and is never on the list: the database holds its hash and nothing else.
 */
export function ApiKeys({ keys }: { keys: IntegrationKeyRow[] }) {
  const [issueState, issue, issuing] = useActionState(issueIntegrationKey, initial);

  return (
    <section aria-labelledby="api-keys-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="api-keys-heading" className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          API keys
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          One key per system. Revoking a key stops that system on its next request and touches nothing else.
        </p>
      </div>

      <form action={issue} className="flex flex-col gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
        <label className="flex flex-col gap-1 text-sm">
          Label
          <input name="label" placeholder="HubSpot sync" className={field} />
        </label>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1">Scopes</legend>
          {SCOPES.map((s) => (
            <label key={s.value} className="flex items-center gap-2">
              <input type="checkbox" name="scope" value={s.value} defaultChecked={s.checked} />
              <span>
                {s.label} <span className="text-zinc-600 dark:text-zinc-400">— {s.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div>
          <button type="submit" disabled={issuing} className={small}>
            {issuing ? 'Issuing…' : 'Issue key'}
          </button>
        </div>
        <p aria-live="polite" className="text-sm text-zinc-700 dark:text-zinc-300">
          {issueState.message ?? ''}
        </p>
        {issueState.key ? (
          <output className="break-all rounded-md border border-zinc-400 bg-zinc-50 px-3 py-2 font-mono text-sm dark:border-zinc-600 dark:bg-zinc-900">
            {issueState.key}
          </output>
        ) : null}
      </form>

      {keys.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No keys issued.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {keys.map((k) => (
            <KeyRow key={k.id} apiKey={k} />
          ))}
        </ul>
      )}
    </section>
  );
}

function KeyRow({ apiKey }: { apiKey: IntegrationKeyRow }) {
  const [state, revoke, revoking] = useActionState(revokeIntegrationKey, initial);
  const { revoked } = apiKey;
  return (
    <li className={`flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm ${revoked ? 'border-zinc-200 dark:border-zinc-800' : 'border-zinc-300 dark:border-zinc-700'}`}>
      <span className="font-medium">{apiKey.label}</span>
      <span className="text-zinc-600 dark:text-zinc-400">{apiKey.scopes.join(', ')}</span>
      <span className="text-zinc-600 dark:text-zinc-400">
        {revoked ? 'revoked' : apiKey.lastUsed ? `last used ${apiKey.lastUsed}` : 'never used'}
      </span>
      {revoked ? null : (
        <form action={revoke} className="ml-auto flex items-center gap-2">
          <input type="hidden" name="id" value={apiKey.id} />
          <button type="submit" disabled={revoking} className={small} aria-label={`Revoke ${apiKey.label}`}>
            Revoke
          </button>
        </form>
      )}
      <span aria-live="polite" className="text-xs">
        {state.message ?? ''}
      </span>
    </li>
  );
}
