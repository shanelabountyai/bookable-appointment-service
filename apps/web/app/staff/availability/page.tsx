import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listDateOverrides, listWeeklyWindows } from '@bookable/db/availability';
import { listProviders } from '@bookable/db/settings';
import { requireStaff } from '@/lib/auth/session';
import { Absences, DateOverrides, WeeklyHours } from './availability-client';

/**
 * One provider's availability, or the business-level pattern when no provider
 * is selected (AVAIL-04 — business hours are a pattern in the same shape).
 */
export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const staff = await requireStaff();
  const { provider: selected } = await searchParams;
  const providers = await listProviders(prisma, staff.businessId, false);

  // '' is the BUSINESS-level pattern, and is the default view: business hours
  // gate everyone, so they are the first thing to get right.
  const providerId = selected ?? '';
  const dbProviderId = providerId === '' ? null : providerId;

  const [windows, overrides, timeOff, blocks] = await Promise.all([
    listWeeklyWindows(prisma, staff.businessId, dbProviderId),
    listDateOverrides(prisma, staff.businessId, dbProviderId),
    dbProviderId
      ? prisma.timeOff.findMany({ where: { providerId: dbProviderId }, orderBy: { startAt: 'asc' } })
      : Promise.resolve([]),
    dbProviderId
      ? prisma.adHocBlock.findMany({ where: { providerId: dbProviderId }, orderBy: { startAt: 'asc' } })
      : Promise.resolve([]),
  ]);

  const absences = [
    ...timeOff.map((t) => ({
      id: t.id,
      startAt: t.startAt.toISOString(),
      endAt: t.endAt.toISOString(),
      reason: t.reason,
      kind: 'time_off' as const,
    })),
    ...blocks.map((b) => ({
      id: b.id,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
      reason: b.reason,
      kind: 'ad_hoc_block' as const,
    })),
  ].sort((a, b) => a.startAt.localeCompare(b.startAt));

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 p-8">
      <div>
        <Link href="/staff" className="text-sm text-zinc-500 hover:underline">
          ← Staff
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Availability</h1>
      </div>

      <nav aria-label="Whose availability" className="flex flex-wrap gap-2">
        <Link
          href="/staff/availability"
          aria-current={providerId === '' ? 'page' : undefined}
          className={`rounded-md border px-3 py-1.5 text-sm ${
            providerId === ''
              ? 'border-zinc-900 font-medium dark:border-zinc-100'
              : 'border-zinc-300 dark:border-zinc-700'
          }`}
        >
          The business
        </Link>
        {providers.map((p) => (
          <Link
            key={p.id}
            href={`/staff/availability?provider=${p.id}`}
            aria-current={providerId === p.id ? 'page' : undefined}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              providerId === p.id
                ? 'border-zinc-900 font-medium dark:border-zinc-100'
                : 'border-zinc-300 dark:border-zinc-700'
            }`}
          >
            {p.displayName}
          </Link>
        ))}
      </nav>

      {providerId === '' && (
        <p className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          Business hours gate every provider: a day the salon is closed is closed for everyone, whatever their own hours
          say.
        </p>
      )}

      <WeeklyHours
        providerId={providerId}
        windows={windows.map((w) => ({
          id: w.id,
          weekday: w.weekday,
          open: w.open,
          close: w.close,
          endsNextDay: w.endsNextDay,
          breaks: w.breaks.map((b) => ({ open: b.open, close: b.close })),
        }))}
      />

      <DateOverrides
        providerId={providerId}
        overrides={overrides.map((o) => ({
          id: o.id,
          day: o.day,
          isClosed: o.isClosed,
          reason: o.reason,
          windows: o.windows.map((w) => ({ open: w.open, close: w.close })),
        }))}
      />

      {providerId !== '' && <Absences providerId={providerId} absences={absences} />}
    </main>
  );
}
