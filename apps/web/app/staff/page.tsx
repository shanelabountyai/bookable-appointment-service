import Link from 'next/link';
import { requireStaff } from '@/lib/auth/session';
import { logout } from '@/lib/auth/actions';

/**
 * The staff landing page. Its only job in A-005 is to be a route that is
 * genuinely unreachable without a session — the day grid it eventually
 * becomes is A-016.
 *
 * `requireStaff()` is the first statement, and it throws (via redirect) when
 * there is no session, so nothing below it can render for an anonymous
 * visitor.
 */
export default async function StaffHome() {
  const staff = await requireStaff();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>
        <p className="mt-1 text-zinc-500">
          Signed in as <span className="font-medium text-zinc-700 dark:text-zinc-300">{staff.email}</span>
        </p>
      </div>

      <nav className="flex flex-col gap-2">
        <Link href="/staff/day" className="text-zinc-900 underline underline-offset-4 dark:text-zinc-100">
          Today
        </Link>
        <Link href="/staff/settings" className="text-zinc-900 underline underline-offset-4 dark:text-zinc-100">
          Settings
        </Link>
        <Link href="/staff/providers" className="text-zinc-900 underline underline-offset-4 dark:text-zinc-100">
          Providers
        </Link>
        <Link href="/staff/services" className="text-zinc-900 underline underline-offset-4 dark:text-zinc-100">
          Services
        </Link>
        <Link href="/staff/availability" className="text-zinc-900 underline underline-offset-4 dark:text-zinc-100">
          Availability
        </Link>
        <Link href="/staff/clients" className="text-zinc-900 underline underline-offset-4 dark:text-zinc-100">
          Clients
        </Link>
        <Link href="/staff/call-down" className="text-zinc-900 underline underline-offset-4 dark:text-zinc-100">
          Call-down
        </Link>
      </nav>

      <form action={logout}>
        <button
          type="submit"
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
