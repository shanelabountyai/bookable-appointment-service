'use client';

import { useActionState } from 'react';
import type { ProviderRow } from '@bookable/db/settings';
import { type FormState, type ProviderToggleState, addProvider, toggleProviderActive } from '@/lib/settings/actions';
import { PhoneLink } from '@/components/ui/phone-link';

const initial: FormState = {};
const initialToggle: ProviderToggleState = {};

export function AddProviderForm() {
  const [state, formAction, pending] = useActionState(addProvider, initial);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor="displayName" className="text-sm font-medium">
            Add a provider
          </label>
          <input
            id="displayName"
            name="displayName"
            required
            aria-invalid={state.errors?.displayName ? true : undefined}
            aria-describedby={state.errors?.displayName ? 'displayName-error' : undefined}
            className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {pending ? 'Adding…' : 'Add'}
        </button>
      </div>
      <p id="displayName-error" aria-live="polite" className="min-h-5 text-sm text-red-600 dark:text-red-400">
        {state.errors?.displayName ?? ''}
      </p>
    </form>
  );
}

export function ProviderRowItem({ provider }: { provider: ProviderRow }) {
  const [state, formAction, pending] = useActionState(toggleProviderActive, initialToggle);
  const needsConfirm = state.errors?._confirm;

  return (
    <li className="flex flex-col gap-2 border-b border-zinc-200 py-3 last:border-0 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className={provider.active ? 'font-medium' : 'font-medium text-zinc-400 line-through'}>
            {provider.displayName}
          </span>
          {!provider.active && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              Not taking bookings
            </span>
          )}
        </div>

        {/* AVAIL-05 (operator P-8): deactivating with a book full of future
            appointments is a two-step confirm — the SAME shape SVC-03 uses
            for a service, over the richer list this surface already builds
            (A-019). A native submit button with its own name/value carries
            "confirm" only when IT is the one clicked, so "Deactivate anyway"
            needs no extra state to resubmit correctly. */}
        <form action={formAction}>
          <input type="hidden" name="providerId" value={provider.id} />
          <input type="hidden" name="active" value={provider.active ? 'false' : 'true'} />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {provider.active ? 'Deactivate' : 'Reactivate'}
          </button>

          {needsConfirm && (
            <div className="mt-2 flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
              <p>{needsConfirm}</p>
              <ul className="flex flex-col gap-1">
                {state.stranded?.map((row) => (
                  <li key={row.id}>
                    {row.when} — {row.clientName ?? 'No name'}{' '}
                    {row.clientPhone && (
                      <PhoneLink phone={row.clientPhone} />
                    )}{' '}
                    · {row.services}
                  </li>
                ))}
              </ul>
              <button
                type="submit"
                name="confirm"
                value="true"
                disabled={pending}
                className="self-start rounded-md border border-amber-600 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:text-amber-200 dark:hover:bg-amber-900"
              >
                Deactivate anyway
              </button>
            </div>
          )}
        </form>
      </div>
    </li>
  );
}
