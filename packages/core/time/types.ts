/**
 * The two axes, branded. NORMATIVE SOURCE: docs/reviews/03-slot-engine-spec.md §1.1.
 *
 * This is the canonical home of the axis types and their validating
 * constructors. `packages/core/scheduling/types.ts` re-exports them so the
 * engine contract reads as one file; the definitions live here because
 * validation is an axis-boundary concern and this package owns the boundary.
 *
 * The No-Mixing Law: CalendarDay/WallTime/ZoneId (rules) and Instant
 * (occurrences) are structurally incompatible. Neither `Date` nor a bare
 * string/number crosses this boundary in either direction. Exactly one module
 * converts between them — ./zone.ts, and nothing else, ever.
 */
import { Temporal } from 'temporal-polyfill';

// ── The calendar axis. No offset. No instant. Not orderable against Instant. ──
/** ISO-8601 calendar date, "2026-03-08". A label on a wall calendar. */
export type CalendarDay = string & { readonly __calendarDay: unique symbol };
/** ISO-8601 local time of day, "09:00". No date, no zone. */
export type WallTime = string & { readonly __wallTime: unique symbol };
/** IANA zone id, "America/Chicago". Never a fixed offset or abbreviation. */
export type ZoneId = string & { readonly __zoneId: unique symbol };

// ── The physical axis. One number line. No calendar meaning. ──
/** Epoch milliseconds UTC. The only representation of a moment in this system. */
export type Instant = number & { readonly __instant: unique symbol };

/** Thrown by every constructor here. Malformed input fails loudly at the
 *  boundary rather than becoming a plausible-but-wrong instant downstream. */
export class InvalidTimeValue extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTimeValue';
  }
}

/** "2026-03-08". Rejects malformed dates AND non-existent ones: 2027-02-29
 *  throws rather than normalizing to March 1 (spec LD-2 — native JS `Date`
 *  silently gives Mar 01, which is the entire class of bug this type prevents). */
export const calendarDay = (s: string): CalendarDay => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new InvalidTimeValue(`CalendarDay must be YYYY-MM-DD, got: ${s}`);
  }
  try {
    Temporal.PlainDate.from(s, { overflow: 'reject' });
  } catch {
    throw new InvalidTimeValue(`CalendarDay is not a real date: ${s}`);
  }
  return s as CalendarDay;
};

/** "09:00" or "09:00:00", NORMALIZED to "HH:MM". Rejects 24:00 and 25:00 — a
 *  window closing at "24:00" is modelled with endsNextDay, not a 24th hour.
 *
 *  Normalization is not cosmetic. Returning the input unchanged would give one
 *  wall time two non-equal representations, so `wallTime('09:00:00') !==
 *  wallTime('09:00')` and every `===`, Set membership, Map key and dedupe on a
 *  WallTime would be subtly wrong — including, once A-003 lands, two different
 *  spellings of the same window open sitting in the database. Minute precision
 *  matches what toLabel() emits, so the axis round-trips exactly. */
export const wallTime = (s: string): WallTime => {
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    throw new InvalidTimeValue(`WallTime must be HH:MM or HH:MM:SS, got: ${s}`);
  }
  let parsed: Temporal.PlainTime;
  try {
    parsed = Temporal.PlainTime.from(s, { overflow: 'reject' });
  } catch {
    throw new InvalidTimeValue(`WallTime is not a real time of day: ${s}`);
  }
  if (parsed.second !== 0 || parsed.millisecond !== 0) {
    throw new InvalidTimeValue(
      `WallTime is minute-precision; sub-minute components are not representable, got: ${s}`,
    );
  }
  return parsed.toString({ smallestUnit: 'minute' }) as WallTime;
};

/** "America/Chicago". A fixed offset ("-05:00") or abbreviation ("CDT") is
 *  REFUSED: neither survives a DST transition, which is the whole point. */
export const zoneId = (s: string): ZoneId => {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/.test(s) && s !== 'UTC') {
    throw new InvalidTimeValue(
      `ZoneId must be an IANA zone id like "America/Chicago", got: ${s}. ` +
        'A fixed offset or abbreviation does not survive a DST transition.',
    );
  }
  try {
    // Throws RangeError for an unknown zone; the explicit timeZone means this
    // never consults the process zone.
    new Intl.DateTimeFormat('en-US', { timeZone: s });
  } catch {
    throw new InvalidTimeValue(`ZoneId is not a known IANA zone: ${s}`);
  }
  return s as ZoneId;
};

/** Epoch milliseconds. Integer, finite. */
export const instant = (epochMs: number): Instant => {
  if (!Number.isFinite(epochMs) || !Number.isInteger(epochMs)) {
    throw new InvalidTimeValue(`Instant must be an integer epoch-millisecond value, got: ${epochMs}`);
  }
  return epochMs as Instant;
};

/** Boundary parser for offset-bearing ISO strings (API payloads, fixtures).
 *  The offset is REQUIRED — a zoneless string is exactly the bug the axis
 *  split forbids, and D-4 requires that a slot's identity carry its offset. */
export const instantFromIso = (iso: string): Instant => {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    throw new InvalidTimeValue(`instantFromIso requires an explicit offset, got: ${iso}`);
  }
  try {
    return Temporal.Instant.from(iso).epochMilliseconds as Instant;
  } catch {
    throw new InvalidTimeValue(`instantFromIso could not parse: ${iso}`);
  }
};
