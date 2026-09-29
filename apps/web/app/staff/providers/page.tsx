import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listProviders } from '@bookable/db/settings';
import { requireStaff } from '@/lib/auth/session';
import { AddProviderForm, ProviderRowItem } from './providers-client';

export default async function ProvidersPage() {
  const staff = await requireStaff();
  const providers = await listProviders(prisma, staff.businessId);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <div>
        <h1 className="text-page-title font-semibold tracking-tight">Providers</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Deactivating a provider stops them being offered for new bookings. It never deletes them, and never touches
          appointments already in the book.
        </p>
        {/* A provider here has no sign-in of their own by default — that
            roster, PINs included, lives on People. */}
        <p className="mt-1 text-sm">
          <Link href="/staff/people" className="underline underline-offset-4">
            Looking for sign-ins and desk PINs? See Who works here.
          </Link>
        </p>
      </div>

      <AddProviderForm />

      {providers.length === 0 ? (
        <p className="text-ink-muted">No providers yet.</p>
      ) : (
        <ul className="flex flex-col">
          {providers.map((p) => (
            <ProviderRowItem key={p.id} provider={p} />
          ))}
        </ul>
      )}
    </main>
  );
}
