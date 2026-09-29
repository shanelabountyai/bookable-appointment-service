'use client';

import { useActionState } from 'react';
import { type FormState, mergeClientRecords, saveClientContact } from '@/lib/clients/actions';

const initial: FormState = {};

/**
 * A-146 (C5): edit name, phone and email. Scoped at `packages/db`'s
 * `updateClientContact` (D-66's sink pattern), which refuses a save that
 * would put this record's phone + name onto another LIVE client's identity
 * rather than silently splitting or colliding — see `contactMatch` below.
 */
export function ContactForm({ clientId, name, phone, email }: { clientId: string; name: string; phone: string; email: string }) {
  const [state, formAction, pending] = useActionState(saveClientContact, initial);
  const [mergeState, mergeAction, merging] = useActionState(mergeClientRecords, initial);

  return (
    <div className="flex flex-col gap-2">
      <form action={formAction} className="flex flex-col gap-2">
        <input type="hidden" name="clientId" value={clientId} />
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">Name</span>
            <input
              name="name"
              defaultValue={name}
              className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">Phone</span>
            <input
              name="phone"
              defaultValue={phone}
              className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">Email</span>
            <input
              name="email"
              type="email"
              defaultValue={email}
              className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
            />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="self-start rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-zinc-700"
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
          <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
            {mergeState.message ?? (state.contactMatch ? '' : (state.message ?? ''))}
          </p>
        </div>
      </form>

      {state.contactMatch ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
          <p>
            That phone number and name already belong to <strong>{state.contactMatch.name ?? 'another record'}</strong>.
          </p>
          <form action={mergeAction}>
            <input type="hidden" name="survivorId" value={clientId} />
            <input type="hidden" name="losingId" value={state.contactMatch.id} />
            <button
              type="submit"
              disabled={merging}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium disabled:opacity-60 dark:border-zinc-700"
            >
              Merge it into this record
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
