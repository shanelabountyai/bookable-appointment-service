import type { GridColumn } from '@/lib/day/view-model';

/**
 * A-150 (C9) — HOW FAR THE PAPER HAS DRIFTED. "Printed 08:45 · 3 changed
 * since", on screen only: the sheet pinned at the station is the copy that
 * cannot update itself, and this is the count of rows it is now wrong about.
 * Nothing at all until the day has been printed.
 */
export function PrintDrift({ column }: { column: GridColumn }) {
  if (!column.printed) return null;
  return (
    <p className="text-xs text-zinc-700 print:hidden dark:text-zinc-300">
      Printed {column.printed}
      {column.changedSincePrint > 0 ? (
        <span className="font-semibold"> · {column.changedSincePrint} changed since print</span>
      ) : null}
    </p>
  );
}
