import type { GridColumn } from './view-model';

/**
 * A-107 — whether this column has a day to be LATE on: her clients, or a delta
 * already stored, or a column that is simply open — never her roster status,
 * and `closed` only in the same direction (an override booked onto a day off
 * is still somebody in the chair at 14:00). Nothing gated on this OFFERS time.
 *
 * A-126 — one predicate for both views. The grid and the stylist's own list
 * are two readers of the same question, and the list had no controls at all.
 * Its own file because `day-grid.tsx` also renders client-side, where the
 * `server-only` view model cannot follow.
 */
export function hasDayToRunLate(column: GridColumn): boolean {
  return (
    column.items.some((item) => item.kind === 'appointment') ||
    column.runningLateMinutes !== null ||
    !(column.closed || column.offRoster)
  );
}
