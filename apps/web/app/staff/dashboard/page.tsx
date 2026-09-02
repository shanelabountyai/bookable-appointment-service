import Link from 'next/link';
import { prisma } from '@bookable/db';
import { dashboardSummary } from '@bookable/db/reports';
import { addDays, calendarDay, fromDate, toLabel, zoneId } from '@bookable/core/time';
import { requireOwner } from '@/lib/auth/session';
import { readableDay } from '@/lib/customer-format';

export const dynamic = 'force-dynamic';

const tileClass = 'flex flex-col gap-1 rounded-md border border-zinc-300 p-4 dark:border-zinc-700';
const numberClass = 'text-3xl font-semibold tracking-tight';
const percent = (fraction: number | null) => (fraction === null ? 'n/a' : `${(fraction * 100).toFixed(1)}%`);

/**
 * A-024 — THE OWNER DASHBOARD (RPT-01, RPT-02, RPT-03).
 *
 * One week at a time, named in the URL — back-button-able and linkable to
 * whoever asks "what did last week look like", same reasoning as A-016's day
 * grid being a route rather than a client-side date picker.
 *
 * Every number here is DERIVED on every render (operator R-7's reflex, again):
 * nothing is a stored count that could go stale relative to the appointments
 * it is supposed to describe.
 */
export default async function DashboardPage({ searchParams }: PageProps<'/staff/dashboard'>) {
  // A-050 (D-36). THE MONEY IS OWNER-ONLY. This screen is revenue,
  // utilization and every stylist's no-show count, and until this item any of
  // the four people who could sign in could read all three.
  const staff = await requireOwner();
  const params = await searchParams;

  const business = await prisma.business.findUniqueOrThrow({ where: { id: staff.businessId }, select: { timezone: true } });
  const zone = zoneId(business.timezone);
  const today = toLabel(fromDate(new Date()), zone).day;
  const anyDayInWeek = typeof params.week === 'string' ? params.week : today;

  const summary = await dashboardSummary(prisma, { businessId: staff.businessId, anyDayInWeek });
  const range = { from: summary.fromDay, to: summary.toDay };

  const drill = (extra: Record<string, string | string[]>) => {
    const usp = new URLSearchParams({ from: range.from, to: range.to });
    for (const [key, value] of Object.entries(extra)) {
      for (const v of Array.isArray(value) ? value : [value]) usp.append(key, v);
    }
    return `/staff/dashboard/appointments?${usp.toString()}`;
  };

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href="/staff" className="text-sm text-zinc-500 hover:underline">
          ← Staff
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Dashboard</h1>
        <div className="mt-1 flex items-center gap-3 text-sm text-zinc-600 dark:text-zinc-400">
          <Link href={`/staff/dashboard?week=${addDays(calendarDay(summary.fromDay), -7)}`} className="underline underline-offset-4">
            ← Previous week
          </Link>
          <span>
            {readableDay(summary.fromDay)} – {readableDay(summary.toDay)}
          </span>
          <Link href={`/staff/dashboard?week=${addDays(calendarDay(summary.fromDay), 7)}`} className="underline underline-offset-4">
            Next week →
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Link href={drill({})} className={tileClass}>
          <span className="text-sm text-zinc-500">Bookings</span>
          <span className={numberClass}>{summary.bookings}</span>
        </Link>

        <Link href={drill({ status: ['cancelled', 'cancelled_late'] })} className={tileClass}>
          <span className="text-sm text-zinc-500">Cancellations</span>
          <span className={numberClass}>{summary.cancels.normal + summary.cancels.late}</span>
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            {summary.cancels.normal} on time · {summary.cancels.late} late
          </span>
        </Link>

        <div className={tileClass}>
          <span className="text-sm text-zinc-500">No-shows by provider</span>
          {summary.noShowsByProvider.length === 0 ? (
            <span className="text-sm text-zinc-600 dark:text-zinc-400">None this week.</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {summary.noShowsByProvider.map((p) => (
                <li key={p.providerId}>
                  <Link href={drill({ status: 'no_show', provider: p.providerId })} className="text-sm underline underline-offset-4">
                    {p.providerName}: {p.count}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={tileClass}>
          <span className="text-sm text-zinc-500">Utilization</span>
          <ul className="flex flex-col gap-1">
            {summary.utilizationByProvider.map((p) => (
              <li key={p.providerId}>
                <Link href={drill({ status: ['completed', 'no_show'], provider: p.providerId })} className="text-sm underline underline-offset-4">
                  {p.providerName}: {percent(p.utilization)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* A-060. The two numbers on the Cancellations tile are only trustworthy
          because the machine picks between them from the cutoff and the clock.
          This is the size of the exception — the part a human can quietly grow
          until the split means nothing again — so it is a line the owner reads
          without going looking for it, and it disappears in a week with none.
          A tile cannot hold it: the tile is itself a link. */}
      {summary.cancels.overruled > 0 ? (
        <Link
          href={`/staff/dashboard/overruled?from=${range.from}&to=${range.to}`}
          className="text-sm underline underline-offset-4"
        >
          {summary.cancels.overruled} cancellation{summary.cancels.overruled === 1 ? '' : 's'} let off the
          late count — who, and why →
        </Link>
      ) : null}

      {/* A-073. NOT conditional on a count, unlike the line above: the whole
          finding is that the owner has no way to know this list exists, and a
          link that only appears once somebody has already lapsed is a door
          that opens after the horse has gone. It is also the only surface in
          the product that answers "who have we lost?", so it is worth a
          permanent line. */}
      <Link href="/staff/dashboard/lapsed" className="text-sm underline underline-offset-4">
        Clients who have stopped coming — who to ring to fill a quiet Tuesday →
      </Link>
    </main>
  );
}
