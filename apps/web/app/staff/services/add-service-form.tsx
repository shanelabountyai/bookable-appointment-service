'use client';

import { useActionState } from 'react';
import { type FormState, addService } from '@/lib/settings/service-actions';
import { ServiceFormFields } from './service-form-fields';

const initial: FormState = {};

export function AddServiceForm() {
  const [state, formAction, pending] = useActionState(addService, initial);
  return (
    <details className="rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
      <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Add a service
      </summary>
      <form action={formAction} className="mt-4 flex flex-col gap-4">
        <ServiceFormFields idPrefix="add" errors={state.errors} />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {pending ? 'Adding…' : 'Add service'}
          </button>
          <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
            {state.ok ? state.message : ''}
          </p>
        </div>
      </form>
    </details>
  );
}
