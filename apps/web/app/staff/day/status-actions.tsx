'use client';

import { useActionState } from 'react';
import type { AppointmentStatus } from '@bookable/core/scheduling';
import { type DetailState, changeStatus } from '@/lib/appointments/actions';

const initial: DetailState = {};

/**
 * THE STATUS BUTTONS ON A DAY CHIP (A-035, APPT-03, operator P-4).
 *
 * Check-in is the most frequent action in the salon and it cost four
 * interactions and two page loads: read the grid, open the appointment, press
 * the button, come back. The day is where the desk already is, so this is the
 * same write path — `changeStatus`, A-027's optimistic lock and all — rendered
 * where the client is standing.
 *
 * NOTHING HERE DECIDES WHAT IS LEGAL. `moves` comes from the server, which
 * asked the §7 table with this actor and this clock (see the view model), so a
 * button can never offer a move the write path then refuses. A second
 * `if (status === ...)` on a screen is the rental `VERIFIED` defect starting
 * over, and it starts silently.
 *
 * Layout is the CALLER's: the grid has 45 pixels and the stylist's list has a
 * whole row, and neither should have to configure the other through a flag.
 */
export function StatusActions({
  appointmentId,
  status,
  moves,
  className = '',
  buttonClassName = '',
}: {
  appointmentId: string;
  status: AppointmentStatus;
  moves: AppointmentStatus[];
  className?: string;
  buttonClassName?: string;
}) {
  const [state, action, pending] = useActionState(changeStatus, initial);

  if (moves.length === 0) return null;

  return (
    <form action={action} className={className}>
      <input type="hidden" name="appointmentId" value={appointmentId} />
      {/* A-027's optimistic lock: the status the screen SHOWED. If somebody
          else moved it meanwhile the write is refused and says who got there
          first, rather than silently overwriting their decision — which on a
          surface four people are looking at is not a rare case. */}
      <input type="hidden" name="expectedFrom" value={status} />

      {/* A refusal REPLACES the buttons. Pressing again cannot help: either
          the screen's idea of the status is stale, or the move needs a reason
          this surface has no box for. The day refreshes itself every 15
          seconds, so the truth arrives without anybody reloading. */}
      {state.ok === false ? null : (
        <>
          {moves.map((to) => (
            <button
              key={to}
              type="submit"
              name="to"
              value={to}
              disabled={pending}
              className={buttonClassName}
            >
              {STATUS_ACTION_LABELS[to]}
            </button>
          ))}
        </>
      )}

      <p aria-live="polite" className={state.message ? 'w-full' : 'sr-only'}>
        {state.message ?? ''}
      </p>
    </form>
  );
}

/** The eight statuses as the front desk would say them, TOTAL over the enum so
 *  a ninth state is a compile error rather than a raw value on a button.
 *  Shared with the detail panel's controls: two surfaces calling the same move
 *  by two different names is its own small lie. */
export const STATUS_ACTION_LABELS = {
  booked: 'Put back to booked',
  confirmed: 'Confirm',
  checked_in: 'Check in',
  in_progress: 'Start',
  completed: 'Finish',
  no_show: 'No-show',
  // A-060: THESE TWO ARE NO LONGER RENDERED ANYWHERE, and putting either back
  // on a button row is the defect this map used to cause. The chip has never
  // offered cancelling (A-035), and the detail panel takes both out of its
  // list and draws ONE button whose status the server derives from the cutoff.
  // They stay because the map is `satisfies Record<AppointmentStatus, string>`
  // — total over the enum, so a ninth status is a compile error — and because
  // a `word()` lookup for either is still correct.
  cancelled: 'Cancel',
  cancelled_late: 'Cancel (late)',
} satisfies Record<AppointmentStatus, string>;
