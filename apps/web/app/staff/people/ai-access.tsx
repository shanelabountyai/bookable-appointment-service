'use client';

import { useActionState } from 'react';
import type { StaffRow } from '@bookable/db/auth';
import { type AiAccessRow, type McpTokenState, issueAiAccess, revokeAiAccess } from '@/lib/auth/mcp-token-actions';

const initial: McpTokenState = {};
const field = 'rounded-md border border-zinc-400 bg-transparent px-2 py-1 text-sm dark:border-zinc-600';
const small = 'rounded-md border border-zinc-400 px-2 py-1 text-xs font-medium dark:border-zinc-600';

/**
 * M-002 — the owner's view of who has AI access (MCP PRD §5).
 *
 * Only rendered for an owner (the page passes `null` otherwise), and the
 * actions refuse regardless — the control is in `requireOwner`, not in what is
 * drawn. The minted token appears ONCE, in the action's response, and is never
 * on the list: the database holds its hash and nothing else.
 */
export function AiAccess({ people, tokens }: { people: StaffRow[]; tokens: AiAccessRow[] }) {
  const [issueState, issue, issuing] = useActionState(issueAiAccess, initial);
  const active = people.filter((p) => p.active);

  return (
    <section aria-labelledby="ai-access-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="ai-access-heading" className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          AI access
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          A token lets an AI assistant book, move and check in on behalf of ONE named person, under the
          same rules as the desk. Everything it does is logged under their name. Take somebody off the
          roster and every token they hold stops working.
        </p>
      </div>

      <form action={issue} className="flex flex-wrap items-end gap-2 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
        <label className="flex flex-col gap-1 text-sm">
          For
          <select name="staffUserId" className={field}>
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Label
          <input name="label" placeholder="Sam’s laptop" className={field} />
        </label>
        <button type="submit" disabled={issuing} className={small}>
          {issuing ? 'Issuing…' : 'Issue token'}
        </button>
        <p aria-live="polite" className="w-full text-sm text-zinc-700 dark:text-zinc-300">
          {issueState.message ?? ''}
        </p>
        {issueState.token ? (
          <output className="w-full break-all rounded-md border border-zinc-400 bg-zinc-50 px-3 py-2 font-mono text-sm dark:border-zinc-600 dark:bg-zinc-900">
            {issueState.token}
          </output>
        ) : null}
      </form>

      {tokens.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No tokens issued.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tokens.map((t) => (
            <TokenRow key={t.id} token={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TokenRow({ token }: { token: AiAccessRow }) {
  const [state, revoke, revoking] = useActionState(revokeAiAccess, initial);
  const { revoked } = token;
  return (
    <li className={`flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm ${revoked ? 'border-zinc-200 dark:border-zinc-800' : 'border-zinc-300 dark:border-zinc-700'}`}>
      <span className="font-medium">{token.staffName}</span>
      <span>{token.label}</span>
      <span className="text-zinc-600 dark:text-zinc-400">
        {revoked ? 'revoked' : token.lastUsed ? `last used ${token.lastUsed}` : 'never used'}
      </span>
      {revoked ? null : (
        <form action={revoke} className="ml-auto flex items-center gap-2">
          <input type="hidden" name="id" value={token.id} />
          <button type="submit" disabled={revoking} className={small}>
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
