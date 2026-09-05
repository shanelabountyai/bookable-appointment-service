import { requireStaff } from '@/lib/auth/session';
import { logout } from '@/lib/auth/actions';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * A-085 (D-49) — `/staff` IS THE SETUP INDEX NOW, not the landing page.
 *
 * It used to be a column of twelve links that named twelve of twenty-three
 * staff routes, and it was where signing in landed you — one hop from the day
 * grid the desk actually works in. The shell carries the desk routes on every
 * screen now, so the only thing left that needs an index is CONFIGURATION: the
 * screens somebody opens on a Tuesday to change how the salon runs, not the
 * ones the front desk taps forty times a day.
 *
 * NOT `requireOwner`. Every route listed here is `requireStaff` today and this
 * item does not change a guard — a stylist can already open Services and
 * Availability, and quietly taking that away behind a navigation change is not
 * a navigation change. The tier is drawn by POSITION in the shell (after the
 * rule, quieter), which is what §5.5 asks for. `requireOwner` redirects here
 * too, so guarding this page with it would loop.
 */
export const dynamic = 'force-dynamic';

const SETUP = [
  { href: '/staff/availability', label: 'Availability', hint: 'Weekly hours, and one-off days.' },
  { href: '/staff/providers', label: 'Providers', hint: 'Who takes appointments.' },
  { href: '/staff/people', label: 'Who works here', hint: 'The roster, and who has a desk PIN.' },
  { href: '/staff/services', label: 'Services', hint: 'Durations, buffers and develop gaps.' },
  { href: '/staff/resources', label: 'The room', hint: 'Chairs, basins and anything shared.' },
  { href: '/staff/settings', label: 'Settings', hint: 'Lead time, cancellation cutoff, horizon.' },
] as const;

export default async function StaffSetup() {
  await requireStaff();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-8">
      <div>
        <h1 className="text-page-title font-semibold tracking-tight">Setup</h1>
        {/* This page USED to repeat "At the desk: Dana" under its heading. The
            shell says it on every screen now, and two renderings of one fact is
            how they come to disagree — so the duplicate goes rather than being
            restyled. */}
        <EmptyState className="mt-1">How the salon runs. Changes here affect every day.</EmptyState>
      </div>

      <ul className="flex flex-col gap-2">
        {SETUP.map((item) => (
          <li key={item.href}>
            <LinkButton
              href={item.href}
              className="w-full flex-col items-start gap-0 px-4 py-3 text-left"
            >
              <span className="font-medium text-ink-primary">{item.label}</span>
              <span className="text-caption font-normal text-ink-muted">{item.hint}</span>
            </LinkButton>
          </li>
        ))}
      </ul>

      <form action={logout}>
        <Button type="submit">Sign out</Button>
      </form>
    </main>
  );
}
