/**
 * THE ONE CUSTOMER-FACING TIME FORMATTER (D-10).
 *
 * "One formatter for customer-facing times: business zone, abbreviation
 * visible whenever the label is ambiguous." Two surfaces now need it — the
 * booking flow's day list and the manage link — and a second copy is how they
 * come to disagree about which day a 23:30 appointment is on.
 *
 * NOT in `public-actions.ts` where the first copy lived: every export from a
 * `'use server'` module must be an async function, so a plain formatter cannot
 * live there and would have been copied instead of imported.
 *
 * Everything here runs SERVER-side. If only instants reached the browser it
 * would format them in the VISITOR's timezone, which is the whole of spec
 * §3.D — a customer in Auckland must be told the salon's Tuesday.
 */
import { type CalendarDay, type ZoneId, calendarDay, fromDate, resolve, toLabel, weekdayOf } from '@bookable/core/time';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** "Tuesday 9 June". The weekday comes from the ONE conversion module — a
 *  hand-rolled weekday calculation is the banned `new Date(string)` wearing a
 *  hat. */
export function readableDay(day: string): string {
  const [, month, dayOfMonth] = day.split('-');
  const weekday = WEEKDAYS[weekdayOf(calendarDay(day))]!;
  return `${weekday} ${Number(dayOfMonth)} ${MONTHS[Number(month) - 1]!}`;
}

/**
 * "Tuesday 9 June at 10:00", in the salon's zone — with the zone abbreviation
 * appended ONLY on a fall-back day, where the same label names two different
 * moments an hour apart (spec FB-5).
 *
 * The ambiguity question is answered by `resolve()`, the same three-armed
 * function the engine uses, rather than by a "is it November?" guess.
 */
export function readableInstant(at: Date, zone: string): string {
  const label = toLabel(fromDate(at), zone as ZoneId);
  const ambiguous = resolve(label.day as CalendarDay, label.time, zone as ZoneId).kind === 'ambiguous';
  return `${readableDay(label.day)} at ${label.time}${ambiguous ? ` (${label.abbreviation})` : ''}`;
}
