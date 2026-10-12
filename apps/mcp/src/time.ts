/**
 * Times in, times out (PRD §6.2) — the only place model-facing time strings
 * are read or written. Everything goes through `@bookable/core/time`; this
 * file does string formatting and nothing else.
 *
 * IN:  a day is `YYYY-MM-DD`; a time is `YYYY-MM-DD HH:MM` in the BUSINESS's
 *      zone, or an ISO-8601 instant with its offset (`2026-11-01T01:30:00-05:00`)
 *      — the form a model is told to use after an AMBIGUOUS_TIME refusal, since
 *      a wall time cannot name one of two instants (D-4, spec FB-2).
 * OUT: `{ label, iso }` — "Thu 16 Oct, 2:15 pm" for the human, and the instant
 *      with offset for the next call.
 */
import {
  type CalendarDay,
  type Instant,
  InvalidTimeValue,
  type WallTime,
  type ZoneId,
  calendarDay,
  fromDate,
  instantFromIso,
  resolve,
  toDate,
  toLabel,
  wallTime,
  weekdayOf,
} from '@bookable/core/time';
import { ToolFailure, invalidArgument } from './errors';

const WALL = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseDay(value: string, field: string): CalendarDay {
  try {
    return calendarDay(value);
  } catch (error) {
    if (error instanceof InvalidTimeValue) throw invalidArgument(field, `${field} must be a real date as YYYY-MM-DD, like 2026-10-16.`);
    throw error;
  }
}

/** A model-supplied time → one instant, or a refusal that names both readings. */
export function parseInstant(value: string, field: string, zone: ZoneId): Instant {
  if (ISO_WITH_OFFSET.test(value)) {
    try {
      return instantFromIso(value);
    } catch (error) {
      if (error instanceof InvalidTimeValue) throw invalidArgument(field, `${field} is not a valid ISO time: ${value}`);
      throw error;
    }
  }
  const m = WALL.exec(value);
  if (!m) {
    throw invalidArgument(
      field,
      `${field} must be the salon's local time as "YYYY-MM-DD HH:MM" (24-hour), like "2026-10-16 14:15".`,
    );
  }
  let day: CalendarDay;
  let time: WallTime;
  try {
    day = calendarDay(m[1]!);
    time = wallTime(m[2]!);
  } catch (error) {
    if (error instanceof InvalidTimeValue) throw invalidArgument(field, `${field} is not a real date and time: ${value}`);
    throw error;
  }
  const r = resolve(day, time, zone);
  if (r.kind === 'unique') return r.at;
  const earlier = describe(r.earlier, zone);
  const later = describe(r.later, zone);
  if (r.kind === 'gap') {
    throw new ToolFailure({
      error: 'AMBIGUOUS_TIME',
      message:
        `${time} does not exist on ${readableDay(day)} in ${zone} — the clocks jump forward. ` +
        `The nearest real times are ${earlier.label} ${earlier.abbreviation} (${earlier.iso}) and ${later.label} ${later.abbreviation} (${later.iso}). ` +
        'Ask the human which they want and send that ISO time.',
      field,
    });
  }
  throw new ToolFailure({
    error: 'AMBIGUOUS_TIME',
    message:
      `${time} happens twice on ${readableDay(day)} in ${zone} — the clocks go back. ` +
      `It is ${earlier.label} ${earlier.abbreviation} (${earlier.iso}) and again ${later.label} ${later.abbreviation} (${later.iso}). ` +
      'Ask the human which they mean and send that ISO time.',
    field,
  });
}

export interface TimeOut {
  /** "Thu 16 Oct, 2:15 pm" — with the zone abbreviation only when the label is ambiguous that day. */
  label: string;
  /** "2026-10-16T14:15:00-05:00" — what to send back to a tool. */
  iso: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Thu 16 Oct" — from the string, never from a `Date`. */
export function readableDay(day: CalendarDay): string {
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return `${WEEKDAYS[weekdayOf(day)]} ${date} ${MONTHS[month - 1]}`;
}

/** "2:15 pm" from "14:15". */
export function readableTime(time: WallTime): string {
  const h = Number(time.slice(0, 2));
  const mm = time.slice(3, 5);
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${mm} ${suffix}`;
}

function describe(at: Instant, zone: ZoneId): TimeOut & { abbreviation: string } {
  const l = toLabel(at, zone);
  return {
    label: `${readableDay(l.day)}, ${readableTime(l.time)}`,
    iso: `${l.day}T${l.time}:00${l.offset}`,
    abbreviation: l.abbreviation,
  };
}

export function timeOut(at: Instant, zone: ZoneId): TimeOut {
  const l = toLabel(at, zone);
  const ambiguous = resolve(l.day, l.time, zone).kind === 'ambiguous';
  return {
    label: `${readableDay(l.day)}, ${readableTime(l.time)}${ambiguous ? ` ${l.abbreviation}` : ''}`,
    iso: `${l.day}T${l.time}:00${l.offset}`,
  };
}

/** Same, from a database `Date`. */
export function timeOutOf(at: Date, zone: ZoneId): TimeOut {
  return timeOut(fromDate(at), zone);
}

export { toDate };
