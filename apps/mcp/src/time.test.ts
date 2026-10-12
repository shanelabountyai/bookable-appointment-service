/**
 * M-004 — times in, times out (§6.2). DST instants are the spec's verified
 * ones (docs/reviews/03-slot-engine-spec.md §3), not re-derived.
 */
import { describe, expect, it } from 'vitest';
import { calendarDay, instantFromIso, wallTime, zoneId } from '@bookable/core/time';
import { ToolFailure } from './errors';
import { parseDay, parseInstant, readableDay, readableTime, timeOut } from './time';

const CHI = zoneId('America/Chicago');

function failure(fn: () => unknown): ToolFailure {
  try {
    fn();
  } catch (e) {
    if (e instanceof ToolFailure) return e;
    throw e;
  }
  throw new Error('expected a ToolFailure');
}

describe('parseDay', () => {
  it('accepts a real date and refuses a malformed or non-existent one with the field named', () => {
    expect(parseDay('2026-10-16', 'from_day')).toBe('2026-10-16');
    expect(failure(() => parseDay('16/10/2026', 'from_day')).envelope).toMatchObject({ error: 'INVALID_ARGUMENT', field: 'from_day' });
    expect(failure(() => parseDay('2027-02-29', 'to_day')).envelope.field).toBe('to_day');
  });
});

describe('parseInstant', () => {
  it('resolves an ordinary wall time in the business zone', () => {
    expect(parseInstant('2026-10-16 14:15', 'start', CHI)).toBe(instantFromIso('2026-10-16T19:15:00Z'));
  });

  it('accepts an ISO time with its offset — the unambiguous form', () => {
    expect(parseInstant('2026-11-01T01:30:00-05:00', 'start', CHI)).toBe(instantFromIso('2026-11-01T06:30:00Z'));
    expect(parseInstant('2026-11-01T06:30:00Z', 'start', CHI)).toBe(instantFromIso('2026-11-01T06:30:00Z'));
  });

  it('refuses a format it does not know and says what it wants', () => {
    const e = failure(() => parseInstant('tomorrow 2pm', 'start', CHI)).envelope;
    expect(e).toMatchObject({ error: 'INVALID_ARGUMENT', field: 'start' });
    expect(e.message).toMatch(/YYYY-MM-DD HH:MM/);
    expect(failure(() => parseInstant('2026-10-16 24:15', 'start', CHI)).envelope.error).toBe('INVALID_ARGUMENT');
  });

  it('spring-forward gap: 02:30 on 2026-03-08 names no instant — both edges are named, nothing is coerced (DST-8)', () => {
    const e = failure(() => parseInstant('2026-03-08 02:30', 'start', CHI)).envelope;
    expect(e).toMatchObject({ error: 'AMBIGUOUS_TIME', field: 'start' });
    expect(e.message).toMatch(/does not exist/);
    expect(e.message).toContain('2026-03-08T01:30:00-06:00');
    expect(e.message).toContain('2026-03-08T03:30:00-05:00');
    expect(e).not.toHaveProperty('next');
  });

  it('fall-back overlap: 01:30 on 2026-11-01 names two instants — both are offered as ISO (FB-2)', () => {
    const e = failure(() => parseInstant('2026-11-01 01:30', 'start', CHI)).envelope;
    expect(e).toMatchObject({ error: 'AMBIGUOUS_TIME', field: 'start' });
    expect(e.message).toMatch(/happens twice/);
    expect(e.message).toContain('2026-11-01T01:30:00-05:00');
    expect(e.message).toContain('2026-11-01T01:30:00-06:00');
    expect(e.message).toMatch(/CDT.*CST/);
  });
});

describe('times out', () => {
  it('labels for humans and ISO with offset for the next call', () => {
    expect(timeOut(instantFromIso('2026-10-16T19:15:00Z'), CHI)).toEqual({
      label: 'Fri 16 Oct, 2:15 pm',
      iso: '2026-10-16T14:15:00-05:00',
    });
    expect(timeOut(instantFromIso('2026-10-16T14:00:00Z'), CHI).label).toBe('Fri 16 Oct, 9:00 am');
  });

  it('carries the zone abbreviation only on an ambiguous label (FB-5)', () => {
    expect(timeOut(instantFromIso('2026-11-01T06:30:00Z'), CHI).label).toBe('Sun 1 Nov, 1:30 am CDT');
    expect(timeOut(instantFromIso('2026-11-01T07:30:00Z'), CHI).label).toBe('Sun 1 Nov, 1:30 am CST');
    expect(timeOut(instantFromIso('2026-11-01T15:00:00Z'), CHI).label).toBe('Sun 1 Nov, 9:00 am');
  });

  it('readable pieces', () => {
    expect(readableDay(calendarDay('2026-11-01'))).toBe('Sun 1 Nov');
    expect(readableTime(wallTime('00:05'))).toBe('12:05 am');
    expect(readableTime(wallTime('12:00'))).toBe('12:00 pm');
    expect(readableTime(wallTime('23:59'))).toBe('11:59 pm');
  });
});
