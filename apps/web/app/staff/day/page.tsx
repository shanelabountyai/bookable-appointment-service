import Link from 'next/link';
import { prisma } from '@bookable/db';
import { loadDayView } from '@bookable/db/day';
import { addDays, calendarDay, fromDate, toLabel, zoneId } from '@bookable/core/time';
import { requireStaff } from '@/lib/auth/session';
import { readableDay } from '@/lib/customer-format';
import { toGridModel } from '@/lib/day/view-model';
import { DayGrid } from './day-grid';
import { ProviderDay } from './provider-day';

export const dynamic = 'force-dynamic';

/**
 * THE ONE SCREEN (Goal 3): every provider's day, side by side.
 *
 * The day is always the BUSINESS's calendar day — "today" here is the salon's
 * today, never the browser's. A front desk on a laptop still set to the last
 * holiday's timezone must see the same grid as the one beside it.
 *
 * `?provider=` switches to the single-column list a stylist reads on her own
 * phone between clients: the same data, without the horizontal scrolling that
 * a four-column grid forces on a small screen.
 */
export default async function DayPage({ searchParams }: PageProps<'/staff/day'>) {
  const staff = await requireStaff();
  const { day: dayParam, provider: providerParam } = await searchParams;

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  const now = new Date();
  const today = toLabel(fromDate(now), zoneId(business.timezone)).day;
  const day = safeDay(typeof dayParam === 'string' ? dayParam : undefined, today);

  const view = await loadDayView(prisma, { businessId: staff.businessId, day, now });
  const model = toGridModel(view, now, readableDay(day));
  const providerId = typeof providerParam === 'string' ? providerParam : null;
  const column = providerId ? model.columns.find((c) => c.providerId === providerId) : null;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link href="/staff" className="text-sm text-zinc-500 hover:underline">
            ← Staff
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{model.dayLabel}</h1>
          {day === today ? null : <p className="text-sm text-zinc-500">Not today.</p>}
        </div>

        <nav aria-label="Day" className="flex items-center gap-3 text-sm">
          <Link href={link(addDays(calendarDay(day), -1), providerId)} className="underline underline-offset-4">
            ← Previous
          </Link>
          <Link href={link(today, providerId)} className="underline underline-offset-4">
            Today
          </Link>
          <Link href={link(addDays(calendarDay(day), 1), providerId)} className="underline underline-offset-4">
            Next →
          </Link>
        </nav>
      </div>

      <div className="flex flex-wrap gap-2">
        {/* BOOK-04's walk-in: the client is standing at the desk, so the
            entry point is one tap from the day and asks the engine who can
            take her rather than making the front desk scan four columns. */}
        <Link
          href={`/staff/book?walkin=1&day=${day}`}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Walk-in
        </Link>
        {/* AVAIL-05. One tap from the day, because the morning somebody calls
            in sick is the morning this has to be findable. */}
        <Link href={`/staff/conflicts?day=${day}`} className="rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium dark:border-zinc-600">
          Conflicts
        </Link>
      </div>

      <nav aria-label="View" className="flex flex-wrap gap-2 text-sm">
        <Link
          href={link(day, null)}
          aria-current={providerId ? undefined : 'page'}
          className={`rounded-md border px-3 py-1.5 ${providerId ? 'border-zinc-300 dark:border-zinc-700' : 'border-zinc-900 font-medium dark:border-zinc-100'}`}
        >
          Everyone
        </Link>
        {model.columns.map((c) => (
          <Link
            key={c.providerId}
            href={link(day, c.providerId)}
            aria-current={providerId === c.providerId ? 'page' : undefined}
            className={`rounded-md border px-3 py-1.5 ${providerId === c.providerId ? 'border-zinc-900 font-medium dark:border-zinc-100' : 'border-zinc-300 dark:border-zinc-700'}`}
          >
            {c.providerName}
          </Link>
        ))}
      </nav>

      {model.columns.length === 0 ? (
        <p className="text-zinc-500">No providers yet. Add one in Providers.</p>
      ) : column ? (
        <ProviderDay column={column} />
      ) : (
        <DayGrid model={model} />
      )}
    </main>
  );
}

function link(day: string, providerId: string | null): string {
  const params = new URLSearchParams({ day });
  if (providerId) params.set('provider', providerId);
  return `/staff/day?${params}`;
}

/** A hand-edited `?day=` is ordinary input, not an error worth a 500. */
function safeDay(candidate: string | undefined, today: string): string {
  if (!candidate) return today;
  try {
    return calendarDay(candidate);
  } catch {
    return today;
  }
}
