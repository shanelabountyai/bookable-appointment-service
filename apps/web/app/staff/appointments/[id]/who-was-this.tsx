'use client';

import { useActionState, useState } from 'react';
import { ClientPicker } from '@/components/client-picker';
import { type ClientState, setAppointmentClientAction } from '@/lib/appointments/visit-actions';
import { type ClientChoice, findClientsForBooking } from '@/lib/booking/staff-actions';

const initial: ClientState = {};
const secondary = 'rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium dark:border-zinc-600';

/**
 * A-068 — WHO WAS THIS? (BOOK-04, CLIENT-01.)
 *
 * The walk-in typed in as nothing but a time gets a name at the till; the
 * wrong Sarah Jones gets corrected at check-in. Both used to be
 * cancel-and-rebook, and since A-060 that cancel derives `cancelled_late` — a
 * late cancellation on an innocent client's twelve-month count, for the desk's
 * own typo.
 *
 * THE SAME PICKER AS `/staff/book`, not a second one. Search-or-create, the
 * reliability flag as a note, the already-booked-nearby note that D-17
 * requires be a note and never a refusal — all of it decided once, in
 * `components/client-picker.tsx`.
 *
 * "Nobody" is its own button rather than an option inside the picker, because
 * detaching is a deliberate sentence — *this was not her* — and not the same
 * gesture as failing to find somebody.
 */
export function WhoWasThis({
  appointmentId,
  startAtIso,
  serviceIds,
  current,
}: {
  appointmentId: string;
  /** The instant, never `{date, time}` (D-4) — the picker's already-booked
   *  note is computed against it. */
  startAtIso: string;
  serviceIds: string[];
  current: { id: string; name: string | null; phone: string | null } | null;
}) {
  const [state, action, pending] = useActionState(setAppointmentClientAction, initial);
  const [choice, setChoice] = useState<ClientChoice | null>(null);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="clientId" value={choice?.id ?? ''} />

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {current
          ? `Recorded as ${current.name ?? 'a client with no name'}${current.phone ? ` · ${current.phone}` : ''}.`
          : 'Nobody — this was booked as a walk-in with no record.'}
      </p>

      <ClientPicker
        value={choice}
        onChange={setChoice}
        search={(text: string) => findClientsForBooking(text, startAtIso, serviceIds)}
        inputId="who-was-this-search"
        changeWord="pick somebody else"
        // Detaching is the button below, with words on it.
        allowNoName={false}
      />

      <label className="flex flex-col gap-1 text-sm">
        Why (optional)
        <input
          name="reason"
          className="rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-sm dark:border-zinc-600"
          placeholder="Rebooked at the till"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending || choice === null} className={secondary}>
          {pending ? 'Saving…' : current ? 'Change who this is for' : 'Attach this client'}
        </button>
        {/* Only offered when there is something to take off, and it carries
            its OWN field rather than a second `clientId`: two inputs of one
            name and `formData.get` returns the first one in the DOM, so this
            button would have silently submitted whatever the picker held. */}
        {current ? (
          <button type="submit" name="detach" value="1" disabled={pending} className={secondary}>
            This wasn’t her — take it off the record
          </button>
        ) : null}
      </div>

      <p aria-live="polite" className="text-sm text-zinc-700 dark:text-zinc-300">
        {state.message ?? ''}
      </p>
    </form>
  );
}
