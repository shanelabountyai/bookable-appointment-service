/**
 * A-023 — day-part tags (WAIT-01).
 *
 * A `WaitlistEntry.dayParts` cell is free text ("any Saturday morning, Dana or
 * Priya" — operator review R-1's example), but matching it against a freed
 * slot needs a closed vocabulary or nothing ever matches. This is that single
 * source: the weekday names (from `weekdayOf`'s 0 = Sunday convention, so the
 * two never drift apart) plus three time bands.
 *
 * The bands are a naming convenience, not a scheduling rule — no test in this
 * file cares what a "morning" appointment costs, only what it's called.
 */
import { type CalendarDay, type WallTime, weekdayOf } from '../time';

export const WEEKDAY_TAGS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export const TIME_BAND_TAGS = ['morning', 'afternoon', 'evening'] as const;

/** The whole vocabulary an entry's `dayParts` may draw from. */
export const DAY_PART_TAGS = [...WEEKDAY_TAGS, ...TIME_BAND_TAGS] as const;
export type DayPartTag = (typeof DAY_PART_TAGS)[number];

/** Which tags describe this one instant, in the business's own calendar. */
export function tagsFor(day: CalendarDay, time: WallTime): DayPartTag[] {
  // weekdayOf always returns 0..6 (Sunday..Saturday) — a valid WEEKDAY_TAGS
  // index by construction, not a lookup that can miss.
  return [WEEKDAY_TAGS[weekdayOf(day)] as (typeof WEEKDAY_TAGS)[number], timeBand(time)];
}

/**
 * ponytail: fixed boundaries (morning < noon, evening from 17:00), not a
 * per-business setting. Upgrade to a configurable band only if an operator
 * actually asks — nothing in the backlog does.
 */
function timeBand(time: WallTime): (typeof TIME_BAND_TAGS)[number] {
  if (time < '12:00') return 'morning';
  if (time < '17:00') return 'afternoon';
  return 'evening';
}

/**
 * An entry with no day-part preference matches anything. One WITH
 * preferences must have ALL of them satisfied — "Saturday morning" is a
 * conjunction, not "Saturday, or morning, whichever". Mixing weekdays and
 * time bands so an entry could express "Saturday OR Sunday, mornings" is a
 * real gap, deferred until a real entry needs it (nothing in the operator
 * review's examples does).
 */
export function matchesDayParts(wanted: readonly string[], actual: readonly DayPartTag[]): boolean {
  return wanted.length === 0 || wanted.every((tag) => (actual as readonly string[]).includes(tag));
}
