'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { type ConfirmState, confirmAppointment } from '@/lib/manage/actions';

const initial: ConfirmState = {};

/** Same shape as `CancelForm` (TOKEN-03): the token travels in a hidden
 *  field, never an appointment id. */
export function ConfirmForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(confirmAppointment, initial);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <Button type="submit" variant="primary" pending={pending} className="self-start">
        {pending ? 'Confirming…' : "I'll be there"}
      </Button>
      <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
        {state.message ?? ''}
      </p>
    </form>
  );
}
