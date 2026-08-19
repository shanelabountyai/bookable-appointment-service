import { describe, expect, it } from 'vitest';
import { calendarDay, instantFromIso, wallTime, zoneId } from '../time';
import type { WorkingWindow } from '../scheduling';
import { availableMinutesForDay, utilizationFraction } from './utilization';
import { weekOf } from './week';

const DAY = calendarDay('2026-06-09'); // Tuesday, no DST involved
const ZONE = zoneId('America/Chicago');

const window = (open: string, close: string, breaks: [string, string][] = []): WorkingWindow => ({
  open: wallTime(open),
  close: wallTime(close),
  endsNextDay: false,
  breaks: breaks.map(([o, c]) => ({ open: wallTime(o), close: wallTime(c) })),
});

describe('availableMinutesForDay', () => {
  it('is the plain window length with no breaks or absences', () => {
    expect(availableMinutesForDay([window('09:00', '17:00')], DAY, ZONE, [])).toBe(480);
  });

  it('subtracts a break', () => {
    expect(availableMinutesForDay([window('09:00', '17:00', [['12:00', '13:00']])], DAY, ZONE, [])).toBe(420);
  });

  it('subtracts an absence overlapping the window', () => {
    // A 90-minute local absence inside the 09:00-17:00 window.
    const absence = { start: instantFromIso('2026-06-09T15:00:00-05:00'), end: instantFromIso('2026-06-09T16:30:00-05:00') };
    expect(availableMinutesForDay([window('09:00', '17:00')], DAY, ZONE, [absence])).toBe(390);
  });

  it('a closed day (no windows) has zero available minutes', () => {
    expect(availableMinutesForDay([], DAY, ZONE, [])).toBe(0);
  });

  it('breaks and absences both come out, not just whichever was subtracted last', () => {
    // A break (12:00-13:00) and an absence (15:00-16:00) that do not overlap
    // each other — both must be removed, 480 - 60 - 60 = 360.
    const absence = { start: instantFromIso('2026-06-09T15:00:00-05:00'), end: instantFromIso('2026-06-09T16:00:00-05:00') };
    expect(availableMinutesForDay([window('09:00', '17:00', [['12:00', '13:00']])], DAY, ZONE, [absence])).toBe(360);
  });
});

describe('utilizationFraction', () => {
  it('divides occupied by available', () => {
    expect(utilizationFraction(300, 400)).toBe(0.75);
  });

  it('is n/a (null), never 0, on a zero denominator', () => {
    expect(utilizationFraction(0, 0)).toBeNull();
  });
});

describe('weekOf', () => {
  it('resolves a Tuesday to its own Monday-Sunday week', () => {
    expect(weekOf(calendarDay('2026-06-09'))).toEqual({ fromDay: '2026-06-08', toDay: '2026-06-14' });
  });

  it('a Monday is already the start of its own week', () => {
    expect(weekOf(calendarDay('2026-06-08'))).toEqual({ fromDay: '2026-06-08', toDay: '2026-06-14' });
  });

  it('a Sunday belongs to the week that is ending', () => {
    expect(weekOf(calendarDay('2026-06-14'))).toEqual({ fromDay: '2026-06-08', toDay: '2026-06-14' });
  });
});
