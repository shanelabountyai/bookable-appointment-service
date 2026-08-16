import { listServices } from '@/lib/booking/public-actions';
import { BookingFlow } from './booking-flow';

export const metadata = { title: 'Book an appointment' };

/**
 * Never prerendered.
 *
 * Without this the route has no dynamic input, so the production build renders
 * it ONCE at build time and ships the service list as static HTML — a salon
 * that adds a service would never see it appear, and one that retires a
 * service would keep selling it until the next deploy. Caught by A-010's e2e
 * specs, which found an empty catalogue on a database that plainly had one:
 * the page had been built before the row existed.
 *
 * The dev server renders every request, so this is a defect only a production
 * build can show — the reason the sweep runs against one (CLAUDE.md).
 */
export const dynamic = 'force-dynamic';

/**
 * BOOK-01 — the customer's whole journey, on one route.
 *
 * Only the service list is loaded here. Days and times depend on the service
 * AND the provider, neither of which is known until the customer has chosen,
 * so pre-loading either would be computing a slot grid nobody asked for.
 */
export default async function BookPage() {
  const services = await listServices();

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Book an appointment</h1>
        <p className="mt-1 text-zinc-500">A few taps — no account needed.</p>
      </header>
      <BookingFlow services={services} />
    </main>
  );
}
