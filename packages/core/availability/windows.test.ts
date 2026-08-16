/**
 * A-007 — the precedence chain (AVAIL-01..04). Pure: no database, no zone, no
 * clock, no instants.
 */
import { describe, expect, it } from 'vitest';
import {
  type DayPattern,
  InvalidAvailability,
  type MinuteWindow,
  effectiveWindows,
  intersectWindows,
  resolveAvailableWindows,
  toDayMinute,
  toMinuteWindow,
  toWallTime,
  toWindowInput,
  unionWindows,
} from './windows';

const win = (open: string, close: string, endsNextDay = false, breaks: { open: string; close: string }[] = []) =>
  toMinuteWindow({ open, close, endsNextDay, breaks });

/** Readable assertion helper: windows as "09:00-17:00" strings. */
const asText = (windows: MinuteWindow[]) => windows.map((w) => `${toWallTime(w.openMin)}-${toWallTime(w.closeMin)}`);
const breaksOf = (w: MinuteWindow) => w.breaks.map((b) => `${toWallTime(b.openMin)}-${toWallTime(b.closeMin)}`);

describe('wall-clock minute conversion', () => {
  it.each([
    ['00:00', 0],
    ['09:00', 540],
    ['12:30', 750],
    ['23:59', 1439],
  ])('%s is minute %i', (wallTime, minute) => {
    expect(toDayMinute(wallTime)).toBe(minute);
    expect(toWallTime(minute)).toBe(wallTime);
  });

  it('wraps an overnight minute back onto the wall clock', () => {
    expect(toWallTime(1560)).toBe('02:00'); // 26:00 is 2am
    expect(toWallTime(1440)).toBe('00:00');
  });

  it.each(['9:00', '09:0', '25:00', '09:60', '', 'noon'])('refuses %s', (bad) => {
    expect(() => toDayMinute(bad)).toThrow(InvalidAvailability);
  });
});

describe('AVAIL-01 — window validation', () => {
  it('accepts an ordinary window', () => {
    expect(win('09:00', '17:00')).toMatchObject({ openMin: 540, closeMin: 1020 });
  });

  // Never swapped, never silently empty: both plausible repairs invent hours
  // the provider never agreed to work.
  it('REFUSES close <= open without endsNextDay', () => {
    expect(() => win('17:00', '09:00')).toThrow(InvalidAvailability);
    expect(() => win('09:00', '09:00')).toThrow(InvalidAvailability);
  });

  it('accepts an overnight window and carries it past 1440', () => {
    const w = win('20:00', '02:00', true);
    expect(w.openMin).toBe(1200);
    expect(w.closeMin).toBe(1560); // 26:00
  });

  it('refuses endsNextDay on a window that already ends the same day', () => {
    // 09:00–17:00 marked overnight would be a 32-hour shift — a mis-tick.
    expect(() => win('09:00', '17:00', true)).toThrow(InvalidAvailability);
  });

  it('accepts breaks inside the window and sorts them', () => {
    const w = win('09:00', '17:00', false, [
      { open: '15:00', close: '15:15' },
      { open: '12:00', close: '13:00' },
    ]);
    expect(breaksOf(w)).toEqual(['12:00-13:00', '15:00-15:15']);
  });

  // A break belongs to the WINDOW, not the day (AVAIL-01). Dropping an
  // out-of-range one silently is how a provider becomes bookable through her
  // own lunch.
  it('REFUSES a break outside its window', () => {
    expect(() => win('09:00', '17:00', false, [{ open: '18:00', close: '19:00' }])).toThrow(InvalidAvailability);
    expect(() => win('09:00', '17:00', false, [{ open: '08:00', close: '09:30' }])).toThrow(InvalidAvailability);
  });

  it('refuses overlapping breaks in one window', () => {
    expect(() =>
      win('09:00', '17:00', false, [
        { open: '12:00', close: '13:00' },
        { open: '12:30', close: '13:30' },
      ]),
    ).toThrow(InvalidAvailability);
  });

  it('handles a break on the far side of midnight in an overnight window', () => {
    const w = win('20:00', '02:00', true, [{ open: '00:30', close: '01:00' }]);
    expect(breaksOf(w)).toEqual(['00:30-01:00']);
    expect(w.breaks[0]!.openMin).toBe(1470); // lifted past midnight, still inside
  });

  it('handles a break that itself crosses midnight', () => {
    const w = win('20:00', '02:00', true, [{ open: '23:30', close: '00:30' }]);
    expect(w.breaks[0]).toEqual({ openMin: 1410, closeMin: 1470 });
  });
});

describe('unionWindows', () => {
  it('merges overlapping and touching windows', () => {
    expect(asText(unionWindows([win('09:00', '12:00'), win('11:00', '15:00')]))).toEqual(['09:00-15:00']);
    expect(asText(unionWindows([win('09:00', '12:00'), win('12:00', '15:00')]))).toEqual(['09:00-15:00']);
  });

  it('keeps a genuine gap — a split shift stays two windows', () => {
    expect(asText(unionWindows([win('09:00', '12:00'), win('15:00', '19:00')]))).toEqual([
      '09:00-12:00',
      '15:00-19:00',
    ]);
  });

  it('is order-insensitive', () => {
    const a = unionWindows([win('15:00', '19:00'), win('09:00', '12:00')]);
    const b = unionWindows([win('09:00', '12:00'), win('15:00', '19:00')]);
    expect(asText(a)).toEqual(asText(b));
  });
});

describe('AVAIL-04 — business ∩ provider', () => {
  it('clips the provider to the business hours', () => {
    const result = intersectWindows([win('09:00', '18:00')], [win('08:00', '20:00')]);
    expect(asText(result)).toEqual(['09:00-18:00']);
  });

  it('is empty when they do not overlap', () => {
    expect(intersectWindows([win('09:00', '12:00')], [win('13:00', '17:00')])).toEqual([]);
  });

  it('keeps breaks from BOTH sides, clipped to the intersection', () => {
    const business = [win('09:00', '18:00', false, [{ open: '13:00', close: '14:00' }])];
    const provider = [win('08:00', '17:00', false, [{ open: '12:00', close: '12:30' }])];
    const [result] = intersectWindows(business, provider);
    expect(breaksOf(result!)).toEqual(['12:00-12:30', '13:00-14:00']);
  });

  it('handles a provider split shift against one business window', () => {
    const result = intersectWindows([win('09:00', '18:00')], [win('09:00', '12:00'), win('15:00', '19:00')]);
    expect(asText(result)).toEqual(['09:00-12:00', '15:00-18:00']);
  });
});

describe('AVAIL-02 — an override REPLACES the weekly pattern', () => {
  const weekly = [win('09:00', '17:00')];

  it('uses the weekly pattern when there is no override', () => {
    expect(asText(effectiveWindows({ weekly, override: null }))).toEqual(['09:00-17:00']);
  });

  // Never merges. "Open 10–2 on Christmas Eve" means exactly 10–2.
  it('replaces, never merges, when an override exists', () => {
    const pattern: DayPattern = { weekly, override: { isClosed: false, windows: [win('10:00', '14:00')] } };
    expect(asText(effectiveWindows(pattern))).toEqual(['10:00-14:00']);
  });

  // isClosed with no windows is REPRESENTABLE and DISTINCT from "no override".
  it('is closed for an isClosed override, even though a weekly pattern exists', () => {
    const pattern: DayPattern = { weekly, override: { isClosed: true, windows: [] } };
    expect(effectiveWindows(pattern)).toEqual([]);
  });

  it('distinguishes "closed" from "no override" — the two are not the same day', () => {
    const noOverride = effectiveWindows({ weekly, override: null });
    const closed = effectiveWindows({ weekly, override: { isClosed: true, windows: [] } });
    expect(noOverride).not.toEqual(closed);
    expect(noOverride).toHaveLength(1);
    expect(closed).toHaveLength(0);
  });
});

describe('resolveAvailableWindows — the whole wall-clock chain', () => {
  const openBusiness: DayPattern = { weekly: [win('09:00', '18:00')], override: null };

  it('returns the intersection on an ordinary day', () => {
    const provider: DayPattern = { weekly: [win('10:00', '19:00')], override: null };
    expect(asText(resolveAvailableWindows(openBusiness, provider))).toEqual(['10:00-18:00']);
  });

  // AVAIL-04's explicit acceptance criterion.
  it('A BUSINESS HOLIDAY CLOSES EVERY PROVIDER, whatever her own pattern says', () => {
    const closedBusiness: DayPattern = { weekly: [win('09:00', '18:00')], override: { isClosed: true, windows: [] } };
    const provider: DayPattern = { weekly: [win('09:00', '17:00')], override: null };
    expect(resolveAvailableWindows(closedBusiness, provider)).toEqual([]);
  });

  it('a provider day off closes only her', () => {
    const provider: DayPattern = { weekly: [win('09:00', '17:00')], override: { isClosed: true, windows: [] } };
    expect(resolveAvailableWindows(openBusiness, provider)).toEqual([]);
  });

  it('is empty when the business has no weekly pattern for the day (a closed Sunday)', () => {
    expect(resolveAvailableWindows({ weekly: [], override: null }, { weekly: [win('09:00', '17:00')], override: null })).toEqual([]);
  });

  it('lets a provider override extend past her weekly hours, still clipped by the business', () => {
    const provider: DayPattern = { weekly: [win('09:00', '12:00')], override: { isClosed: false, windows: [win('09:00', '20:00')] } };
    expect(asText(resolveAvailableWindows(openBusiness, provider))).toEqual(['09:00-18:00']);
  });

  it('lets a business override extend the day for everyone', () => {
    const lateNight: DayPattern = { weekly: [win('09:00', '18:00')], override: { isClosed: false, windows: [win('09:00', '22:00')] } };
    const provider: DayPattern = { weekly: [win('09:00', '21:00')], override: null };
    expect(asText(resolveAvailableWindows(lateNight, provider))).toEqual(['09:00-21:00']);
  });
});

describe('toWindowInput — back to the shape SlotQuery wants', () => {
  it('round-trips an ordinary window', () => {
    expect(toWindowInput(win('09:00', '17:00', false, [{ open: '12:00', close: '13:00' }]))).toEqual({
      open: '09:00',
      close: '17:00',
      endsNextDay: false,
      breaks: [{ open: '12:00', close: '13:00' }],
    });
  });

  it('marks an overnight window endsNextDay and wraps its close', () => {
    expect(toWindowInput(win('20:00', '02:00', true))).toEqual({
      open: '20:00',
      close: '02:00',
      endsNextDay: true,
      breaks: [],
    });
  });
});
