'use client';

import { useActionState } from 'react';
import type { AppointmentStatus } from '@bookable/core/scheduling';
import { type DetailState, changeStatus } from '@/lib/appointments/actions';

const initial: DetailState = {};

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
 */
export function StatusControls({
  appointmentId,
  status,
  available,
}: {
  appointmentId: string;
  status: AppointmentStatus;
  available: AppointmentStatus[];
}) {
  const [state, action, pending] = useActionState(changeStatus, initial);

  if (available.length === 0) {
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
            className="rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-zinc-600"
          >
            {LABELS[to]}
          </button>
        ))}
      </div>

      <p aria-live="polite" className="text-sm text-zinc-700 dark:text-zinc-300">
        {state.message ?? ''}
      </p>
    </form>
  );
}

/** The eight statuses as the front desk would say them, TOTAL over the enum so
 *  a ninth state is a compile error rather than a raw value on a button. */
const LABELS = {
  booked: 'Put back to booked',
  confirmed: 'Confirm',
  checked_in: 'Check in',
  in_progress: 'Start',
  completed: 'Finish',
  no_show: 'No-show',
  cancelled: 'Cancel',
  cancelled_late: 'Cancel (late)',
} satisfies Record<AppointmentStatus, string>;
