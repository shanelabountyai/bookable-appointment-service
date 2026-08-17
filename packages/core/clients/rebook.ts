/**
 * CLIENT-02's "natural interval" — when is she due back? Pure.
 *
 * "Rebook last visit prefills provider + service and jumps the slot search to
 * the natural interval." The interval is the client's OWN rhythm where she has
 * one: the gap between her last two visits. Six weeks between colours is a
 * fact about her hair, not about the salon, and starting the day list at
 * tomorrow makes the front desk scroll past three weeks she will not want.
 *
 * Calendar arithmetic deliberately stays OUT of here: this returns a number of
 * DAYS, and the caller walks the calendar with `addDays`. Adding
 * `n * 86_400_000` to an instant lands an hour off after a DST transition and
 * drifts permanently (spec X-2) — the mistake is only avoidable if the two
 * axes never meet, so this side never sees an instant at all.
 */
import { type CalendarDay, daysBetween } from '../time';

/**
 * Where there is no rhythm to read, four weeks.
 *
 * Not a guess dressed as data: it is the interval a salon quotes when nobody
 * asks, and it is short enough that the front desk scrolls FORWARD to correct
 * it rather than backwards, which is the cheaper direction to be wrong in.
 */
export const DEFAULT_REBOOK_INTERVAL_DAYS = 28;

/** How far apart her last two visits were, in whole days — or the default.
 *  Takes CALENDAR days, because that is what a client's rhythm is measured in:
 *  "every six weeks" is six weeks on a calendar, not 3,628,800,000 physical
 *  milliseconds. */
export function naturalIntervalDays(visitDaysMostRecentFirst: readonly CalendarDay[]): number {
  const [latest, previous] = visitDaysMostRecentFirst;
  if (latest === undefined || previous === undefined) return DEFAULT_REBOOK_INTERVAL_DAYS;

  const gap = daysBetween(previous, latest);
  // A same-day pair is two lines of one visit (a cut and a colour booked
  // separately), not a rhythm — and a zero-day interval would suggest
  // rebooking her for this afternoon.
  return gap > 0 ? gap : DEFAULT_REBOOK_INTERVAL_DAYS;
}
