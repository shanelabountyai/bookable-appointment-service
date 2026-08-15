/**
 * A-002 — the axis-conversion module.
 *
 * Every expected instant below is taken verbatim from
 * docs/reviews/03-slot-engine-spec.md §3, where it was verified by execution
 * against the IANA tzdata. Do not re-derive these by hand (CLAUDE.md).
 *
 * These tests must pass identically under TZ=UTC and TZ=Pacific/Kiritimati —
 * nothing here may consult the process zone.
 */
import { describe, expect, it } from 'vitest';
import { addDays, localDayLengthMinutes, resolve, startOfDay, toLabel } from './zone';
import { InvalidTimeValue, calendarDay, instantFromIso, wallTime, zoneId } from './types';

const CHI = zoneId('America/Chicago');
const LORD_HOWE = zoneId('Australia/Lord_Howe');
const KATHMANDU = zoneId('Asia/Kathmandu');

const at = (day: string, time: string, zone = CHI) => resolve(calendarDay(day), wallTime(time), zone);

describe('resolve() — the three-armed return (§1.1 rule 3)', () => {
  it('returns unique for an ordinary local time', () => {
    const r = at('2026-06-09', '09:00');
    expect(r.kind).toBe('unique');
    if (r.kind !== 'unique') throw new Error('unreachable');
    expect(r.at).toBe(instantFromIso('2026-06-09T09:00:00-05:00'));
  });

  // Spec §3.A ground truth: 02:00:00–02:59:59.999 local does not exist on this day.
  it('returns gap for 2026-03-08 02:30 America/Chicago — the hour that does not exist', () => {
    const r = at('2026-03-08', '02:30');
    expect(r.kind).toBe('gap');
    if (r.kind !== 'gap') throw new Error('unreachable');
    // The two instants either side of the gap, for a caller that wants to
    // explain itself. Neither is "the answer" — DST-8: never coerce.
    expect(r.earlier).toBe(instantFromIso('2026-03-08T07:30:00Z'));
    expect(r.later).toBe(instantFromIso('2026-03-08T08:30:00Z'));
  });

  // Spec §3.B ground truth: 01:00 CDT = 06:00Z (first), 01:00 CST = 07:00Z (second).
  it('returns ambiguous for 2026-11-01 01:30 America/Chicago — the hour that happens twice', () => {
    const r = at('2026-11-01', '01:30');
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') throw new Error('unreachable');
    expect(r.earlier).toBe(instantFromIso('2026-11-01T06:30:00Z'));
    expect(r.later).toBe(instantFromIso('2026-11-01T07:30:00Z'));
    expect(r.later - r.earlier).toBe(3_600_000);
  });

  it('resolves the whole spring-forward gap as gap and its edges as unique (§3.A)', () => {
    expect(at('2026-03-08', '01:59').kind).toBe('unique');
    expect(at('2026-03-08', '02:00').kind).toBe('gap');
    expect(at('2026-03-08', '02:59').kind).toBe('gap');
    expect(at('2026-03-08', '03:00').kind).toBe('unique');
  });

  it('resolves the whole fall-back repeated hour as ambiguous and its edges as unique (§3.B)', () => {
    expect(at('2026-11-01', '00:59').kind).toBe('unique');
    expect(at('2026-11-01', '01:00').kind).toBe('ambiguous');
    expect(at('2026-11-01', '01:59').kind).toBe('ambiguous');
    expect(at('2026-11-01', '02:00').kind).toBe('unique');
  });
});

describe('the spec §3 ground-truth instants', () => {
  // §3.A: 01:00 CST = 07:00Z; 03:00 CDT = 08:00Z; 05:00 CDT = 10:00Z.
  it.each([
    ['2026-03-08', '01:00', '2026-03-08T07:00:00Z'],
    ['2026-03-08', '03:00', '2026-03-08T08:00:00Z'],
    ['2026-03-08', '05:00', '2026-03-08T10:00:00Z'],
    // §3.B: 02:00 CST = 08:00Z.
    ['2026-11-01', '02:00', '2026-11-01T08:00:00Z'],
  ])('%s %s America/Chicago is %s', (day, time, iso) => {
    const r = at(day, time);
    expect(r.kind).toBe('unique');
    if (r.kind !== 'unique') throw new Error('unreachable');
    expect(r.at).toBe(instantFromIso(iso));
  });

  // §3.C X-1: the offset must be looked up for the TARGET instant, never
  // computed once from "today" and reused.
  it('X-1: 09:00 on 2026-03-15 (CDT) is 14:00Z even though today is CST', () => {
    const r = at('2026-03-15', '09:00');
    if (r.kind !== 'unique') throw new Error('unreachable');
    expect(r.at).toBe(instantFromIso('2026-03-15T14:00:00Z'));
  });
});

describe('zones that break whole-hour assumptions (§3.A DST-9)', () => {
  it('handles Lord Howe’s 30-minute spring-forward: 02:00→02:30 on 2026-10-04', () => {
    expect(resolve(calendarDay('2026-10-04'), wallTime('01:45'), LORD_HOWE).kind).toBe('unique');
    expect(resolve(calendarDay('2026-10-04'), wallTime('02:00'), LORD_HOWE).kind).toBe('gap');
    expect(resolve(calendarDay('2026-10-04'), wallTime('02:15'), LORD_HOWE).kind).toBe('gap');
    expect(resolve(calendarDay('2026-10-04'), wallTime('02:30'), LORD_HOWE).kind).toBe('unique');
  });

  it('handles a non-whole-hour offset: Asia/Kathmandu is +05:45', () => {
    const r = resolve(calendarDay('2026-06-09'), wallTime('09:00'), KATHMANDU);
    if (r.kind !== 'unique') throw new Error('unreachable');
    expect(toLabel(r.at, KATHMANDU).offset).toBe('+05:45');
  });
});

describe('toLabel() — instant → business-zone label (§3.B FB-5)', () => {
  it('distinguishes the two 01:30s by offset and abbreviation', () => {
    const first = toLabel(instantFromIso('2026-11-01T06:30:00Z'), CHI);
    const second = toLabel(instantFromIso('2026-11-01T07:30:00Z'), CHI);
    expect(first).toEqual({
      day: calendarDay('2026-11-01'),
      time: wallTime('01:30'),
      offset: '-05:00',
      abbreviation: 'CDT',
    });
    expect(second).toEqual({
      day: calendarDay('2026-11-01'),
      time: wallTime('01:30'),
      offset: '-06:00',
      abbreviation: 'CST',
    });
    // Same wall label, different instants — the disambiguator is the whole point.
    expect(first.time).toBe(second.time);
    expect(first.offset).not.toBe(second.offset);
  });

  it('labels an instant on the calendar day it falls on in the BUSINESS zone, not UTC', () => {
    // 2026-06-10T02:00Z is still 2026-06-09 (21:00) in Chicago.
    expect(toLabel(instantFromIso('2026-06-10T02:00:00Z'), CHI)).toEqual({
      day: calendarDay('2026-06-09'),
      time: wallTime('21:00'),
      offset: '-05:00',
      abbreviation: 'CDT',
    });
  });

  it('round-trips a unique local time through resolve and back', () => {
    const r = at('2026-06-09', '14:45');
    if (r.kind !== 'unique') throw new Error('unreachable');
    const label = toLabel(r.at, CHI);
    expect(label.day).toBe(calendarDay('2026-06-09'));
    expect(label.time).toBe(wallTime('14:45'));
  });
});

describe('localDayLengthMinutes() (§3.A DST-2)', () => {
  it.each([
    ['2026-03-08', 1380, 'spring forward — 23 hours'],
    ['2026-11-01', 1500, 'fall back — 25 hours'],
    ['2026-06-09', 1440, 'ordinary day'],
  ])('%s is %i minutes (%s)', (day, minutes) => {
    expect(localDayLengthMinutes(calendarDay(day), CHI)).toBe(minutes);
  });

  it('is 1410 on Lord Howe’s 30-minute transition day', () => {
    expect(localDayLengthMinutes(calendarDay('2026-10-04'), LORD_HOWE)).toBe(1410);
  });
});

describe('startOfDay() — the local-midnight anchor', () => {
  it('is the first instant of the calendar day in the business zone', () => {
    expect(startOfDay(calendarDay('2026-06-09'), CHI)).toBe(instantFromIso('2026-06-09T00:00:00-05:00'));
    expect(startOfDay(calendarDay('2026-03-08'), CHI)).toBe(instantFromIso('2026-03-08T00:00:00-06:00'));
    expect(startOfDay(calendarDay('2026-11-01'), CHI)).toBe(instantFromIso('2026-11-01T00:00:00-05:00'));
  });
});

describe('addDays() — arithmetic on the CALENDAR axis (§3.C X-2, §3.F, §3.G)', () => {
  it('crosses a DST boundary without drifting', () => {
    expect(addDays(calendarDay('2026-03-07'), 1)).toBe(calendarDay('2026-03-08'));
    expect(addDays(calendarDay('2026-03-08'), 1)).toBe(calendarDay('2026-03-09'));
  });

  it('crosses month, year and leap-day boundaries', () => {
    expect(addDays(calendarDay('2026-01-31'), 1)).toBe(calendarDay('2026-02-01'));
    expect(addDays(calendarDay('2026-12-31'), 1)).toBe(calendarDay('2027-01-01'));
    expect(addDays(calendarDay('2028-02-28'), 1)).toBe(calendarDay('2028-02-29')); // 2028 IS a leap year
    expect(addDays(calendarDay('2027-02-28'), 1)).toBe(calendarDay('2027-03-01')); // 2027 is not
  });

  it('goes backwards', () => {
    expect(addDays(calendarDay('2026-03-01'), -1)).toBe(calendarDay('2026-02-28'));
  });

  // X-2: "every Tuesday 09:00" must iterate on the calendar axis, then resolve
  // each day independently. Adding 7*86400e3 ms is right on the physical axis
  // and wrong on the calendar one.
  it('X-2: eight weekly occurrences from 2026-03-03 are all 09:00 local, with differing offsets', () => {
    let day = calendarDay('2026-03-03');
    const labels: string[] = [];
    const offsets = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const r = resolve(day, wallTime('09:00'), CHI);
      if (r.kind !== 'unique') throw new Error('unreachable');
      const label = toLabel(r.at, CHI);
      labels.push(label.time);
      offsets.add(label.offset);
      day = addDays(day, 7);
    }
    expect(labels).toEqual(Array<string>(8).fill('09:00'));
    expect([...offsets].sort()).toEqual(['-05:00', '-06:00']); // straddles 2026-03-08
  });
});

describe('validation at the boundary — malformed input throws (§2, items 27–39)', () => {
  it('rejects a calendar day that is not a real date', () => {
    expect(() => calendarDay('2027-02-29')).toThrow(InvalidTimeValue); // LD-2
    expect(() => calendarDay('2026-13-01')).toThrow(InvalidTimeValue);
    expect(() => calendarDay('2026-3-8')).toThrow(InvalidTimeValue);
    expect(() => calendarDay('08/03/2026')).toThrow(InvalidTimeValue);
  });

  it('accepts a real leap day', () => {
    expect(calendarDay('2028-02-29')).toBe('2028-02-29');
  });

  it('rejects a wall time that is not a real time of day', () => {
    expect(() => wallTime('25:00')).toThrow(InvalidTimeValue);
    expect(() => wallTime('09:60')).toThrow(InvalidTimeValue);
    expect(() => wallTime('9:00')).toThrow(InvalidTimeValue);
  });

  // One wall time must have exactly ONE representation, or `===`, Set
  // membership, Map keys and dedupe are all subtly wrong — and A-003 would
  // store two spellings of the same window open.
  it('normalizes a wall time to HH:MM so equality is meaningful', () => {
    expect(wallTime('09:00:00')).toBe(wallTime('09:00'));
    expect(wallTime('09:00:00')).toBe('09:00');
    expect(new Set([wallTime('14:30'), wallTime('14:30:00')]).size).toBe(1);
  });

  it('rejects a sub-minute wall time rather than silently truncating it', () => {
    expect(() => wallTime('09:00:30')).toThrow(InvalidTimeValue);
  });

  it('rejects a fixed offset or abbreviation as a zone id', () => {
    expect(() => zoneId('-05:00')).toThrow(InvalidTimeValue);
    expect(() => zoneId('CDT')).toThrow(InvalidTimeValue);
    expect(() => zoneId('Not/AZone')).toThrow(InvalidTimeValue);
  });

  it('rejects a zoneless ISO string — D-4, a slot identity carries its offset', () => {
    expect(() => instantFromIso('2026-06-09T09:00:00')).toThrow(InvalidTimeValue);
    expect(() => instantFromIso('2026-06-09')).toThrow(InvalidTimeValue);
  });
});
