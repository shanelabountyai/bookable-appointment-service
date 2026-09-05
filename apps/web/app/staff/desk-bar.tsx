'use client';

import { useActionState } from 'react';
import { type SwitchState, switchStaff } from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
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
    <div className="border-b border-line-hairline bg-ground-sunken text-body print:hidden">
      <details className="mx-auto w-full max-w-5xl px-4 py-2">
        <summary className="cursor-pointer">
          At the desk: <span className="font-medium">{currentName}</span>
        </summary>

        {options.length === 0 ? (
          <p className="mt-2 text-ink-muted">
            Nobody else has a desk PIN yet. Add one under Setup → Who works here.
          </p>
        ) : (
          <form action={action} className="mt-2 flex flex-wrap items-end gap-2">
            {/* A-085 restyles this onto A-088's tokens and A-089's primitives.
                The `<select>` stays a hand-written native element: §5.3 defers
                a `Select` primitive until a second caller exists, and this is
                still the only one. */}
            <label className="flex flex-col gap-1 text-caption font-medium text-ink-secondary">
              Who
              <select
                name="staffUserId"
                className="min-h-11 rounded-control border border-line-control bg-transparent px-3 py-2 text-body text-ink-primary"
              >
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
            <Field id="desk-pin" label="PIN">
              {(control) => (
                <Input
                  {...control}
                  name="pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  className="w-24"
                />
              )}
            </Field>
            <Button type="submit" pending={pending}>
              {pending ? 'Switching…' : 'That’s me'}
            </Button>
            <p aria-live="polite" className="text-ink-secondary">
              {state.error ?? state.message ?? ''}
            </p>
          </form>
        )}
      </details>
    </div>
  );
}
