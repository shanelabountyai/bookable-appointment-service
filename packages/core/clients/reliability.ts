/**
 * CLIENT-04's rule, pure: what "3 no-shows in a rolling 12 months" means.
 *
 * Two decisions live here and nowhere else, because both have an obvious
 * wrong answer that no test would catch downstream:
 *
 *  1. THE WINDOW IS ON THE CALENDAR AXIS. "The last 12 months" is a calendar
 *     fact, like the rebook interval (CLIENT-02) — it is not 365 × 86_400_000
 *     milliseconds counted back from an instant, which is a day out either
 *     side of a leap year and an hour out either side of every DST
 *     transition. The counting query compares `startDay`, a CHAR(10) calendar
 *     label, against the day this returns.
 *
 *  2. A THRESHOLD OF ZERO MEANS OFF, NOT "BLOCK EVERYONE". The settings form
 *     accepts 0 (the policy validator only demands a non-negative integer),
 *     and the naive `count >= threshold` blocks every client in the salon
 *     including the ones who have never missed anything — an owner turning
 *     the lever down to nothing would take the whole booking page offline and
 *     the error would look like a website outage.
 */
import { type CalendarDay, oneYearBefore } from '../time';

export const RELIABILITY_WINDOW_MONTHS = 12;

/** The first calendar day inside the rolling window — INCLUSIVE. A no-show on
 *  exactly this day still counts; one the day before has aged out. */
export function reliabilityWindowStart(today: CalendarDay): CalendarDay {
  return oneYearBefore(today);
}

/** Is self-serve booking blocked for a client with this many no-shows? */
export function selfServeBlocked(noShows: number, threshold: number): boolean {
  if (threshold <= 0) return false;
  return noShows >= threshold;
}
