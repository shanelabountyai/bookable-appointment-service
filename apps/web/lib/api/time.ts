/**
 * W-002 — times in and out of the API (API PRD §6.2), through the MCP
 * server's parsers, which go through `@bookable/core/time` and nothing else.
 *
 * IN: business-local `YYYY-MM-DD HH:MM`, or an ISO-8601 instant WITH offset.
 *     A DST gap or overlap is refused as `AMBIGUOUS_TIME` naming both
 *     readings — never silently resolved (D-4).
 * OUT: always both — `startAt` (the instant, as ISO with the business's
 *     offset) and `startLocal` (`{ date, time, zone }`), so no `{date, time}`
 *     pair alone ever identifies a slot.
 */
import { type CalendarDay, type Instant, type ZoneId, fromDate, toLabel } from '@bookable/core/time';
import { parseDay as mcpParseDay, parseInstant as mcpParseInstant, timeOut } from '@bookable/mcp';

export function parseInstant(value: string, field: string, zone: ZoneId): Instant {
  return mcpParseInstant(value, field, zone);
}

export function parseDay(value: string, field: string): CalendarDay {
  return mcpParseDay(value, field);
}

export interface LocalTime {
  date: string;
  time: string;
  zone: string;
}

/** The instant as ISO with the salon's offset at that moment, e.g. `2026-06-10T10:00:00-05:00`. */
export function isoOf(at: Instant, zone: ZoneId): string {
  return timeOut(at, zone).iso;
}

export function localOf(at: Instant, zone: ZoneId): LocalTime {
  const l = toLabel(at, zone);
  return { date: l.day, time: l.time, zone };
}

/** Both halves of §6.2's output rule, from a database `Date`. */
export function when(at: Date, zone: ZoneId): { at: string; local: LocalTime } {
  const i = fromDate(at);
  return { at: isoOf(i, zone), local: localOf(i, zone) };
}
