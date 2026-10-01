import Link from 'next/link';
import type { SeriesLine } from '@/lib/booking/series-summary';

/**
 * A-049 — EVERY week, booked and skipped alike, in one list. Creation is
 * partial by design (D-34), so a summary that showed only what succeeded
 * would be the silent skip this whole feature is the opposite of: the fourth
 * Tuesday is somebody else's, and the desk finds that out here or on the
 * phone in four weeks' time. A-152 reads an extension back the same way.
 */
export function SeriesSummaryList({ lines }: { lines: SeriesLine[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {lines.map((line) => (
        <li
          key={line.day}
          className="flex flex-wrap items-baseline gap-x-2 rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
        >
          <span className="font-medium">{line.day}</span>
          {line.appointmentId ? (
            <Link href={`/staff/appointments/${line.appointmentId}`} className="underline underline-offset-4">
              booked
            </Link>
          ) : (
            <span className="text-amber-800 dark:text-amber-300">not booked</span>
          )}
          {line.note ? <span className="text-zinc-600 dark:text-zinc-400">— {line.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}
