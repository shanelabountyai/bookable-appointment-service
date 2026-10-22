import { instant, toDate } from '@bookable/core/time';

/**
 * The grid's vertical scale, in its own module because two components need the
 * NUMBER and one of them is a client component while the other is not
 * (`view-model.ts` is `server-only`). A room strip drawn at a different scale
 * from the columns it sits under is worse than no strip: the eye reads them as
 * one picture whether or not they line up.
 */
export const PX_PER_MINUTE = 1.5;

/**
 * A-162 — "click at 14:30 in a free afternoon and book 14:30", the way a
 * calendar does. The grid's axis is PHYSICAL minutes (`minutesFrom` in
 * `view-model.ts`), so a pixel offset is a duration added to the gap's
 * instant: no wall-clock arithmetic, and the fall-back day's two 01:30s stay
 * two places on the grid (D-4).
 *
 * Snapped DOWN to a quarter of an hour on the epoch, which is a quarter of an
 * hour on the salon's wall in every zone whose offset is a multiple of fifteen
 * minutes — all of them. The booking panel then preselects the first bookable
 * time at or after it, so a snap that misses the engine's grid costs nothing.
 *
 * ponytail: a constant, not `business.slotIntervalMinutes` — the panel's
 * "first at or after" absorbs any other interval; read the setting if a salon
 * on a 20-minute grid finds the band misleading.
 */
export const CLICK_STEP_MINUTES = 15;

export function clickedStartMs(gapStartMs: number, gapMinutes: number, offsetPx: number): number {
  const step = CLICK_STEP_MINUTES * 60_000;
  const end = gapStartMs + gapMinutes * 60_000;
  const under = gapStartMs + Math.max(0, offsetPx / PX_PER_MINUTE) * 60_000;
  const snapped = Math.floor(Math.min(under, end - 1) / step) * step;
  return Math.max(gapStartMs, snapped);
}

/** The gap's booking link with `at` moved to the clicked instant. */
export function bookHrefAt(href: string, atMs: number): string {
  const [path, query = ''] = href.split('?');
  const params = new URLSearchParams(query);
  params.set('at', toDate(instant(atMs)).toISOString());
  return `${path}?${params}`;
}
