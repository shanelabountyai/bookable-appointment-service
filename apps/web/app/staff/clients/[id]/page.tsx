import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bookable/db';
import { clientHistory, findClient, missedAppointments, rebookSuggestion, reliabilityFor } from '@bookable/db/clients';
import { fromDate, toLabel, zoneId } from '@bookable/core/time';
import { requireStaff } from '@/lib/auth/session';
import { readableDay, readableInstant } from '@/lib/customer-format';
import { NotesForm } from './notes-form';
import { MergePanel } from './merge-panel';
import { ClientFlag } from '@/components/client-flag';

export const dynamic = 'force-dynamic';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The client record (CLIENT-01..03).
 *
 * A STAFF surface, so D-10's lexicon rules do not apply here — the raw status
 * is what the front desk needs to read ("no-show", not "this appointment has
 * passed"), and it is the same word the reports use.
 */
export default async function ClientPage({ params }: PageProps<'/staff/clients/[id]'>) {
  const staff = await requireStaff();
  const { id } = await params;

  const client = await findClient(prisma, staff.businessId, id);
  if (!client) notFound();

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  const today = toLabel(fromDate(new Date()), zoneId(business.timezone)).day;

  const [history, rebook, reliability, missed] = await Promise.all([
    clientHistory(prisma, staff.businessId, client.id),
    rebookSuggestion(prisma, staff.businessId, client.id, today),
    reliabilityFor(prisma, { businessId: staff.businessId, clientId: client.id, today }),
    missedAppointments(prisma, { businessId: staff.businessId, clientId: client.id, today }),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-8">
      <div>
        <Link href="/staff/clients" className="text-sm text-zinc-500 hover:underline">
          ← Clients
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{client.name ?? 'No name'}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {client.phone ?? 'No number'}
          {client.email ? ` · ${client.email}` : ''}
        </p>
        {client.reachedByOldNumber ? (
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-500">
            You reached this record through a number that was merged into it.
          </p>
        ) : null}
      </div>

      {/* CLIENT-03: the pinned note is FIRST on the page. It is a safety
          surface — a formula or an allergy — and a note nobody scrolls to is
          a note nobody reads. */}
      <NotesForm clientId={client.id} notes={client.notes ?? ''} />

      {/* CLIENT-04. The counter WITH ITS WORKING: a bare "3 no-shows" ends the
          conversation at the desk, and every reference links to the
          appointment whose log says who marked it and why — so a mis-tap is
          one click from the count it produced (APPT-06). */}
      {missed.length > 0 ? (
        <section
          aria-labelledby="missed-heading"
          className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30"
        >
          <h2 id="missed-heading" className="text-sm font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-500">
            Missed appointments
          </h2>
          <ClientFlag reliability={reliability} />
          {reliability.selfServeBlocked ? (
            <p className="text-sm">
              She is over the salon&rsquo;s limit of {reliability.threshold}, so the website tells her to call.
              Booking her from here still works.
            </p>
          ) : null}
          <ul className="flex flex-col gap-1 text-sm">
            {missed.map((visit) => (
              <li key={visit.appointmentId}>
                <Link href={`/staff/appointments/${visit.appointmentId}`} className="underline underline-offset-4">
                  {readableDay(visit.startDay)}
                </Link>{' '}
                <span className="text-zinc-600 dark:text-zinc-400">
                  — {visit.services.join(' + ')} with {visit.providerName}, {visit.status.replace('_', ' ')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {rebook ? (
        <section className="flex flex-col gap-2 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Rebook last visit</h2>
          <p className="text-sm">
            {rebook.serviceNames.join(' + ')} with {rebook.providerName}. Last in on{' '}
            {readableDay(rebook.lastVisitDay)} — she comes about every {rebook.intervalDays} days, so this starts on{' '}
            {readableDay(rebook.fromDay)}.
          </p>
          <Link
            href={{
              pathname: '/book',
              query: {
                service: rebook.serviceIds[0]!,
                provider: rebook.providerId,
                from: rebook.fromDay,
              },
            }}
            className="self-start rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Rebook
          </Link>
        </section>
      ) : null}

      {/* NAMED, so it is addressable — by a screen reader moving between
          landmarks, and by a test that means "in the history" now that a
          no-show legitimately appears twice on this page. */}
      <section aria-labelledby="history-heading" className="flex flex-col gap-3">
        <h2 id="history-heading" className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          History
        </h2>
        {history.length === 0 ? (
          <p className="text-zinc-500">No appointments yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {history.map((visit) => (
              <li
                key={visit.appointmentId}
                className="flex flex-wrap items-baseline justify-between gap-x-4 rounded-md border border-zinc-300 px-4 py-3 dark:border-zinc-700"
              >
                <span className="font-medium">{readableInstant(visit.startAt, business.timezone)}</span>
                <span className="text-sm text-zinc-500">
                  {visit.services.join(' + ')} · {visit.providerName} · {money(visit.priceCents)}
                </span>
                {/* No-shows and late cancels are shown, not hidden (CLIENT-02):
                    they are what the counter in A-020 is built from. */}
                <span className="text-sm font-medium">{visit.status.replace('_', ' ')}</span>
                {visit.notes ? <p className="w-full text-sm text-zinc-500">{visit.notes}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <MergePanel survivorId={client.id} survivorName={client.name ?? 'this record'} />
    </main>
  );
}
