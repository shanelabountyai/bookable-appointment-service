import Link from 'next/link';
import { prisma } from '@bookable/db';
import { clientReliability, findClient } from '@bookable/db/clients';
import { calendarDay, fromDate, instantFromIso, toDate, toLabel, zoneId } from '@bookable/core/time';
import { requireStaff } from '@/lib/auth/session';
import { readableDay } from '@/lib/customer-format';
import { flagSentence } from '@/components/client-flag';
import { staffSlotsFor } from '@/lib/booking/staff-actions';
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

  // A-040: a rebook arrives with EVERY service the last visit had, in order,
  // and with the client already resolved. A single value arrives as a string
  // and several as an array — `getAll` semantics, normalised once.
  const requestedServiceIds =
    typeof params.services === 'string' ? [params.services] : Array.isArray(params.services) ? params.services : [];
  const requestedClientId = typeof params.client === 'string' ? params.client : null;

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

  // Only the ones this provider is still qualified for and that are still
  // active — the same defensiveness the public flow's prefill has, because a
  // service retired last month or a qualification withdrawn is ordinary.
  // Order is the REQUEST'S, not the catalogue's (VISIT-01).
  const prefillServiceIds = requestedServiceIds.filter((id) => services.some((s) => s.id === id));
  // Silence is what this row exists to fix, so a dropped line is SAID rather
  // than quietly leaving a shorter visit selected.
  const droppedServices = requestedServiceIds.length - prefillServiceIds.length;

  const prefillClient = requestedClientId ? await resolvePrefillClient(staff.businessId, requestedClientId, today) : null;

  // Loaded on the server so a prefilled panel renders with its times already
  // there — the alternative is a mount effect that flashes an empty list.
  const initialSlots =
    !walkIn && provider && prefillServiceIds.length > 0 ? await staffSlotsFor(provider.id, prefillServiceIds, day) : [];

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
        {droppedServices > 0 ? (
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            ⚠ {droppedServices} service{droppedServices === 1 ? '' : 's'} from her last visit{' '}
            {droppedServices === 1 ? 'is' : 'are'} no longer available with this stylist. Check what she is having.
          </p>
        ) : null}
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
          initialServiceIds={prefillServiceIds}
          initialClient={prefillClient}
          initialSlots={initialSlots}
        />
      )}
    </main>
  );
}

/**
 * A-040 — the client the desk was ALREADY looking at, carried through by id.
 *
 * The id, never (phone, name): re-resolving her by typed text is what split a
 * "Jen" off a record that says "Jennifer", taking her history, her pinned note
 * and her rolling no-show count with it (D-17, and A-015's merge exists to
 * clean up after exactly that).
 *
 * `findClient` resolves a tombstone to its survivor (R-10), so a rebook link
 * from a record that has since been merged still lands on the right person.
 *
 * The CLIENT-04 flag comes with her — shown, never enforced (D-27). The
 * "already booked around then" note deliberately does not: it is computed
 * against the slot being booked, and no slot is chosen yet.
 */
async function resolvePrefillClient(businessId: string, clientId: string, today: string) {
  const found = await findClient(prisma, businessId, clientId);
  if (!found) return null;
  const flags = await clientReliability(prisma, { businessId, clientIds: [found.id], today });
  const reliability = flags.get(found.id);
  const missed = reliability ? flagSentence(reliability) : null;
  return { id: found.id, name: found.name, phone: found.phone, ...(missed ? { missed } : {}) };
}

/** "Tuesday 9 June at 14:15", in the SALON's zone. Server-side, always. */
function labelFor(atIso: string, zone: ReturnType<typeof zoneId>): string | null {
  try {
    const label = toLabel(fromDate(toDate(instantFromIso(atIso))), zone);
    // "STARTING FROM", not a bare time (A-042). A gap begins where the last
    // appointment's buffer ends — 13:35 — and the panel preselects the first
    // real slot at or after it, so a heading that read "Tuesday at 13:35" was
    // naming a time the form was not going to book.
    return `Starting from ${readableDay(label.day)} at ${label.time} — pick the time below.`;
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
