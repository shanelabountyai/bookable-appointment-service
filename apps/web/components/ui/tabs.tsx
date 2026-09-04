import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * A-089 — `Tabs` (design brief §5.3, §4).
 *
 * LINKS, NEVER `role="tablist"`. These are URLs — `/staff/day?provider=…` is
 * a page the desk keeps open on a second tab, goes back to, and prints from.
 * The ARIA tab pattern would claim keyboard behaviour (arrow keys, one tab
 * stop) that this is not, and would tell a screen reader the panel is on the
 * same page when it is a navigation. `<nav>` + `aria-current="page"` is what
 * §4 asks for and what the day view already does.
 *
 * THE CURRENT TAB INVERTS rather than tinting (A-088: selection is drawn by
 * inverting plus `aria-current`, never by a colour alone) — and it carries its
 * own print override, because §4's "anything that only works because of a
 * background colour is invisible on paper" is exactly what a black chip with
 * white text becomes when a browser declines to print the background. On paper
 * the current tab is bold and underlined instead. The day toolbar happens to
 * be `print:hidden` today; a primitive that is only correct because of where
 * its one caller sits is a defect waiting for the second caller.
 */
export function Tabs({
  label,
  className,
  ...props
}: React.ComponentProps<'nav'> & { label: string }) {
  return <nav {...props} aria-label={label} className={cn('flex flex-wrap gap-2', className)} />;
}

export function Tab({
  current = false,
  className,
  ...props
}: React.ComponentProps<typeof Link> & { current?: boolean }) {
  return (
    <Link
      {...props}
      aria-current={current ? 'page' : undefined}
      className={cn(
        'inline-flex min-h-11 items-center rounded-control border px-3 py-1.5 text-body transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
        current
          ? 'border-line-strong bg-ground-inverted font-medium text-ink-inverted print:bg-transparent print:font-bold print:text-ink-primary print:underline'
          : 'border-line-hairline text-ink-primary hover:bg-ground-sunken',
        className,
      )}
    />
  );
}
