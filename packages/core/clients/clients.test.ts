/**
 * A-015's pure half (CLIENT-01, CLIENT-02).
 */
import { describe, expect, it } from 'vitest';
import { calendarDay } from '../time';
import { isPlausiblePhone, normalizePhone } from './phone';
import { DEFAULT_REBOOK_INTERVAL_DAYS, naturalIntervalDays } from './rebook';

describe('normalizePhone (CLIENT-01)', () => {
  // The case that matters: the same person typing it two ways at two different
  // moments — once on her phone at home, once read out to the front desk.
  it('makes the same number out of every way a human writes it', () => {
    const written = ['(512) 555-0101', '512-555-0101', '512.555.0101', '512 555 0101', '5125550101'];
    expect(new Set(written.map(normalizePhone))).toEqual(new Set(['5125550101']));
  });

  it('keeps a leading + and nothing else', () => {
    expect(normalizePhone('+1 (512) 555-0101')).toBe('+15125550101');
    // Without the +, this is indistinguishable from a local number starting 1.
    expect(normalizePhone('1 (512) 555-0101')).toBe('15125550101');
  });

  it('is idempotent, so re-normalizing a stored number changes nothing', () => {
    const once = normalizePhone('(512) 555-0101');
    expect(normalizePhone(once)).toBe(once);
  });

  it('returns empty for input with no digits, rather than guessing', () => {
    expect(normalizePhone('   ')).toBe('');
    expect(normalizePhone('call the salon')).toBe('');
  });

  it('accepts a local number without an area code', () => {
    expect(isPlausiblePhone(normalizePhone('555-0101'))).toBe(true);
    expect(isPlausiblePhone(normalizePhone('5550'))).toBe(false);
  });
});

describe('naturalIntervalDays (CLIENT-02)', () => {
  const day = (value: string) => calendarDay(value);

  it('reads her own rhythm from the last two visits', () => {
    // Six weeks between colours is a fact about her hair, not about the salon.
    expect(naturalIntervalDays([day('2026-06-09'), day('2026-04-28')])).toBe(42);
  });

  /**
   * A rhythm is measured on the CALENDAR, and this pair spans a spring-forward.
   * Six calendar weeks is 42 days; the same span in physical milliseconds is
   * 41 days 23 hours, which floors to 41 and would drift the suggestion a day
   * earlier every spring.
   */
  it('counts calendar days across a DST transition, not 24-hour blocks', () => {
    expect(naturalIntervalDays([day('2026-04-12'), day('2026-03-01')])).toBe(42);
  });

  it('falls back to the default when she has only ever been once', () => {
    expect(naturalIntervalDays([day('2026-06-09')])).toBe(DEFAULT_REBOOK_INTERVAL_DAYS);
    expect(naturalIntervalDays([])).toBe(DEFAULT_REBOOK_INTERVAL_DAYS);
  });

  it('ignores a same-day pair — that is one visit booked as two, not a rhythm', () => {
    expect(naturalIntervalDays([day('2026-06-09'), day('2026-06-09')])).toBe(DEFAULT_REBOOK_INTERVAL_DAYS);
  });

  it('ignores an out-of-order pair rather than suggesting a negative interval', () => {
    expect(naturalIntervalDays([day('2026-04-28'), day('2026-06-09')])).toBe(DEFAULT_REBOOK_INTERVAL_DAYS);
  });
});
