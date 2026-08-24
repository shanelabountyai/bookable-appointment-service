'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { type RetryState, retryMessage } from '@/lib/notifications/messages-actions';

const initial: RetryState = {};

/**
 * One message that did not go out.
 *
 * The REASON is rendered verbatim, code first, exactly as the provider gave
 * it — "invalid_recipient: the number is not in service" is what tells the
 * desk to go and fix the number, and a friendlier paraphrase would throw away
 * the one string that is actually actionable. The words around it are the
 * salon's; the words inside it are the provider's.
 */
export function MessageRow({
  id,
  title,
  who,
  recipient,
  channel,
  reason,
  attempts,
  when,
  appointmentId,
  retryable,
}: {
  id: string;
  title: string;
  who: string;
  recipient: string | null;
  channel: string;
  reason: string | null;
  attempts: number;
  when: string;
  appointmentId: string | null;
  retryable: boolean;
}) {
  const [state, action, pending] = useActionState(retryMessage, initial);

  // The row STAYS, holding its own confirmation. Re-reading the list here
  // would drop this row (it is no longer stuck) and take the sentence with it.
  if (state.ok) {
    return (
      <li className="flex flex-wrap items-baseline gap-x-3 rounded-md border border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700">
        <span className="font-medium">{title}</span>
        <span>{who}</span>
        <span aria-live="polite">{state.message}</span>
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-1 rounded-md border border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-medium">{title}</span>
        <span>{who}</span>
        <span className="text-zinc-600 dark:text-zinc-400">
          {recipient ?? 'no contact details'} · {channel}
        </span>
        {appointmentId ? (
          <Link href={`/staff/appointments/${appointmentId}`} className="underline underline-offset-4">
            The appointment
          </Link>
        ) : null}
      </div>
      {reason ? <p className="text-amber-800 dark:text-amber-300">{reason}</p> : null}
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-zinc-600 dark:text-zinc-400">
        <span>
          {attempts} {attempts === 1 ? 'try' : 'tries'}
        </span>
        <span>{when}</span>
        {retryable ? (
          <form action={action}>
            <input type="hidden" name="id" value={id} />
            <button
              type="submit"
              disabled={pending}
              className="rounded-md border border-zinc-400 px-2 py-1 font-medium disabled:opacity-60 dark:border-zinc-600"
            >
              {pending ? 'Queueing…' : 'Send it again'}
            </button>
          </form>
        ) : null}
        <span aria-live="polite">{state.message ?? ''}</span>
      </div>
    </li>
  );
}
