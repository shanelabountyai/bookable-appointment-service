/**
 * A-015's pure half (CLIENT-01, CLIENT-02).
 */
import { describe, expect, it } from 'vitest';
import { calendarDay } from '../time';
import { isPlausiblePhone } from './phone';
import { DEFAULT_REBOOK_INTERVAL_DAYS, naturalIntervalDays } from './rebook';

// What a number is STORED as is the database's (D-55) and is tested against it
// in packages/db/clients/identity.test.ts — this is only whether the form may
// be submitted.
describe('isPlausiblePhone (CLIENT-01)', () => {
  it('accepts a local number without an area code, however it is punctuated', () => {
    expect(isPlausiblePhone('555-0101')).toBe(true);
    expect(isPlausiblePhone('+1 (512) 555-0101')).toBe(true);
  });

  it('refuses too few digits, and words with none', () => {
    expect(isPlausiblePhone('5550')).toBe(false);
    expect(isPlausiblePhone('call the salon')).toBe(false);
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
