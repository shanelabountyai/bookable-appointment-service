import Link from 'next/link';
import { prisma } from '@bookable/db';
import { addDays, fromDate, toLabel, zoneId } from '@bookable/core/time';
import { requireStaff } from '@/lib/auth/session';
import { readableDay } from '@/lib/customer-format';
import { clientReliability } from '@bookable/db/clients';
import { flagSentence } from '@/components/client-flag';
import { listCallDown } from '@/lib/appointments/call-down-actions';
import { ConfirmButton } from './confirm-button';
import { ATTEMPT_WORDS } from '@/lib/appointments/attempt-words';
import { recordAttempt } from '@/lib/appointments/call-down-actions';
import { CallMarkButtons } from '@/components/call-mark-buttons';

export const dynamic = 'force-dynamic';

/**
 * A-021 — THE CALL-DOWN LIST (APPT-02).
 *
 * "No reply never auto-cancels" means somebody has to go and ask, and this is
 * where the desk finds who: everybody booked tomorrow who has not confirmed,
 * one row per client, phone number on the row for the same reason AVAIL-05's
 * conflicts list puts it there — the resolution is a call, not a click.
 *
 * `tomorrow` is always the SALON's tomorrow, computed from the business's
 * timezone the same way every other staff screen does — never the browser's.
 *
 * A-061 puts "we already rang her" on the row. The list STAYS IN TIME ORDER
 * (D-37(b), settled by A-051 and not reopened here): a tried row greys, it
 * does not sink. Sinking would silently reorder the list the desk is working
 * down with the diary open beside it, which is the surprise A-051 rejected —
 * and it would move rows under the cursor of the person pressing the buttons.
 */
export default async function CallDownPage() {
  const staff = await requireStaff();
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  const zone = zoneId(business.timezone);
  const today = toLabel(fromDate(new Date()), zone).day;
  const tomorrow = addDays(today, 1);

  const unconfirmed = await listCallDown(tomorrow);

  // A-051 settles OQ-5 (D-37): the list stays in TIME order and carries the
  // triage information instead of being reordered by it. One query for the
  // whole page — `clientReliability` takes the ids together, the same way the
  // booking panel's client search asks it.
  const flags = await clientReliability(prisma, {
    businessId: staff.businessId,
    clientIds: unconfirmed.map((appointment) => appointment.clientId).filter((id): id is string => id !== null),
    today,
  });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href="/staff/day" className="text-sm text-zinc-500 hover:underline">
          ← Today
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Call-down: {readableDay(tomorrow)}</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Booked but not yet confirmed. Nothing here has been touched — a no-show tomorrow is still nobody&apos;s default.
          Marking a call sends nothing; it records that a person picked up the phone.
        </p>
        {/* Of who is LEFT, not of who is done. The desk's question at 4pm is
            how many more calls, and a number that climbed as the work got done
            would answer a question nobody asked. */}
        {unconfirmed.length > 0 ? (
          <p className="mt-1 text-sm font-medium">
            Still to ring: {unconfirmed.filter((a) => a.attempt === null).length} of {unconfirmed.length}
          </p>
        ) : null}
      </div>

      {unconfirmed.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">Everybody tomorrow has confirmed, or there is nobody booked.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {unconfirmed.map((appointment) => (
            <li
              key={appointment.id}
              className={[
                'flex flex-wrap items-center justify-between gap-3 rounded-md border p-4',
                // Greyed, never removed and never moved: she is still
                // unconfirmed, and a row that vanished on "no answer" would
                // lose the client the desk most needs to try again.
                appointment.attempt
                  ? 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500'
                  : 'border-zinc-300 dark:border-zinc-700',
              ].join(' ')}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="font-medium">
                  {toLabel(fromDate(appointment.startAt), zone).time} ·{' '}
                  {appointment.clientName ?? 'Walk-in, no name'}
                </span>
                <span className="text-zinc-600 dark:text-zinc-400">
                  {appointment.serviceNames.join(' + ')} · {appointment.providerName}
                </span>
                {appointment.clientPhone ? (
                  <a href={`tel:${appointment.clientPhone}`} className="underline underline-offset-4">
                    {appointment.clientPhone}
                  </a>
                ) : null}
                {/* What tomorrow loses if she does not turn up. On the row
                    rather than in the sort, so the desk chooses. */}
                <span className="text-zinc-600 dark:text-zinc-400">
                  ${(appointment.valueCents / 100).toFixed(2)}
                </span>
                {appointment.clientId && flagSentence(flags.get(appointment.clientId)!) ? (
                  <span className="text-amber-800 dark:text-amber-300">
                    ⚑ {flagSentence(flags.get(appointment.clientId)!)}
                  </span>
                ) : null}
                {/* WHO rang and WHEN, not just that somebody did — at 4pm the
                    useful question is whether the call was an hour ago or this
                    morning, and "the front desk" is four people (D-9). */}
                {appointment.attempt ? (
                  <span className="w-full font-medium">
                    {ATTEMPT_WORDS[appointment.attempt.outcome]}
                    {appointment.attempt.triedByName ? ` — ${appointment.attempt.triedByName}` : ''}, at{' '}
                    {toLabel(fromDate(appointment.attempt.triedAt), zone).time}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {/* A-091 — the two-outcome sibling of the waitlist's four, and now
                    literally the same component (§5.4.9). */}
                <CallMarkButtons
                  words={ATTEMPT_WORDS}
                  current={appointment.attempt?.outcome}
                  hidden={{ appointmentId: appointment.id }}
                  action={recordAttempt}
                  undoLabel="Not rung"
                />
                <ConfirmButton appointmentId={appointment.id} />
                <Link
                  href={`/staff/appointments/${appointment.id}`}
                  className="text-xs text-zinc-500 underline underline-offset-4"
                >
                  Details
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
