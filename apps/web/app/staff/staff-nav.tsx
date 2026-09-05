'use client';

import { usePathname } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

/**
 * A-085 (D-49, D-50) — THE STAFF SHELL'S NAVIGATION (design brief §5.5, §8.4).
 *
 * Named at four consecutive phase closes and built once, here, rather than one
 * link at a time — which is the specific failure D-49 chose to avoid.
 *
 * WHAT THE MEASUREMENT SAID it had to fix. Counted inbound links before this
 * file existed: `/staff/unfinished` had ONE door (the day toolbar, behind a
 * badge that hid at zero), `/staff/waitlist`, `/staff/messages` and
 * `/staff/clients` had one each, and `/staff` — a column of twelve links —
 * named twelve of twenty-three staff routes. Every route below is one that was
 * hard to reach, not every route that exists: `/staff/book` already has three
 * doors (Walk-in, Anyone, and every empty slot on the grid) and is deliberately
 * absent.
 *
 * `'use client'` FOR ONE REASON: `usePathname`. A server layout cannot know
 * which route is rendering, and §4 requires `aria-current="page"` on the
 * selected item. Nothing else here is stateful — the counts arrive as props
 * from the layout, which is where the queries belong, and the search box is a
 * plain GET form that would work with JavaScript switched off.
 *
 * NO HAMBURGER (§5.5). It wraps instead. The desk does this forty times a day
 * and a disclosure costs two taps for the thing that should cost one.
 */
type Counts = { opened: number; unfinished: number; failedMessages: number };

/**
 * THE LINK IS PERMANENT AND THE BADGE HIDES AT ZERO — D-50, and it settles a
 * real conflict between two earlier decisions.
 *
 * A-076 hid the whole "Still open" link at zero, reasoning that a permanent
 * link to an empty list stops being read. D-49 then recorded the cost of
 * exactly that: Phase 8's headline screen had one door, and a desk that had
 * never had an unfinished appointment could not know the screen existed.
 *
 * Both are right about different things, and the shell is what lets them both
 * be true: the DOOR is navigation and is always there; the NUMBER is an errand
 * and appears only when there is one. A-076's worry was about the number
 * becoming furniture, and it does not.
 */
const DESK = [
  { href: '/staff/day', label: 'Day', count: null },
  { href: '/staff/opened', label: 'Opened up', count: 'opened' },
  { href: '/staff/unfinished', label: 'Still open', count: 'unfinished' },
  { href: '/staff/waitlist', label: 'Waitlist', count: null },
  { href: '/staff/call-down', label: 'Call-down', count: null },
  { href: '/staff/conflicts', label: 'Conflicts', count: null },
  { href: '/staff/messages', label: 'Messages', count: 'failedMessages' },
] as const;

export function StaffNav({ counts, isOwner }: { counts: Counts; isOwner: boolean }) {
  const pathname = usePathname();

  /** A prefix match, so `/staff/clients/abc` still marks Clients. `/staff`
   *  itself is compared exactly — otherwise Setup would be current on every
   *  staff page in the product. */
  const current = (href: string) =>
    href === '/staff' ? pathname === '/staff' : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav
      aria-label="Staff"
      className="border-b border-line-hairline bg-ground-raised print:hidden"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
        {DESK.map((item) => {
          const count = item.count ? counts[item.count] : 0;
          return (
            <LinkButton
              key={item.href}
              href={item.href}
              variant={current(item.href) ? 'primary' : 'quiet'}
              aria-current={current(item.href) ? 'page' : undefined}
            >
              {item.label}
              {/* The badge is INSIDE the link, so the accessible name reads
                  "Opened up 3" rather than announcing a bare "3". */}
              {count > 0 ? (
                <Badge intent={item.count === 'failedMessages' ? 'attention' : 'neutral'}>
                  {count}
                </Badge>
              ) : null}
            </LinkButton>
          );
        })}

        {/* §5.5's headline gap: "It's Mrs Kerr, can I move Thursday" was day
            grid → /staff → Clients → search, while she waited. A GET form, so
            the result is a URL the desk can keep open on a second tab — the
            same reasoning `/staff/clients` itself was built on. */}
        <form action="/staff/clients" className="flex items-end gap-2">
          <Field id="staff-nav-q" label="Search a client" labelHidden>
            {(control) => (
              <Input {...control} name="q" placeholder="Search a client" className="w-44" />
            )}
          </Field>
          <Button type="submit">Find</Button>
        </form>

        {/* THE OWNER TIER, visibly different by POSITION and weight rather than
            by permission — the configuration routes are `requireStaff` today
            and this file does not change a guard (D-36: hiding a link hides
            nothing; the route is the control). Only Dashboard is owner-only,
            exactly as `/staff` had it before. */}
        <span aria-hidden="true" className="ml-auto h-6 w-px bg-line-hairline" />
        {isOwner ? (
          <LinkButton
            href="/staff/dashboard"
            variant={current('/staff/dashboard') ? 'primary' : 'quiet'}
            aria-current={current('/staff/dashboard') ? 'page' : undefined}
          >
            Dashboard
          </LinkButton>
        ) : null}
        <LinkButton
          href="/staff"
          variant={current('/staff') ? 'primary' : 'quiet'}
          aria-current={current('/staff') ? 'page' : undefined}
        >
          Setup
        </LinkButton>
      </div>
    </nav>
  );
}
