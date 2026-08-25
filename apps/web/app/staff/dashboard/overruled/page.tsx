import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listOverruledCancellations } from '@bookable/db/reports';
import { requireOwner } from '@/lib/auth/session';
import { readableDay, readableInstant } from '@/lib/customer-format';

export const dynamic = 'force-dynamic';

/**
 * A-060 — "HOW MANY DID WE OVERRULE, AND WHO?"
 *
 * The escape hatch beside the one Cancel button is the honest half of this
 * item: a real salon lets people off, and a system that refuses to model it
 * gets the desk classifying by hand again within a fortnight. What makes the
 * escape safe rather than a hole is that it leaves a row with a name on it.
 *
 * Owner-only, like every other dashboard surface (D-36/A-050): this is a list
 * of judgement calls colleagues made, and the three people at the terminal
 * reading each other's is a different product from the one D-36 chose.
 *
 * NOT a place to undo anything. A cancellation has no outgoing edges (§7) and
 * an event log is append-only by trigger — the answer to "that one was wrong"
 * is a conversation, not a button that rewrites what happened.
 */
export default async function OverruledPage({ searchParams }: PageProps<'/staff/dashboard/overruled'>) {
  const staff = await requireOwner();
  const params = await searchParams;

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  const fromDay = typeof params.from === 'string' ? params.from : '';
  const toDay = typeof params.to === 'string' ? params.to : '';

  const rows =
    fromDay && toDay
      ? await listOverruledCancellations(prisma, { businessId: staff.businessId, fromDay, toDay })
      : [];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href={`/staff/dashboard?week=${fromDay}`} className="text-sm text-zinc-500 hover:underline">
          ← Dashboard
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Let off the late count</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {fromDay && toDay
            ? `Cancellations inside the cutoff that somebody decided not to count as late — ${readableDay(fromDay)} to ${readableDay(toDay)}.`
            : 'Pick a week from the dashboard.'}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          None that week — every cancellation was classified by the cutoff.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.eventId} className="flex flex-col gap-1 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
              <Link href={`/staff/appointments/${row.appointmentId}`} className="font-medium underline underline-offset-4">
                {row.clientName ?? 'Walk-in, no name'}
              </Link>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                {readableInstant(row.startAt, business.timezone)} · {row.providerName}
              </span>
              <span className="text-sm">
                Let off by {row.staffName ?? 'the front desk'} on {readableInstant(row.at, business.timezone)}
              </span>
              {/* The reason IS the record. Rendered in full and never
                  truncated: it is the only thing standing between "we let one
                  off" and "the cutoff quietly stopped applying". */}
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                {row.reason ?? 'No reason recorded.'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
