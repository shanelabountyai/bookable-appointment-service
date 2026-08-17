import Link from 'next/link';
import { prisma } from '@bookable/db';
import { searchClients } from '@bookable/db/clients';
import { requireStaff } from '@/lib/auth/session';

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

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-8">
      <div>
        <Link href="/staff" className="text-sm text-zinc-500 hover:underline">
          ← Staff
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Clients</h1>
      </div>

      <form className="flex gap-2">
        <label htmlFor="q" className="sr-only">
          Search by name or phone number
        </label>
        <input
          id="q"
          name="q"
          defaultValue={query}
          placeholder="Name or phone number"
          className="flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
        />
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Search
        </button>
      </form>

      {query === '' ? (
        <p className="text-zinc-500">Search by name, or by the last few digits of a number.</p>
      ) : results.length === 0 ? (
        <p className="text-zinc-500">Nobody matches “{query}”.</p>
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
