/**
 * A-020's pure half (CLIENT-04, D-27).
 */
import { describe, expect, it } from 'vitest';
import { calendarDay } from '../time';
import { reliabilityWindowStart, selfServeBlocked } from './reliability';

describe('reliabilityWindowStart (CLIENT-04)', () => {
  it('goes back a calendar year, to the same day', () => {
    expect(reliabilityWindowStart(calendarDay('2026-08-19'))).toBe('2025-08-19');
  });

  /**
   * The reason this is a year rather than 365 days. 2028 is a leap year, so
   * counting 365 days back from 2028-03-01 lands on 2027-03-02 and quietly
   * ages out a no-show that happened on the first — a client is blocked or
   * not blocked depending on which February the question is asked in.
   */
  it('is a year even when the year in between has 366 days', () => {
    expect(reliabilityWindowStart(calendarDay('2028-03-01'))).toBe('2027-03-01');
  });

  /** The one date with no counterpart. The year before a leap year is never
   *  itself a leap year, so 28 February is the only possible answer. */
  it('clamps 29 February to the 28th rather than throwing', () => {
    expect(reliabilityWindowStart(calendarDay('2028-02-29'))).toBe('2027-02-28');
  });
});

describe('selfServeBlocked (CLIENT-04)', () => {
  it('blocks at the threshold, not one past it', () => {
    expect(selfServeBlocked(2, 3)).toBe(false);
    expect(selfServeBlocked(3, 3)).toBe(true);
    expect(selfServeBlocked(4, 3)).toBe(true);
  });

  /**
   * THE TRAP. The settings form accepts 0 — the policy validator only demands
   * a non-negative integer — and the obvious `count >= threshold` then blocks
   * every client in the salon, including everyone who has never missed
   * anything. The owner turning the lever down to nothing would take the
   * booking page offline, and it would look like a website outage rather than
   * a setting.
   */
  it('treats a threshold of zero as OFF, not as "block everybody"', () => {
    expect(selfServeBlocked(0, 0)).toBe(false);
    expect(selfServeBlocked(9, 0)).toBe(false);
  });
});
