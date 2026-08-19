import Link from 'next/link';
import type { GridColumn } from '@/lib/day/view-model';

/**
 * ONE STYLIST'S OWN DAY, as a list (A-016).
 *
 * The same data as the grid, in the shape a phone can hold: Dana between
 * clients wants to know who is next, not to pinch-zoom a four-column
 * timetable. A list also needs no absolute positioning, so it reflows at any
 * width and reads in order with no further work.
 *
 * A server component: nothing here needs state, and the page's own refresh
 * timer already keeps it fresh.
 */
export function ProviderDay({ column }: { column: GridColumn }) {
  if (column.closed) {
    return <p className="text-zinc-500">{column.providerName} is not working today.</p>;
  }

  if (column.items.length === 0) {
    return <p className="text-zinc-500">Nothing in the book yet.</p>;
  }

  return (
    <ol className="flex flex-col gap-2">
      {column.items.map((item) => (
        <li
          key={item.key}
          className={`flex flex-wrap items-baseline gap-x-3 rounded-md border px-4 py-3 ${
            item.kind === 'appointment'
              ? 'border-zinc-300 dark:border-zinc-700'
              : 'border-dashed border-zinc-300 text-zinc-500 dark:border-zinc-700'
          }`}
        >
          <span className="w-28 shrink-0 font-mono text-sm">{item.time}</span>

          {item.href ? (
            <Link href={item.href} className="font-medium underline underline-offset-4" aria-label={item.label}>
              {item.title}
            </Link>
          ) : (
            <span className="font-medium">{item.title}</span>
          )}

          {item.detail ? <span className="text-sm text-zinc-500">{item.detail}</span> : null}

          {item.isOverride ? (
            <span className="rounded-sm border border-zinc-400 px-1 text-[10px] uppercase tracking-wide">override</span>
          ) : null}

          {/* Status as a WORD, not only a colour — this list is what a stylist
              reads in bright sunlight on a phone. */}
          {item.status ? <span className="ml-auto text-sm">{STATUS_TEXT[item.status]}</span> : null}

          {item.projected ? (
            <p className="w-full text-sm font-medium text-amber-900 dark:text-amber-200">
              Running behind — likely {item.projected}
            </p>
          ) : null}

          {item.pinnedNote ? (
            <p className="w-full text-sm font-medium text-amber-900 dark:text-amber-200">⚑ {item.pinnedNote}</p>
          ) : null}
          {item.missed ? (
            <p className="w-full text-sm font-medium text-amber-900 dark:text-amber-200">⚑ {item.missed}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Staff wording, not D-10's customer lexicon: this is a staff surface and
 *  "no-show" is the word the front desk and the reports both use. */
const STATUS_TEXT = {
  booked: 'Booked',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  in_progress: 'In progress',
  completed: 'Completed',
  no_show: 'No-show',
  cancelled: 'Cancelled',
  cancelled_late: 'Cancelled late',
} as const;
