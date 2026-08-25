'use client';

import { useActionState } from 'react';
import type { AppointmentStatus } from '@bookable/core/scheduling';
import { type DetailState, changeStatus } from '@/lib/appointments/actions';
import { STATUS_ACTION_LABELS } from '@/app/staff/day/status-actions';

const initial: DetailState = {};

const buttonClass =
  'rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-zinc-600';

/**
 * The status buttons (APPT-01, APPT-03, APPT-06).
 *
 * The list comes from the server, which asked the §7 transition table with
 * this actor and this clock — so a button here can never offer a move the
 * write path then refuses. Nothing in this file decides what is legal.
 *
 * The reason field is always available and only sometimes required. The
 * machine decides which: a walk-out and a terminal correction need one, an
 * ordinary check-in does not, and the refusal comes back in words if it is
 * missing.
 *
 * A-060: CANCELLING IS ONE BUTTON. `cancelled` and `cancelled_late` are not in
 * `available` — the page took them out — because two buttons a thumb-width
 * apart, pressed under pressure, decided a number that lands on the client's
 * rolling late-cancel count and on the owner's staffing decisions. The server
 * derives the status from the cutoff and the clock; `cancelAs` is what it will
 * decide, shown so the desk knows before it presses rather than after.
 *
 * The escape beside it is deliberately NOT a second classification button. It
 * appears only when the machine's answer is `cancelled_late`, it says what it
 * means in the salon's words, it demands a reason, and it is recorded as an
 * overrule — so "we let this one off" stays a visible, countable act instead
 * of being indistinguishable from the cutoff never having applied.
 */
export function StatusControls({
  appointmentId,
  status,
  available,
  cancelAs,
}: {
  appointmentId: string;
  status: AppointmentStatus;
  available: AppointmentStatus[];
  /** What the server WILL write if the one Cancel button is pressed, or null
   *  when no cancellation is on the table at all. Advisory: the write path
   *  derives it again from the same arithmetic and never trusts this. */
  cancelAs: 'cancelled' | 'cancelled_late' | null;
}) {
  const [state, action, pending] = useActionState(changeStatus, initial);

  if (available.length === 0 && !cancelAs) {
    return (
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Nothing more to do with this one — {status.replace('_', ' ')} is where it ends.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      {/* The status the screen SHOWED. If somebody else moved it meanwhile,
          the write is refused and says who got there first, rather than
          silently overwriting their decision. */}
      <input type="hidden" name="expectedFrom" value={status} />

      <label className="flex flex-col gap-1 text-sm">
        Reason (needed for some changes)
        <input
          name="reason"
          placeholder="She walked out / marked wrong yesterday"
          className="rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-sm dark:border-zinc-600"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        {available.map((to) => (
          <button
            key={to}
            type="submit"
            name="to"
            value={to}
            disabled={pending}
            className={buttonClass}
          >
            {STATUS_ACTION_LABELS[to]}
          </button>
        ))}

        {/* One button, and `to` is deliberately absent from it: the status is
            the server's to choose, so this posts the INTENT and the write path
            resolves the cutoff from real rows. */}
        {cancelAs ? (
          <button type="submit" name="cancel" value="derive" disabled={pending} className={buttonClass}>
            {cancelAs === 'cancelled_late' ? 'Cancel — counts as late' : 'Cancel'}
          </button>
        ) : null}
      </div>

      {cancelAs === 'cancelled_late' ? (
        <button
          type="submit"
          name="cancel"
          value="override"
          disabled={pending}
          className="self-start rounded-md border border-dashed border-zinc-400 px-3 py-2 text-left text-sm disabled:opacity-60 dark:border-zinc-600"
        >
          She gave us proper notice, or this one&apos;s on us — don&apos;t count it late
          <span className="mt-0.5 block text-xs text-zinc-600 dark:text-zinc-400">
            Needs a reason. Recorded as overruling the cutoff.
          </span>
        </button>
      ) : null}

      <p aria-live="polite" className="text-sm text-zinc-700 dark:text-zinc-300">
        {state.message ?? ''}
      </p>
    </form>
  );
}
