import Link from 'next/link';
import { prisma } from '@bookable/db';
import { calendarDay, fromDate, instantFromIso, toDate, toLabel, zoneId } from '@bookable/core/time';
import { requireStaff } from '@/lib/auth/session';
import { readableDay } from '@/lib/customer-format';
import { BookingPanel } from './booking-panel';

export const dynamic = 'force-dynamic';

/**
 * A-017 — booking from the desk (BOOK-04, BOOK-05).
 *
 * Reached two ways, sharing everything after the first choice:
 *  - from a GAP in the day grid, which arrives with a provider and an instant;
 *  - from "walk-in now", which arrives with neither and asks the engine who
 *    could take her (`?walkin=1`).
 *
 * A page rather than a dialog. The front desk types faster than it mouses
 * (A-016's rule), and a real route is back-button-able, linkable to the person
 * on the next terminal, and keyboard-operable without a focus trap to get
 * wrong.
 */
export default async function StaffBookPage({ searchParams }: PageProps<'/staff/book'>) {
  const staff = await requireStaff();
  const params = await searchParams;

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  const zone = zoneId(business.timezone);
  const today = toLabel(fromDate(new Date()), zone).day;

  const walkIn = params.walkin === '1';
  const providerId = typeof params.provider === 'string' ? params.provider : null;
  const atIso = typeof params.at === 'string' ? params.at : null;
  const day = safeDay(typeof params.day === 'string' ? params.day : undefined, today);

  const [provider, services] = await Promise.all([
    providerId
      ? prisma.provider.findFirst({
          where: { id: providerId, businessId: staff.businessId, active: true },
          select: { id: true, displayName: true },
        })
      : null,
    // Only what this provider can actually do, when one is known — offering a
    // service she is not qualified for produces a refusal the engine has to
    // explain later, which is a worse conversation than a shorter list.
    //
    // The qualification filter is written INLINE rather than spread in from a
    // conditional: `...(x ? {...} : {})` widens the object and TypeScript stops
    // checking the keys inside it, which is exactly how a misnamed relation
    // reached the browser as a 500 instead of a compile error.
    prisma.service.findMany({
      where: providerId
        ? { businessId: staff.businessId, active: true, serviceProviders: { some: { providerId } } }
        : { businessId: staff.businessId, active: true },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, durationMinutes: true, priceCents: true },
    }),
  ]);

  const slotLabel = atIso ? labelFor(atIso, zone) : null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href={`/staff/day?day=${day}`} className="text-sm text-zinc-500 hover:underline">
          ← {readableDay(day)}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {walkIn ? 'Walk-in' : `Book ${provider ? `with ${provider.displayName}` : ''}`}
        </h1>
        {slotLabel ? <p className="mt-1 text-zinc-600 dark:text-zinc-400">{slotLabel}</p> : null}
      </div>

      {!walkIn && !provider ? (
        <p className="text-zinc-500">
          That stylist is not on today. <Link href={`/staff/day?day=${day}`} className="underline">Back to the day</Link>.
        </p>
      ) : services.length === 0 ? (
        <p className="text-zinc-500">No services are set up for this stylist yet.</p>
      ) : (
        <BookingPanel
          day={day}
          services={services}
          provider={provider}
          at={atIso}
          walkIn={walkIn}
        />
      )}
    </main>
  );
}

/** "Tuesday 9 June at 14:15", in the SALON's zone. Server-side, always. */
function labelFor(atIso: string, zone: ReturnType<typeof zoneId>): string | null {
  try {
    const label = toLabel(fromDate(toDate(instantFromIso(atIso))), zone);
    return `${readableDay(label.day)} at ${label.time}`;
  } catch {
    return null;
  }
}

function safeDay(candidate: string | undefined, today: string): string {
  if (!candidate) return today;
  try {
    return calendarDay(candidate);
  } catch {
    return today;
  }
}
