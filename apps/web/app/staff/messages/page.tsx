import { prisma } from '@bookable/db';
import {
  countNotReallySent,
  lastReminderSweep,
  listMissedReminders,
  listStuckNotifications,
} from '@bookable/db/notifications';
import { requireStaff } from '@/lib/auth/session';
import { readableInstant } from '@/lib/customer-format';
import { TEMPLATE_WORDS } from '@/lib/appointments/event-language';
import { MessageRow } from './message-row';
import { MissedReminderRow } from './missed-reminder-row';

export const dynamic = 'force-dynamic';

/**
 * A-051 — WHAT DID NOT GO OUT. A-108 — AND THE TWO WAYS IT USED TO LIE.
 *
 * A retry policy nobody can see is the same silence with better manners. This
 * is the screen that makes it visible: everything given up on, everything
 * still working through its backoff, the provider's own reason against each
 * one, and a way to put a fixed one back in the queue.
 *
 * All of it on ONE screen deliberately — the desk's question is one question
 * ("is anybody not going to hear from us?"), and the difference between the
 * kinds is a sentence, not a route.
 *
 * A-108 / D-51 added the two states this screen could not see, and both of
 * them rendered as the healthy sentence "Everything has gone out":
 *
 *  - QUEUED AND NEVER TRIED. `listStuckNotifications` excluded a `pending`
 *    row with no attempts as "new rather than stuck", which is true only while
 *    the dispatcher is running. 713 rows sat in that state on two independent
 *    databases with the badge beside them reading 0.
 *  - NEVER REMINDED AT ALL. The reminder sweep is a five-minute band with no
 *    catch-up, so a deploy or a rotated `CRON_SECRET` lost everybody inside it
 *    and left no outbox row to find — nothing was stuck, because nothing was
 *    ever written. That cohort is DERIVED from the appointments (D-51), which
 *    is why it is a list of people and phone numbers rather than a time range.
 *
 * A-118 — AND THE THIRD, WHICH WAS THE LOUDEST. A row the console adapter
 * handled is `sent`: not failed, not waiting, not missing, so all three lists
 * were correctly empty and this screen printed "Everything has gone out" over
 * 686 messages nobody received. `/staff/appointments/{id}` has rendered those
 * same rows as "queued" since A-044/A-048, so the product contradicted itself
 * on every install that exists (`notificationAdapter` is the logging adapter
 * in all of them — D-14, A-053 blocked). The healthy sentence now goes through
 * `reallyDelivered`, which is the predicate the appointment page already uses.
 */
export default async function MessagesPage() {
  const staff = await requireStaff();
  const now = new Date();

  const [business, stuck, missed, sweptAt, notReallySent] = await Promise.all([
    prisma.business.findUniqueOrThrow({ where: { id: staff.businessId }, select: { timezone: true } }),
    listStuckNotifications(prisma, staff.businessId, { now }),
    listMissedReminders(prisma, { businessId: staff.businessId, now }),
    lastReminderSweep(prisma, staff.businessId),
    // A-118: the same question `deliveryWord` asks on the appointment page,
    // through the same predicate. This screen used to ask nothing at all.
    countNotReallySent(prisma, staff.businessId),
  ]);

  // The bucket is decided in `stuck.ts` and carried on the row. This page
  // deliberately does not re-derive it from `status` and `attempts`: two
  // readers of one fact under different names is the defect the repo has
  // caught four times, and A-108 is the fourth.
  const givenUp = stuck.filter((row) => row.kind === 'given-up');
  const neverTried = stuck.filter((row) => row.kind === 'never-tried');
  const waiting = stuck.filter((row) => row.kind === 'retrying');

  // A-118 — "EVERYTHING HAS GONE OUT" NOW HAS TO BE TRUE OF THE ROWS THAT SAY
  // `sent`, TOO. A row the console adapter handled is not stuck, not failed
  // and not missing — it is invisible to all three lists, and this sentence
  // was printed over 686 of them while every appointment page correctly said
  // "queued" about the same rows. The predicate is `reallyDelivered`'s, asked
  // once in `countNotReallySent`, never re-spelled here.
  const allClear = stuck.length === 0 && missed.length === 0 && notReallySent === 0;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Messages that did not go out</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Confirmations and reminders are tried again on their own for a couple of hours. What is listed here
          either ran out of tries, was refused outright — a dead phone number, an address that does not exist —
          was never picked up at all, or never went anywhere real.
        </p>
      </div>

      {allClear ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          Everything has gone out. Nothing is waiting and nothing has been given up on.
        </p>
      ) : null}

      {/* A-118. Rendered whether or not anything else is listed: a desk told
          only about the three that failed would read the other six hundred as
          delivered. The count is in the heading so the sentence needs no
          plural agreement — and no clause that is cut on every real book. */}
      {notReallySent > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
            Nothing has actually been sent ({notReallySent})
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            These are marked sent, but they were written to the server log rather than handed to a phone or an
            inbox — which is what every appointment page means when it says “queued” about them. Nobody has
            been told anything, and there is nothing here to retry: this install has no text or email service
            connected.
          </p>
        </section>
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

      {/* A-108. Not "still trying" and not "given up" — nothing has tried at
          all, which almost always means the job itself is not running. The
          heading says the diagnosis, because a desk cannot act on a row here
          the way it acts on a wrong phone number. */}
      {neverTried.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
            Queued and never tried ({neverTried.length})
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            These have been waiting over an hour and nothing has picked them up. The sending job may not be
            running.
          </p>
          <ul className="flex flex-col gap-2">
            {neverTried.map((row) => (
              <MessageRow
                key={row.id}
                id={row.id}
                title={TEMPLATE_WORDS[row.template] ?? row.template}
                who={row.clientName ?? 'no name'}
                recipient={row.recipient}
                channel={row.channel}
                reason={row.lastError}
                attempts={row.attempts}
                when={`queued ${readableInstant(row.createdAt, business.timezone)}`}
                appointmentId={row.appointmentId}
                retryable={false}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {/* A-108 / D-51. Derived from the appointments, not from the outbox:
          these people have no message at all, so there is nothing to retry and
          nothing to read a provider error off. The phone number IS the
          action. */}
      {missed.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
            Due in the next day and never reminded ({missed.length})
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No reminder was ever queued for these. They were booked far enough ahead to have had one, so the
            reminder job missed them — ring them if it matters.
          </p>
          <ul className="flex flex-col gap-2">
            {missed.map((row) => (
              <MissedReminderRow
                key={row.appointmentId}
                appointmentId={row.appointmentId}
                who={row.clientName ?? 'no name'}
                phone={row.phone}
                email={row.email}
                when={readableInstant(row.startAt, business.timezone)}
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

      {/* The watermark (D-51). Always rendered, including when everything is
          clear: "nothing was due" and "the job has not run since Tuesday" look
          identical on an empty screen, and telling those two apart is the
          whole reason the column exists. */}
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        {sweptAt
          ? `The reminder job last ran ${readableInstant(sweptAt, business.timezone)}.`
          : 'The reminder job has never run.'}
      </p>
    </main>
  );
}
