import Link from 'next/link';
import { prisma } from '@bookable/db';
import { clientReliability, searchClients } from '@bookable/db/clients';
import { fromDate, toLabel, zoneId } from '@bookable/core/time';
import { requireStaff } from '@/lib/auth/session';
import { ClientFlag } from '@/components/client-flag';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';

export const dynamic = 'force-dynamic';

/**
 * CLIENT-01's lookup, as a screen.
 *
 * A plain GET form rather than a live-search component: the result is a URL
 * the front desk can keep open on a second tab, go back to, and read out from.
 * There is nothing here a client component would add except a dependency on
 * JavaScript for finding a phone number.
 *
 * The list may legitimately contain two people with the SAME NUMBER (D-17) —
 * a mother and daughter share one. Nothing here collapses them, and the number
 * is shown on every row precisely so staff can see that is what happened.
 */
export default async function ClientsPage({ searchParams }: PageProps<'/staff/clients'>) {
  const staff = await requireStaff();
  const { q } = await searchParams;
  const query = typeof q === 'string' ? q : '';
  const results = query ? await searchClients(prisma, staff.businessId, query) : [];

  // CLIENT-04, batched for the whole list: the front desk reads this page with
  // the client on the phone, and "she's missed three" has to be visible before
  // they click into the record to find out.
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  const flags = await clientReliability(prisma, {
    businessId: staff.businessId,
    clientIds: results.map((c) => c.id),
    today: toLabel(fromDate(new Date()), zoneId(business.timezone)).day,
  });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
      </div>

      {/* A-089. The primitives' first real caller. No `error` prop: a search
          box cannot fail, and an always-present live region here would reserve
          a line for an announcement that never comes. */}
      <form className="flex items-end gap-2">
        <Field id="q" label="Search by name or phone number" labelHidden className="flex-1">
          {(control) => (
            <Input {...control} name="q" defaultValue={query} placeholder="Name or phone number" />
          )}
        </Field>
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>

      {query === '' ? (
        <EmptyState>Search by name, or by the last few digits of a number.</EmptyState>
      ) : results.length === 0 ? (
        <EmptyState>Nobody matches “{query}”.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {results.map((client) => (
            <li key={client.id}>
              <Link
                href={`/staff/clients/${client.id}`}
                className="flex flex-col rounded-md border border-zinc-300 px-4 py-3 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                <span className="font-medium">{client.name ?? 'No name'}</span>
                <span className="text-sm text-zinc-500">{client.phone ?? 'No number'}</span>
                <ClientFlag reliability={flags.get(client.id)} />
                {client.reachedByOldNumber ? (
                  <span className="text-sm text-amber-700 dark:text-amber-500">
                    Found through an old number that was merged into this record.
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
