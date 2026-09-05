import { prisma } from '@bookable/db';
import { listStuckNotifications } from '@bookable/db/notifications';
import { requireStaff } from '@/lib/auth/session';
import { readableInstant } from '@/lib/customer-format';
import { TEMPLATE_WORDS } from '@/lib/appointments/event-language';
import { MessageRow } from './message-row';

export const dynamic = 'force-dynamic';

/**
 * A-051 — WHAT DID NOT GO OUT.
 *
 * A retry policy nobody can see is the same silence with better manners. This
 * is the screen that makes it visible: everything given up on, everything
 * still working through its backoff, the provider's own reason against each
 * one, and a way to put a fixed one back in the queue.
 *
 * Both kinds on ONE screen deliberately — the desk's question is one question
 * ("is anybody not going to hear from us?"), and the difference between them
 * is a sentence, not a route.
 */
export default async function MessagesPage() {
  const staff = await requireStaff();

  const [business, stuck] = await Promise.all([
    prisma.business.findUniqueOrThrow({ where: { id: staff.businessId }, select: { timezone: true } }),
    listStuckNotifications(prisma, staff.businessId),
  ]);

  const givenUp = stuck.filter((row) => row.status === 'failed');
  const waiting = stuck.filter((row) => row.status !== 'failed');

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Messages that did not go out</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Confirmations and reminders are tried again on their own for a couple of hours. What is listed here
          either ran out of tries or was refused outright — a dead phone number, an address that does not exist.
        </p>
      </div>

      {stuck.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          Everything has gone out. Nothing is waiting and nothing has been given up on.
        </p>
      ) : null}

      {givenUp.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            Nobody was told ({givenUp.length})
          </h2>
          <ul className="flex flex-col gap-2">
            {givenUp.map((row) => (
              <MessageRow
                key={row.id}
                id={row.id}
                title={TEMPLATE_WORDS[row.template] ?? row.template}
                who={row.clientName ?? 'no name'}
                recipient={row.recipient}
                channel={row.channel}
                reason={row.lastError}
                attempts={row.attempts}
                when={readableInstant(row.createdAt, business.timezone)}
                appointmentId={row.appointmentId}
                retryable
              />
            ))}
          </ul>
        </section>
      ) : null}

      {waiting.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            Still trying ({waiting.length})
          </h2>
          {/* Shown, and shown as REASSURING. Without this a message mid-backoff
              is invisible, and the desk phones a client the system was about to
              reach anyway. */}
          <ul className="flex flex-col gap-2">
            {waiting.map((row) => (
              <MessageRow
                key={row.id}
                id={row.id}
                title={TEMPLATE_WORDS[row.template] ?? row.template}
                who={row.clientName ?? 'no name'}
                recipient={row.recipient}
                channel={row.channel}
                reason={row.lastError}
                attempts={row.attempts}
                when={
                  row.nextAttemptAt
                    ? `next try ${readableInstant(row.nextAttemptAt, business.timezone)}`
                    : 'next try on the next run'
                }
                appointmentId={row.appointmentId}
                retryable={false}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
