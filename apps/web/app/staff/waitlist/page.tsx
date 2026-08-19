import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listProviders, listServices } from '@bookable/db/settings';
import { listWaitlistEntries, matchFreedSlot } from '@bookable/db/waitlist';
import { instantFromIso, toDate, toLabel, zoneId } from '@bookable/core/time';
import { requireStaff } from '@/lib/auth/session';
import { readableDay, readableInstant } from '@/lib/customer-format';
import { EntryForm } from './entry-form';
import { EntryStatusButton } from './entry-status-button';

export const dynamic = 'force-dynamic';

/**
 * A-023 — the waitlist, staff half (WAIT-01, WAIT-02).
 *
 * Two things on one screen: the standing queue (add, and close out), and —
 * when reached from the appointment detail page's "who wants this slot?"
 * link with a freed interval named in the URL — who actually fits it.
 *
 * Automation (OQ-4's soft-hold offer) is explicitly NOT this row; this page
 * only ever answers a human "who", never sends anything itself.
 */
export default async function WaitlistPage({ searchParams }: PageProps<'/staff/waitlist'>) {
  const staff = await requireStaff();
  const params = await searchParams;

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });

  const [entries, providers, services] = await Promise.all([
    listWaitlistEntries(prisma, staff.businessId),
    listProviders(prisma, staff.businessId, false),
    listServices(prisma, staff.businessId, false),
  ]);

  const freed = freedSlotFrom(params, business.timezone, providers, services);
  const matches = freed ? await matchFreedSlot(prisma, { ...freed.query, businessId: staff.businessId }) : null;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href="/staff" className="text-sm text-zinc-500 hover:underline">
          ← Staff
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Waitlist</h1>
      </div>

      {freed ? (
        <section className="flex flex-col gap-3 rounded-md border border-emerald-500 p-4 dark:border-emerald-700">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-400">
            Who wants this slot?
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {freed.serviceName} with {freed.providerName}, {readableInstant(toDate(instantFromIso(freed.at)), business.timezone)}.
          </p>
          {matches && matches.length === 0 ? (
            <p className="text-sm text-zinc-500">Nobody on the waitlist fits this one.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {matches?.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700"
                >
                  <span>
                    <span className="font-medium">{entry.clientName ?? 'No name'}</span>{' '}
                    <span className="text-zinc-500">{entry.clientPhone ?? ''}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Link
                      href={`/staff/book?provider=${freed.providerId}&at=${encodeURIComponent(freed.at)}&day=${freed.query.day}`}
                      className="rounded-md border border-zinc-400 px-2 py-1 text-xs font-medium dark:border-zinc-600"
                    >
                      Book
                    </Link>
                    <EntryStatusButton entryId={entry.id} status="fulfilled" label="Fulfilled" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <EntryForm services={services} providers={providers} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Waiting ({entries.length})
        </h2>
        {entries.length === 0 ? (
          <p className="text-sm text-zinc-500">Nobody is waiting on anything right now.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => {
              const providerNames = entry.providerIds.length
                ? entry.providerIds.map((id) => providers.find((p) => p.id === id)?.displayName ?? '?').join(' or ')
                : 'Any provider';
              return (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700"
                >
                  <div>
                    <p className="font-medium">
                      {entry.clientName ?? 'No name'} <span className="font-normal text-zinc-500">{entry.clientPhone ?? ''}</span>
                    </p>
                    <p className="text-zinc-600 dark:text-zinc-400">
                      {entry.serviceName} · {providerNames} · {readableDay(entry.fromDay)}–{readableDay(entry.toDay)}
                      {entry.dayParts.length ? ` · ${entry.dayParts.join(', ')}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <EntryStatusButton entryId={entry.id} status="fulfilled" label="Fulfilled" />
                    <EntryStatusButton entryId={entry.id} status="cancelled" label="Remove" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

/** Reads the freed-interval context off the URL — set by the appointment
 *  detail page's link, never typed by hand. Malformed or partial params fall
 *  back to "no freed slot", quietly: this is internal navigation state, not a
 *  form a person fills in. */
function freedSlotFrom(
  params: Awaited<PageProps<'/staff/waitlist'>['searchParams']>,
  timezone: string,
  providers: { id: string; displayName: string }[],
  services: { id: string; name: string }[],
) {
  const providerId = typeof params.providerId === 'string' ? params.providerId : null;
  const serviceId = typeof params.serviceId === 'string' ? params.serviceId : null;
  const at = typeof params.at === 'string' ? params.at : null;
  const minutes = typeof params.minutes === 'string' ? Number(params.minutes) : null;
  if (!providerId || !serviceId || !at || !minutes || !Number.isFinite(minutes) || minutes <= 0) return null;

  const provider = providers.find((p) => p.id === providerId);
  const service = services.find((s) => s.id === serviceId);
  if (!provider || !service) return null;

  let label;
  try {
    label = toLabel(instantFromIso(at), zoneId(timezone));
  } catch {
    return null;
  }

  return {
    providerId,
    providerName: provider.displayName,
    serviceName: service.name,
    at,
    query: { providerId, serviceId, day: label.day, time: label.time, freedMinutes: minutes },
  };
}
