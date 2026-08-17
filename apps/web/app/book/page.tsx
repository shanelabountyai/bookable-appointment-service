import { listDaysWithOpenings, listProvidersFor, listServices } from '@/lib/booking/public-actions';
import { BookingFlow, type Prefill } from './booking-flow';

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
export default async function BookPage({ searchParams }: PageProps<'/book'>) {
  const services = await listServices();
  const prefill = await resolvePrefill(services, await searchParams);

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Book an appointment</h1>
        <p className="mt-1 text-zinc-500">A few taps — no account needed.</p>
      </header>
      <BookingFlow services={services} prefill={prefill} />
    </main>
  );
}

/**
 * A-015's "rebook last visit" arriving as a link (CLIENT-02).
 *
 * Every failure returns null and the flow starts from the top, because every
 * one of them is ordinary: the service was retired, the stylist left, the link
 * was pasted with a typo, or somebody hand-edited the URL. A rebook link that
 * 500s a public page because a provider was deactivated last week would be a
 * worse outcome than the customer choosing again.
 */
async function resolvePrefill(
  services: Awaited<ReturnType<typeof listServices>>,
  params: Record<string, string | string[] | undefined>,
): Promise<Prefill | null> {
  const serviceId = typeof params.service === 'string' ? params.service : null;
  const providerId = typeof params.provider === 'string' ? params.provider : null;
  const fromDay = typeof params.from === 'string' ? params.from : undefined;
  if (!serviceId || !providerId) return null;

  const service = services.find((s) => s.id === serviceId);
  if (!service) return null;

  // Through the same qualification lookup the flow itself uses, so a provider
  // who is no longer qualified for the service cannot be prefilled into a
  // combination the engine would then refuse.
  const provider = (await listProvidersFor(serviceId)).find((p) => p.id === providerId);
  if (!provider) return null;

  return { service, provider, openDays: await listDaysWithOpenings(serviceId, providerId, fromDay) };
}
