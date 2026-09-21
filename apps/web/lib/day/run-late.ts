import { occupiesTime } from '@bookable/core/scheduling';
import type { GridColumn } from './view-model';

/**
 * A-129 — a LIVE client, not a chip. Cancelled appointments stay on the day as
 * greyed items (the desk needs "she cancelled"), so `kind === 'appointment'`
 * read a closed date the desk had since emptied as a closed date WITH clients.
 * Derived from the status module — the sheet's own filter (`sheetItems`) asks
 * the same `occupiesTime` — never a hand-typed cancelled list.
 */
export function hasLiveAppointment(column: GridColumn): boolean {
  return column.items.some(
    (item) => item.kind === 'appointment' && item.status !== undefined && occupiesTime(item.status),
  );
}

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
  return hasLiveAppointment(column) || column.runningLateMinutes !== null || !(column.closed || column.offRoster);
}
