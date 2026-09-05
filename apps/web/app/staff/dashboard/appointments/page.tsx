import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listReportAppointments } from '@bookable/db/reports';
import type { AppointmentStatus } from '@bookable/core/scheduling';
import { requireOwner } from '@/lib/auth/session';
import { readableInstant } from '@/lib/customer-format';
import { STATUS_WORDS } from '@/lib/day/view-model';

export const dynamic = 'force-dynamic';

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * RPT-01's "every tile drills into the underlying filtered list" — one list,
 * every filter the dashboard's tiles can name (a week range, statuses, one
 * provider) expressed as plain URL params, so a filtered view is a link
 * anyone can bookmark or hand to someone else, same as A-016's day view.
 */
export default async function DashboardAppointmentsPage({ searchParams }: PageProps<'/staff/dashboard/appointments'>) {
  // A-050 (D-36). THE MONEY IS OWNER-ONLY. This screen is revenue,
  // utilization and every stylist's no-show count, and until this item any of
  // the four people who could sign in could read all three.
  const staff = await requireOwner();
  const params = await searchParams;

  const business = await prisma.business.findUniqueOrThrow({ where: { id: staff.businessId }, select: { timezone: true } });
  const fromDay = typeof params.from === 'string' ? params.from : '';
  const toDay = typeof params.to === 'string' ? params.to : '';
  const statuses = asList(params.status) as AppointmentStatus[];
  const providerId = typeof params.provider === 'string' ? params.provider : undefined;

  const rows = fromDay && toDay
    ? await listReportAppointments(prisma, {
        businessId: staff.businessId,
        fromDay,
        toDay,
        statuses: statuses.length ? statuses : undefined,
        providerId,
      })
    : [];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href={`/staff/dashboard?week=${fromDay}`} className="text-sm text-zinc-500 hover:underline">
          ← Dashboard
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {statuses.length ? statuses.map((s) => STATUS_WORDS[s]).join(', ') : 'All appointments'}
        </h1>
        {fromDay && toDay ? (
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{rows.length} appointment{rows.length === 1 ? '' : 's'}</p>
        ) : null}
      </div>

      {rows.length === 0 ? (
        /* NO RANGE IS NOT AN EMPTY RESULT — demo checkpoint 7. Reached bare
           (the nav has no link to it; a bookmark or a typed URL does), this
           said "0 appointments · Nothing matches this filter" on a full book,
           which reads as a salon with no appointments in it. `overruled` next
           door already words the same state correctly. */
        <p className="text-zinc-500">
          {fromDay && toDay ? 'Nothing matches this filter.' : 'Pick a week from the dashboard.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/staff/appointments/${row.id}`}
                className="flex flex-wrap items-baseline gap-x-3 rounded-md border border-zinc-300 px-4 py-3 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                <span className="font-medium">{readableInstant(row.startAt, business.timezone)}</span>
                <span>{row.providerName}</span>
                <span>{row.clientName ?? 'Walk-in, no name'}</span>
                <span className="text-zinc-600 dark:text-zinc-400">{row.serviceNames.join(' + ')}</span>
                <span className="ml-auto">{STATUS_WORDS[row.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
