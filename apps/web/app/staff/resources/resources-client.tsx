'use client';

import { useActionState } from 'react';
import type { ResourceRow } from '@bookable/db/settings';
import type { FormState } from '@/lib/settings/actions';
import {
  type ResourceToggleState,
  addResource,
  addResourceType,
  toggleResourceActive,
} from '@/lib/settings/resource-actions';

const initial: FormState = {};
const initialToggle: ResourceToggleState = {};

const inputClass = 'rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950';
const buttonClass =
  'rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900';

export function AddResourceTypeForm() {
  const [state, formAction, pending] = useActionState(addResourceType, initial);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor="typeName" className="text-sm font-medium">
            Add a kind of resource
          </label>
          <input
            id="typeName"
            name="typeName"
            required
            placeholder="Chair"
            aria-invalid={state.errors?.typeName ? true : undefined}
            aria-describedby={state.errors?.typeName ? 'typeName-error' : undefined}
            className={inputClass}
          />
        </div>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Adding…' : 'Add'}
        </button>
      </div>
      <p id="typeName-error" aria-live="polite" className="min-h-5 text-sm text-red-600 dark:text-red-400">
        {state.errors?.typeName ?? ''}
      </p>
    </form>
  );
}

export function AddResourceForm({ resourceTypeId, typeName }: { resourceTypeId: string; typeName: string }) {
  const [state, formAction, pending] = useActionState(addResource, initial);
  const errorId = `resourceName-error-${resourceTypeId}`;
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="resourceTypeId" value={resourceTypeId} />
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor={`resourceName-${resourceTypeId}`} className="text-sm font-medium">
            Add a {typeName.toLowerCase()}
          </label>
          <input
            id={`resourceName-${resourceTypeId}`}
            name="resourceName"
            required
            aria-invalid={state.errors?.resourceName ? true : undefined}
            aria-describedby={state.errors?.resourceName ? errorId : undefined}
            className={inputClass}
          />
        </div>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Adding…' : 'Add'}
        </button>
      </div>
      <p id={errorId} aria-live="polite" className="min-h-5 text-sm text-red-600 dark:text-red-400">
        {state.errors?.resourceName ?? ''}
      </p>
    </form>
  );
}

/**
 * One resource, with the two-step retirement.
 *
 * The same shape the provider deactivation uses (A-025/A-019) and for the same
 * reason: a native submit button carrying its own `name`/`value` sends
 * "confirm" only when IT is the one clicked, so "Take it out anyway" needs no
 * extra state to resubmit correctly.
 */
export function ResourceRowItem({ resource }: { resource: ResourceRow }) {
  const [state, formAction, pending] = useActionState(toggleResourceActive, initialToggle);
  const needsConfirm = state.errors?._confirm;

  return (
    <li className="flex flex-col gap-2 border-b border-zinc-200 py-3 last:border-0 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className={resource.active ? 'font-medium' : 'font-medium text-zinc-400 line-through'}>
            {resource.name}
          </span>
          {!resource.active && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              Out of service
            </span>
          )}
        </div>

        <form action={formAction}>
          <input type="hidden" name="resourceId" value={resource.id} />
          <input type="hidden" name="active" value={resource.active ? 'false' : 'true'} />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {resource.active ? 'Take out of service' : 'Put back in service'}
          </button>

          {needsConfirm && (
            <div className="mt-2 flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
              <p>{needsConfirm}</p>
              <button
                type="submit"
                name="confirm"
                value="true"
                disabled={pending}
                className="self-start rounded-md border border-amber-600 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:text-amber-200 dark:hover:bg-amber-900"
              >
                Take it out anyway
              </button>
            </div>
          )}
        </form>
      </div>
    </li>
  );
}
