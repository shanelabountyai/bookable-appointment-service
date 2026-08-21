'use client';

import { useActionState } from 'react';
import { type SwitchState, switchStaff } from '@/lib/auth/actions';
import type { StaffOption } from '@bookable/db/auth';

const initial: SwitchState = {};

/**
 * The desk switcher (D-33).
 *
 * Collapsed to one line by a native `<details>`: it sits on top of every staff
 * screen and the answer is usually "yes, still me". No JavaScript state, no
 * dialog, keyboard-operable and screen-reader-announced for free — which is
 * the whole reason to reach for the element rather than build a popover.
 *
 * The PIN field is `inputMode="numeric"`, so the salon's tablet shows a keypad
 * rather than a full keyboard. Switching that takes two taps and a hunt is
 * switching nobody does, and then every event says "the front desk" again.
 */
export function DeskBar({ currentName, options }: { currentName: string; options: StaffOption[] }) {
  const [state, action, pending] = useActionState(switchStaff, initial);

  return (
    <div className="border-b border-zinc-200 bg-zinc-50 text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <details className="mx-auto w-full max-w-5xl px-4 py-2">
        <summary className="cursor-pointer">
          At the desk: <span className="font-medium">{currentName}</span>
        </summary>

        {options.length === 0 ? (
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            Nobody else has a desk PIN yet. Add one under Settings → Who works here.
          </p>
        ) : (
          <form action={action} className="mt-2 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              Who
              <select
                name="staffUserId"
                className="rounded-md border border-zinc-400 bg-transparent px-2 py-1 dark:border-zinc-600"
              >
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              PIN
              <input
                name="pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                className="w-24 rounded-md border border-zinc-400 bg-transparent px-2 py-1 dark:border-zinc-600"
              />
            </label>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md border border-zinc-400 px-2 py-1 font-medium disabled:opacity-60 dark:border-zinc-600"
            >
              {pending ? 'Switching…' : 'That’s me'}
            </button>
            <p aria-live="polite" className="text-zinc-700 dark:text-zinc-300">
              {state.error ?? state.message ?? ''}
            </p>
          </form>
        )}
      </details>
    </div>
  );
}
