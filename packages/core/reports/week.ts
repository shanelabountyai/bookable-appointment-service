/** A-024 — the dashboard's week window: Monday through Sunday, whichever
 *  week contains `day`. Business hours are Tue–Sat (D-1's setup seed), so
 *  Monday and Sunday simply contribute nothing to either side of RPT-02's
 *  formula — a cleaner boundary than special-casing the business's own
 *  closed days into a calendar-navigation helper. */
import { type CalendarDay, addDays, weekdayOf } from '../time';

export interface WeekBounds {
  readonly fromDay: CalendarDay;
  readonly toDay: CalendarDay;
}

export function weekOf(day: CalendarDay): WeekBounds {
  // weekdayOf: 0 = Sunday .. 6 = Saturday. Days back to Monday.
  const sinceMonday = (weekdayOf(day) + 6) % 7;
  const fromDay = addDays(day, -sinceMonday);
  return { fromDay, toDay: addDays(fromDay, 6) };
}
