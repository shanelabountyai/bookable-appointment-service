'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { type CancelState, cancelAppointment } from '@/lib/manage/actions';

const initial: CancelState = {};

/**
 * The token travels in a hidden field rather than an appointment id, so no
 * internal identifier is ever in the page for a customer to see or a browser
 * extension to read (TOKEN-03). The server resolves it again on submit — this
 * form carries no authority of its own.
 *
 * A-144 (C3): one tap used to cancel outright — the destructive action on
 * this whole app reachable with no confirmation, at a 36px target. `summary`
 * ("Cut on Tuesday 9 June at 10:00") is the day/time/service the page already
 * shows above the form, never a status word — TOKEN-03 forbids surfacing
 * `cancelled_late` here, and the confirm sentence says only what she already
 * knows she's giving up.
 */
export function CancelForm({ token, summary }: { token: string; summary: string }) {
  const [state, formAction, pending] = useActionState(cancelAppointment, initial);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button type="button" variant="destructive" onClick={() => setConfirming(true)}>
        Cancel this appointment
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <p className="text-sm font-medium">Cancel your {summary}?</p>
      <div className="flex gap-3">
        <Button type="submit" variant="destructive" pending={pending}>
          {pending ? 'Cancelling…' : 'Yes, cancel'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
          Keep it
        </Button>
      </div>
      <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
        {state.message ?? ''}
      </p>
    </form>
  );
}
