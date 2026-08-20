import Link from 'next/link';
import { prisma } from '@bookable/db';
import { calendarDay, fromDate, toLabel, zoneId } from '@bookable/core/time';
import { requireStaff } from '@/lib/auth/session';
import { readableDay } from '@/lib/customer-format';
import { listConflicts } from '@/lib/availability/impact-actions';
import { ConflictList } from './conflict-list';

export const dynamic = 'force-dynamic';

/**
 * A-019 — WHO IS STRANDED, AND WHAT ARE WE DOING ABOUT IT (AVAIL-05).
 *
 * The screen the front desk opens the morning Dana calls in sick. Every row is
 * a client with a phone number, because the resolution to most of these is a
 * phone call — and the actions beside them are the four AVAIL-05 names:
 * keep-flagged, reassign, offer a new time, cancel.
 *
 * The conflicts are DERIVED on every load. Nothing on this page is a stored
 * "hasConflict" flag, which would go stale and lie on exactly the day this
 * page matters.
 */
export default async function ConflictsPage({ searchParams }: PageProps<'/staff/conflicts'>) {
  const staff = await requireStaff();
  const { day: dayParam } = await searchParams;

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  const today = toLabel(fromDate(new Date()), zoneId(business.timezone)).day;
  const day = safeDay(typeof dayParam === 'string' ? dayParam : undefined, today);

  const [conflicts, providers] = await Promise.all([
    listConflicts(day),
    prisma.provider.findMany({
      where: { businessId: staff.businessId, active: true },
      orderBy: [{ displayOrder: 'asc' }, { displayName: 'asc' }],
      select: { id: true, displayName: true },
    }),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href={`/staff/day?day=${day}`} className="text-sm text-zinc-500 hover:underline">
          ← {readableDay(day)}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Conflicts</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Appointments booked into time that is no longer available. Nothing here has been changed — every one is
          still in the book until somebody decides otherwise.
        </p>
      </div>

      {conflicts.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">Nothing stranded on {readableDay(day)}.</p>
      ) : (
        <ConflictList
          conflicts={conflicts}
          providers={providers.map((p) => ({ id: p.id, name: p.displayName }))}
        />
      )}
    </main>
  );
}

function safeDay(candidate: string | undefined, today: string): string {
  if (!candidate) return today;
  try {
    return calendarDay(candidate);
  } catch {
    return today;
  }
}
