'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import {
  type ConflictRow,
  type ImpactState,
  cancelConflicting,
  keepFlagged,
  reassignConflicting,
} from '@/lib/availability/impact-actions';

const initial: ImpactState = {};
const small = 'rounded-md border border-zinc-400 px-2 py-1 text-xs font-medium dark:border-zinc-600';
const field = 'rounded-md border border-zinc-400 bg-transparent px-2 py-1 text-sm dark:border-zinc-600';

/**
 * AVAIL-05's four actions, per appointment plus one in bulk.
 *
 * The bulk reassign is deliberately opt-in per row rather than "all": the
 * front desk works down this list on the phone, and a button that moves
 * everything is one mis-tap away from moving the three somebody has already
 * sorted out.
 */
export function ConflictList({
  conflicts,
  providers,
}: {
  conflicts: ConflictRow[];
  providers: { id: string; name: string }[];
}) {
  const [reassignState, doReassign, reassigning] = useActionState(reassignConflicting, initial);
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((s) => s !== id) : [...current, id]));

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-col gap-3">
        {conflicts.map((conflict) => (
          <li
            key={conflict.id}
            className={`flex flex-col gap-2 rounded-md border p-4 ${
              conflict.acknowledged
                ? 'border-zinc-300 dark:border-zinc-700'
                : 'border-amber-500'
            }`}
          >
            <div className="flex flex-wrap items-baseline gap-x-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={selected.includes(conflict.id)}
                  onChange={() => toggle(conflict.id)}
                  aria-label={`Select ${conflict.clientName ?? 'walk-in'} at ${conflict.when}`}
                />
                {conflict.when} · {conflict.clientName ?? 'Walk-in, no name'}
              </label>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                {conflict.services} · {conflict.providerName}
              </span>
              {/* The phone number is ON the row: the resolution to most of
                  these is a call, and a list you have to click nine times to
                  use is a list the front desk copies onto paper. */}
              {conflict.clientPhone ? (
                <a href={`tel:${conflict.clientPhone}`} className="text-sm underline underline-offset-4">
                  {conflict.clientPhone}
                </a>
              ) : null}
            </div>

            {/* A-036: what she has already been told, so the next call does
                not contradict a text sent an hour ago. */}
            {conflict.lastNotice ? (
              <p className="text-xs text-zinc-600 dark:text-zinc-400">Told: {conflict.lastNotice}</p>
            ) : null}

            {conflict.acknowledged ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Kept — {conflict.acknowledgedReason ?? 'dealt with'}
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <KeepForm appointmentId={conflict.id} />
                <CancelForm appointmentId={conflict.id} />
                {/* "Offer a new time" is the reschedule (A-014), which since
                    A-033 has a staff surface — so this goes to the move panel
                    on her appointment rather than to the day view, where the
                    desk could only look at times it had no way to take. The
                    manage link re-points itself (TOKEN-02). */}
                <Link href={`/staff/appointments/${conflict.id}#move`} className={small}>
                  Find another time
                </Link>
              </div>
            )}
          </li>
        ))}
      </ul>

      <form action={doReassign} className="flex flex-col gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Reassign the selected
        </h2>
        {selected.map((id) => (
          <input key={id} type="hidden" name="appointmentIds" value={id} />
        ))}

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            To
            <select name="toProviderId" className={field}>
              <option value="">Choose a stylist…</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {/* Not a bare "Why?": the keep and cancel forms on every row ask
                the same question, and three identically-labelled fields read
                as one repeated field to a screen reader. */}
            Why move them?
            <input name="reason" placeholder="Dana off sick" className={field} />
          </label>
          {/* A-036. Unticked tells them — the box is for the desk that has
              already worked down the list on the phone. */}
          <label className="flex items-center gap-2 py-2 text-sm">
            <input type="checkbox" name="skipNotice" />
            I’ve already rung them — don’t text
          </label>
          <button
            type="submit"
            disabled={reassigning || selected.length === 0}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {reassigning ? 'Moving…' : `Move ${selected.length} where qualified`}
          </button>
        </div>

        <p aria-live="polite" className="text-sm text-zinc-700 dark:text-zinc-300">
          {reassignState.message ?? ''}
        </p>
      </form>
    </div>
  );
}

function KeepForm({ appointmentId }: { appointmentId: string }) {
  const [state, action, pending] = useActionState(keepFlagged, initial);
  return (
    <form action={action} className="flex items-end gap-1">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <label className="flex flex-col gap-1 text-xs">
        Keep — why?
        <input name="reason" placeholder="Called her, coming anyway" className={field} />
      </label>
      <button type="submit" disabled={pending} className={small}>
        Keep
      </button>
      <span aria-live="polite" className="text-xs">
        {state.message ?? ''}
      </span>
    </form>
  );
}

function CancelForm({ appointmentId }: { appointmentId: string }) {
  const [state, action, pending] = useActionState(cancelConflicting, initial);
  return (
    <form action={action} className="flex items-end gap-1">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <label className="flex flex-col gap-1 text-xs">
        Cancel — why?
        <input name="reason" placeholder="Salon closed, rebooking her" className={field} />
      </label>
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" name="skipNotice" />
        Already rung her
      </label>
      <button type="submit" disabled={pending} className={small}>
        Cancel it
      </button>
      <span aria-live="polite" className="text-xs">
        {state.message ?? ''}
      </span>
    </form>
  );
}
