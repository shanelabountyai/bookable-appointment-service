import Link from 'next/link';
import { prisma } from '@bookable/db';
import { addDays, fromDate, toLabel, zoneId } from '@bookable/core/time';
import { requireStaff } from '@/lib/auth/session';
import { readableDay } from '@/lib/customer-format';
import { clientReliability } from '@bookable/db/clients';
import { flagSentence } from '@/components/client-flag';
import { listCallDown } from '@/lib/appointments/call-down-actions';
import { ConfirmButton } from './confirm-button';

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
        </p>
      </div>

      {unconfirmed.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">Everybody tomorrow has confirmed, or there is nobody booked.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {unconfirmed.map((appointment) => (
            <li
              key={appointment.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
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
              </div>
              <div className="flex items-center gap-3">
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
