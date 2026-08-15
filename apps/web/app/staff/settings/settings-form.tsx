'use client';

import { useActionState } from 'react';
import type { BusinessSettings } from '@bookable/db/settings';
import { type FormState, saveBusinessSettings } from '@/lib/settings/actions';

const initial: FormState = {};

function Field({
  label,
  name,
  hint,
  error,
  children,
}: {
  label: string;
  name: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  const hintId = hint ? `${name}-hint` : undefined;
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && (
        <p id={hintId} className="text-xs text-zinc-500">
          {hint}
        </p>
      )}
      {/* The message names the offending service, so it belongs beside the
          field rather than in a summary at the top of an 11-field form. */}
      {error && (
        <p id={errorId} className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

const inputClass =
  'rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950 aria-[invalid=true]:border-red-500';

export function SettingsForm({ settings }: { settings: BusinessSettings }) {
  const [state, formAction, pending] = useActionState(saveBusinessSettings, initial);
  const err = (f: string) => state.errors?.[f];
  const invalid = (f: string) => (err(f) ? true : undefined);
  const described = (f: string, hasHint = false) =>
    [err(f) ? `${f}-error` : null, hasHint ? `${f}-hint` : null].filter(Boolean).join(' ') || undefined;

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">The business</h2>
        <Field label="Name" name="name" error={err('name')}>
          <input
            id="name"
            name="name"
            defaultValue={settings.name}
            aria-invalid={invalid('name')}
            aria-describedby={described('name')}
            className={inputClass}
          />
        </Field>
        <Field
          label="Timezone"
          name="timezone"
          hint="An IANA zone id. Every slot is computed and labelled in this zone, never the customer's."
          error={err('timezone')}
        >
          <input
            id="timezone"
            name="timezone"
            defaultValue={settings.timezone}
            aria-invalid={invalid('timezone')}
            aria-describedby={described('timezone', true)}
            className={inputClass}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Booking policy</h2>

        <Field label="Slot interval (minutes)" name="slotIntervalMinutes" hint="How far apart offered start times are." error={err('slotIntervalMinutes')}>
          <input id="slotIntervalMinutes" name="slotIntervalMinutes" type="number" min={1} defaultValue={settings.slotIntervalMinutes}
            aria-invalid={invalid('slotIntervalMinutes')} aria-describedby={described('slotIntervalMinutes', true)} className={inputClass} />
        </Field>

        <Field
          label="Minimum lead time (minutes)"
          name="minimumLeadMinutes"
          hint="How far ahead a customer must book. Must be at least as long as every cancellation cutoff, or a client can book a slot she is already unable to cancel."
          error={err('minimumLeadMinutes')}
        >
          <input id="minimumLeadMinutes" name="minimumLeadMinutes" type="number" min={0} defaultValue={settings.minimumLeadMinutes}
            aria-invalid={invalid('minimumLeadMinutes')} aria-describedby={described('minimumLeadMinutes', true)} className={inputClass} />
        </Field>

        <Field label="Cancellation cutoff (minutes)" name="cancellationCutoffMinutes" hint="Individual services may set a longer one." error={err('cancellationCutoffMinutes')}>
          <input id="cancellationCutoffMinutes" name="cancellationCutoffMinutes" type="number" min={0} defaultValue={settings.cancellationCutoffMinutes}
            aria-invalid={invalid('cancellationCutoffMinutes')} aria-describedby={described('cancellationCutoffMinutes', true)} className={inputClass} />
        </Field>

        <Field label="Booking horizon (days)" name="bookingHorizonDays" hint="Self-serve only — staff booking is never capped." error={err('bookingHorizonDays')}>
          <input id="bookingHorizonDays" name="bookingHorizonDays" type="number" min={1} defaultValue={settings.bookingHorizonDays}
            aria-invalid={invalid('bookingHorizonDays')} aria-describedby={described('bookingHorizonDays', true)} className={inputClass} />
        </Field>

        <Field label="No-show threshold" name="noShowBlockThreshold" hint="No-shows in a rolling 12 months before self-serve booking is blocked. Staff can always override." error={err('noShowBlockThreshold')}>
          <input id="noShowBlockThreshold" name="noShowBlockThreshold" type="number" min={0} defaultValue={settings.noShowBlockThreshold}
            aria-invalid={invalid('noShowBlockThreshold')} aria-describedby={described('noShowBlockThreshold', true)} className={inputClass} />
        </Field>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Slot policy</h2>

        <div className="flex items-start gap-2">
          <input id="bufferMayOverlapBreak" name="bufferMayOverlapBreak" type="checkbox" defaultChecked={settings.bufferMayOverlapBreak} className="mt-1" />
          <label htmlFor="bufferMayOverlapBreak" className="text-sm">
            A service&apos;s buffer may overlap a break
            <span className="block text-xs text-zinc-500">Tidying up can run into the lunch hour.</span>
          </label>
        </div>

        <div className="flex items-start gap-2">
          <input id="bufferMayExtendPastClose" name="bufferMayExtendPastClose" type="checkbox" defaultChecked={settings.bufferMayExtendPastClose} className="mt-1" />
          <label htmlFor="bufferMayExtendPastClose" className="text-sm">
            A service&apos;s buffer may extend past closing
            <span className="block text-xs text-zinc-500">The last client of the day still gets booked.</span>
          </label>
        </div>

        <Field
          label="Repeated hour on the clocks-go-back day"
          name="ambiguousLocalTime"
          hint="On that day 01:30 happens twice. Offering both is an extra hour of real, bookable capacity; the times are labelled with their offset so nobody is confused."
          error={err('ambiguousLocalTime')}
        >
          <select id="ambiguousLocalTime" name="ambiguousLocalTime" defaultValue={settings.ambiguousLocalTime}
            aria-describedby={described('ambiguousLocalTime', true)} className={inputClass}>
            <option value="offer-both">Offer both occurrences</option>
            <option value="offer-earlier-only">Offer only the first</option>
          </select>
        </Field>
      </section>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900">
          {pending ? 'Saving…' : 'Save settings'}
        </button>
        <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
          {state.ok ? state.message : ''}
        </p>
      </div>
    </form>
  );
}
