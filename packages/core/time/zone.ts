/**
 * THE ONE MODULE THAT CONVERTS BETWEEN THE TWO AXES (spec §1.1 rule 2, D-3).
 *
 * Nothing else in this repo may convert a CalendarDay/WallTime to an Instant or
 * back. Every function here takes an explicit ZoneId — there is no zoneless
 * overload, ever, and nothing here reads the process timezone.
 *
 * Temporal lives HERE and only here (spec §5): callers resolve a day's window
 * opens/closes/breaks to Instants once, then do all grid iteration, overlap
 * testing and buffer arithmetic on plain epoch-millisecond integers. The
 * physical axis has no DST, so integer arithmetic on it is DST-proof by
 * construction — and it keeps the slot engine library-free.
 */
import { Temporal } from 'temporal-polyfill';
import {
  type CalendarDay,
  type Instant,
  InvalidTimeValue,
  type WallTime,
  type ZoneId,
  calendarDay,
  wallTime,
} from './types';

/**
 * The result of asking "what instant is this wall time in this zone?".
 *
 * It is NOT an Instant, because the local→instant map is neither injective nor
 * total (spec Fact 2): on 2026-03-08 in America/Chicago "02:30" names no
 * instant, and on 2026-11-01 "01:30" names two. Every call site must decide
 * what to do with both cases; an exhaustive switch makes that mechanical.
 */
export type Resolution =
  | { readonly kind: 'unique'; readonly at: Instant }
  /** The local time does not exist. `earlier`/`later` are the instants either
   *  side of the gap, for explaining the refusal — NEVER for coercing into
   *  (spec DST-8: luxon shifts forward, date-fns-tz shifts back, both book a
   *  time the customer did not choose). */
  | { readonly kind: 'gap'; readonly earlier: Instant; readonly later: Instant }
  /** The local time happens twice. Both are real, bookable, distinct slots
   *  (spec FB-1/FB-4 — collapsing them destroys an hour of capacity). */
  | { readonly kind: 'ambiguous'; readonly earlier: Instant; readonly later: Instant };

const plainDateTime = (day: CalendarDay, time: WallTime): Temporal.PlainDateTime =>
  Temporal.PlainDate.from(day, { overflow: 'reject' }).toPlainDateTime(
    Temporal.PlainTime.from(time, { overflow: 'reject' }),
  );

/**
 * (CalendarDay, WallTime, ZoneId) → unique | gap | ambiguous.
 *
 * Discrimination is by round-trip rather than by comparing the two
 * disambiguation modes' instants: for BOTH a gap and an ambiguity the two
 * modes return instants an offset-shift apart, so the instants alone cannot
 * tell the cases apart. What separates them is that an ambiguous local time
 * still converts back to the local time you asked for, and a nonexistent one
 * does not.
 */
export function resolve(day: CalendarDay, time: WallTime, zone: ZoneId): Resolution {
  const wanted = plainDateTime(day, time);

  let earlier: Temporal.ZonedDateTime;
  let later: Temporal.ZonedDateTime;
  try {
    earlier = wanted.toZonedDateTime(zone, { disambiguation: 'earlier' });
    later = wanted.toZonedDateTime(zone, { disambiguation: 'later' });
  } catch {
    throw new InvalidTimeValue(`Cannot resolve ${day} ${time} in zone ${zone}`);
  }

  if (earlier.epochMilliseconds === later.epochMilliseconds) {
    return { kind: 'unique', at: earlier.epochMilliseconds as Instant };
  }

  const survivesRoundTrip = earlier.toPlainDateTime().equals(wanted);
  return {
    kind: survivesRoundTrip ? 'ambiguous' : 'gap',
    earlier: earlier.epochMilliseconds as Instant,
    later: later.epochMilliseconds as Instant,
  };
}

/** What the engine and UI put on a slot. Precomputed server-side in the
 *  business zone, exactly once — if only instants reach the browser, the
 *  browser formats them in the BROWSER's zone (spec §3.D). */
export interface ZonedLabel {
  readonly day: CalendarDay;
  readonly time: WallTime;
  /** "-05:00" — the fall-back tiebreaker (spec FB-5). */
  readonly offset: string;
  /** "CDT" — for humans, never for logic. */
  readonly abbreviation: string;
}

/** Instant → its label in the business zone. The inverse direction of the
 *  axis crossing, and the only one permitted to produce a CalendarDay. */
export function toLabel(at: Instant, zone: ZoneId): ZonedLabel {
  const zdt = new Temporal.Instant(BigInt(at) * 1_000_000n).toZonedDateTimeISO(zone);
  return {
    day: calendarDay(zdt.toPlainDate().toString()),
    time: wallTime(zdt.toPlainTime().toString({ smallestUnit: 'minute' })),
    offset: zdt.offset,
    abbreviation: abbreviationAt(at, zone),
  };
}

/** tzdata's short name for the zone at that instant ("CDT"/"CST"). Zones
 *  without a short name render as "GMT+5:45", which is correct and readable. */
function abbreviationAt(at: Instant, zone: ZoneId): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(at);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/** The first instant of a calendar day in the business zone. On a
 *  spring-forward day whose transition happens at midnight this is NOT
 *  00:00 local, which is why Temporal computes it rather than string math. */
export function startOfDay(day: CalendarDay, zone: ZoneId): Instant {
  return Temporal.PlainDate.from(day, { overflow: 'reject' }).toZonedDateTime(zone).epochMilliseconds as Instant;
}

/** Physical length of a calendar day: 1380 on spring-forward, 1500 on
 *  fall-back, 1440 otherwise (spec DST-2). Any capacity or utilization figure
 *  built on `close.hour − open.hour` over-reports by 25% twice a year. */
export function localDayLengthMinutes(day: CalendarDay, zone: ZoneId): number {
  return (startOfDay(addDays(day, 1), zone) - startOfDay(day, zone)) / 60_000;
}

/**
 * The ORM/driver bridge, and the ONLY sanctioned way to make a `Date` in this
 * repo (`new Date(...)` is banned everywhere else by lint).
 *
 * Prisma and node-postgres speak `Date` for `timestamptz`. That is tolerable in
 * exactly one direction — a `Date` built from epoch milliseconds carries no
 * calendar interpretation and no process-timezone involvement, so it round-trips
 * losslessly. What is NOT tolerable is `new Date('2026-03-08')`, which parses a
 * calendar label through the process zone; these two functions exist so that
 * distinction is enforced by the module boundary rather than by remembering it.
 */
export const toDate = (at: Instant): Date => new Date(at);

/** Driver `Date` → Instant. Rejects an invalid Date rather than propagating NaN
 *  into arithmetic that would silently produce garbage comparisons. */
export const fromDate = (d: Date): Instant => {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) {
    throw new InvalidTimeValue(`fromDate received an invalid Date: ${String(d)}`);
  }
  return ms as Instant;
};

/** Day arithmetic on the CALENDAR axis. Adding 86_400_000 ms is correct on
 *  the physical axis and wrong on this one — after a transition every
 *  occurrence lands an hour off and drifts permanently (spec X-2). */
export function addDays(day: CalendarDay, days: number): CalendarDay {
  if (!Number.isInteger(days)) {
    throw new InvalidTimeValue(`addDays needs an integer number of days, got: ${days}`);
  }
  return calendarDay(Temporal.PlainDate.from(day, { overflow: 'reject' }).add({ days }).toString());
}
