import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listUnfinished } from '@bookable/db/appointments';
import { requireStaff } from '@/lib/auth/session';
import { readableDay, readableInstant } from '@/lib/customer-format';
import { CloseOutButtons } from './close-out-buttons';

export const dynamic = 'force-dynamic';

/**
 * A-076 / D-46 — WHAT IS STILL OPEN (APPT-01, APPT-03, RPT-01).
 *
 * Six o'clock Saturday. Twenty-nine appointments went through and eleven are
 * still sitting on `booked` or `checked_in`, because at the till you are taking
 * money, rebooking her for six weeks and answering the phone. Nothing anywhere
 * ever mentioned them again — and three readers are wrong as a result:
 * utilization is understated every week, A-073's lapsed round rings clients who
 * were in three weeks ago, and a no-show nobody tapped never fires CLIENT-04's
 * block.
 *
 * A DESK SCREEN, NOT A REPORT. The operator review was explicit: this is a
 * six-o'clock errand and an owner surface will not get done. So it is
 * `requireStaff`, it hangs off the day grid's toolbar with a count on it —
 * exactly as "Opened up (N)" does, and for the identical reason A-043 gave: a
 * door nobody knows to walk through is a door nobody walks through — and it is
 * grouped by the DAY it happened on, because "last Saturday" is how the desk
 * thinks about it rather than a run of instants.
 *
 * NOTHING IS DERIVED (D-46). No report changed and no job auto-completes
 * anything. The desk says which; the software never infers attendance from
 * silence, because the silence is identical whether she came and nobody tapped
 * or she never came and nobody tapped.
 */
export default async function UnfinishedPage() {
  const staff = await requireStaff();
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });

  const rows = await listUnfinished(prisma, { businessId: staff.businessId, now: new Date() });
  const days = [...new Map(rows.map((row) => [row.startDay, row.startDay])).keys()];
  const missing = rows.reduce((sum, row) => sum + row.valueCents, 0);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href="/staff/day" className="text-sm text-zinc-500 hover:underline">
          ← Today
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Still open</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          These have been and gone and nobody said what happened. Two taps each, and the week&apos;s numbers are
          right again.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          Nothing left open — every appointment that has been and gone has an answer against it.
        </p>
      ) : (
        <>
          {/* The size of it, in the units the owner staffs on. Not a scold: the
              number is why two taps each is worth doing tonight. */}
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {rows.length} {rows.length === 1 ? 'appointment' : 'appointments'} · {money(missing)} of work the
            week&apos;s figures cannot see.
          </p>

          {days.map((day) => (
            <section key={day} className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                {readableDay(day)}
              </h2>
              <ul className="flex flex-col gap-3">
                {rows
                  .filter((row) => row.startDay === day)
                  .map((row) => (
                    <li
                      key={row.id}
                      className="flex flex-col gap-2 rounded-md border border-zinc-300 p-4 text-sm dark:border-zinc-700"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-3">
                        <span>
                          <Link
                            href={`/staff/appointments/${row.id}`}
                            className="font-medium underline underline-offset-4"
                          >
                            {row.clientName ?? 'Walk-in, no name'}
                          </Link>{' '}
                          <span className="text-zinc-600 dark:text-zinc-400">
                            {readableInstant(row.startAt, business.timezone)} · {row.serviceNames.join(' + ')} ·{' '}
                            {row.providerName}
                          </span>
                        </span>
                        {/* Where it got to. `checked_in` means somebody SAW her
                            arrive, which is most of the answer already — and it
                            is the difference between a confident tap and a
                            guess. */}
                        <span className="text-zinc-600 dark:text-zinc-400">{WORDS[row.status] ?? row.status}</span>
                      </div>
                      <CloseOutButtons appointmentId={row.id} />
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </main>
  );
}

/** Staff wording, not D-10's customer lexicon — this is a staff surface. */
const WORDS: Record<string, string> = {
  booked: 'never checked in',
  confirmed: 'confirmed, never checked in',
  checked_in: 'checked in',
  in_progress: 'still marked in progress',
};

/** Integer cents, formatted once. */
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
