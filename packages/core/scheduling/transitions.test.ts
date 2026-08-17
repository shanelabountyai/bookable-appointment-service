/**
 * A-012 — the §7 transition table, every cell (APPT-01).
 *
 * The grid below is TRANSCRIBED FROM THE PRD, not derived from the
 * implementation. That is the whole point: a parameterised test that walks the
 * implementation's own data structure proves only that the structure is
 * self-consistent. Reading it beside `00-master-prd.md` §7 should be a
 * line-by-line diff by eye.
 *
 * Every one of the 64 ordered pairs is asserted, including the diagonal and
 * including `booked` as a destination — "nothing transitions back to booked"
 * is a rule, and a rule nobody tests is a rule that quietly stops being true.
 */
import { describe, expect, it } from 'vitest';
import {
  CORRECTION_WINDOW_MS,
  type TransitionContext,
  canReschedule,
  canTransition,
  isCorrection,
  possibleTransitionsFrom,
} from './transitions';
import { APPOINTMENT_STATUSES } from './status';
import { instant } from './types';
import type { ActorType } from '../auth';

/**
 * §7, transcribed.
 *
 *   ·       refused for everyone
 *   -       the diagonal (same status)
 *   S       staff only
 *   S,C     staff or customer token
 *   S*      staff only, and only after startAt
 *   S,C-out staff any time; customer only OUTSIDE the cutoff
 *   S,C-in  staff any time; customer only INSIDE the cutoff
 *   S+r     staff only, reason required
 *   S7r     staff only, within 7 days of end, reason required
 */
const SECTION_7 = `
from           | booked | confirmed | checked_in | in_progress | completed | no_show | cancelled | cancelled_late
booked         | -      | S,C       | S          | S           | ·         | S*      | S,C-out   | S,C-in
confirmed      | ·      | -         | S          | S           | ·         | S*      | S,C-out   | S,C-in
checked_in     | ·      | ·         | -          | S           | S         | ·       | S         | ·
in_progress    | ·      | ·         | ·          | -           | S         | ·       | S+r       | ·
completed      | ·      | ·         | ·          | ·           | -         | S7r     | ·         | ·
no_show        | ·      | ·         | ·          | ·           | S7r       | -       | ·         | ·
cancelled      | ·      | ·         | ·          | ·           | ·         | ·       | -         | ·
cancelled_late | ·      | ·         | ·          | ·           | ·         | ·       | ·         | -
`;

type Cell = '·' | '-' | 'S' | 'S,C' | 'S*' | 'S,C-out' | 'S,C-in' | 'S+r' | 'S7r';

const GRID: Record<string, Record<string, Cell>> = (() => {
  const rows = SECTION_7.trim()
    .split('\n')
    .map((line) => line.split('|').map((c) => c.trim()));
  const [header, ...body] = rows;
  const columns = header!.slice(1);
  const grid: Record<string, Record<string, Cell>> = {};
  for (const row of body) {
    grid[row[0]!] = Object.fromEntries(columns.map((col, i) => [col, row[i + 1] as Cell]));
  }
  return grid;
})();

const ACTORS: ActorType[] = ['staff', 'customer_token', 'system'];

const START = instant(Date.UTC(2026, 5, 9, 15, 0)); // 10:00 Chicago
const END = instant(Date.UTC(2026, 5, 9, 16, 0));
const CUTOFF = 24 * 60; // minutes

/** A context in which every precondition is SATISFIED, so a cell's baseline
 *  answer reflects the table rather than the clock. */
const permissive = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  actor: 'staff',
  // After the start (satisfies `after-start`), inside the correction window,
  // and inside the cutoff.
  now: instant(END + 60_000),
  startAt: START,
  endAt: END,
  cancellationCutoffMinutes: CUTOFF,
  reason: 'a reason',
  ...over,
});

/** Which actors the grid says may perform this transition when every
 *  precondition is met. */
function actorsAllowedBy(cell: Cell): ActorType[] {
  switch (cell) {
    case '·':
    case '-':
      return [];
    case 'S':
    case 'S*':
    case 'S+r':
    case 'S7r':
      return ['staff'];
    case 'S,C':
    case 'S,C-in':
      return ['staff', 'customer_token'];
    case 'S,C-out':
      // The customer arm needs the OUTSIDE-cutoff clock, which the permissive
      // context deliberately does not provide; asserted separately below.
      return ['staff'];
  }
}

describe('§7 — every ordered pair of statuses', () => {
  const pairs = APPOINTMENT_STATUSES.flatMap((from) => APPOINTMENT_STATUSES.map((to) => [from, to] as const));

  it('covers all 64 ordered pairs', () => {
    expect(pairs).toHaveLength(64);
  });

  /**
   * The tripwire for a ninth status.
   *
   * Adding one to `status.ts` without adding its row and column here would
   * otherwise make the parameterised test above look up `undefined` and fail
   * with something unreadable about `.includes`. This fails first, and says
   * what to do.
   */
  it('has a row and a column in the transcribed table for every status', () => {
    expect(Object.keys(GRID).sort()).toEqual([...APPOINTMENT_STATUSES].sort());
    for (const from of APPOINTMENT_STATUSES) {
      expect(Object.keys(GRID[from]!).sort(), `row "${from}" is missing columns`).toEqual(
        [...APPOINTMENT_STATUSES].sort(),
      );
    }
  });

  it.each(pairs)('%s -> %s matches the PRD', (from, to) => {
    const cell = GRID[from]![to]!;
    const expected = actorsAllowedBy(cell);

    for (const actor of ACTORS) {
      const decision = canTransition(from, to, permissive({ actor }));
      expect(decision.allowed, `${from} -> ${to} as ${actor} (table says "${cell}")`).toBe(expected.includes(actor));
    }
  });

  it.each(APPOINTMENT_STATUSES)('%s refuses a transition to itself as same-status', (status) => {
    const decision = canTransition(status, status, permissive());
    expect(decision).toEqual({ allowed: false, refusal: 'same-status' });
  });

  it.each(APPOINTMENT_STATUSES)('nothing transitions back to booked (from %s)', (from) => {
    if (from === 'booked') return;
    for (const actor of ACTORS) {
      expect(canTransition(from, 'booked', permissive({ actor })).allowed).toBe(false);
    }
  });

  // The system actor exists (D-9) and is deliberately powerless here: no
  // automatic transition is in v1. If one is ever added this test is the
  // reminder to decide it on purpose.
  it('never permits the system actor to change a status', () => {
    for (const from of APPOINTMENT_STATUSES) {
      for (const to of APPOINTMENT_STATUSES) {
        expect(canTransition(from, to, permissive({ actor: 'system' })).allowed).toBe(false);
      }
    }
  });
});

describe('preconditions refuse for the RIGHT reason', () => {
  // CLAUDE.md: an absence assertion that does not check the reason passes for
  // a dozen wrong reasons.

  it('refuses no_show before the appointment has started', () => {
    const decision = canTransition('booked', 'no_show', permissive({ now: instant(START - 1) }));
    expect(decision).toEqual({ allowed: false, refusal: 'before-appointment-start' });
  });

  it('allows no_show exactly at the start instant', () => {
    expect(canTransition('booked', 'no_show', permissive({ now: START })).allowed).toBe(true);
  });

  it('refuses a customer cancelling inside the cutoff, naming the cutoff', () => {
    const decision = canTransition('booked', 'cancelled', permissive({ actor: 'customer_token' }));
    expect(decision).toEqual({ allowed: false, refusal: 'inside-cancellation-cutoff' });
  });

  it('lets the customer cancel outside the cutoff', () => {
    const wellBefore = instant(START - (CUTOFF + 1) * 60_000);
    expect(canTransition('booked', 'cancelled', permissive({ actor: 'customer_token', now: wellBefore })).allowed).toBe(
      true,
    );
  });

  // APPT-05: inside the cutoff the customer is not blocked outright — the
  // cancellation is RECLASSIFIED as late. Refusing entirely would just produce
  // a no-show instead, which is strictly worse for the salon.
  it('lets the customer cancel LATE inside the cutoff', () => {
    expect(canTransition('booked', 'cancelled_late', permissive({ actor: 'customer_token' })).allowed).toBe(true);
  });

  it('refuses a customer marking a cancellation late when they are outside the cutoff', () => {
    const wellBefore = instant(START - (CUTOFF + 1) * 60_000);
    const decision = canTransition('booked', 'cancelled_late', permissive({ actor: 'customer_token', now: wellBefore }));
    expect(decision).toEqual({ allowed: false, refusal: 'outside-cancellation-cutoff' });
  });

  it('treats the cutoff boundary itself as inside, toward the salon', () => {
    const exactly = instant(START - CUTOFF * 60_000);
    expect(canTransition('booked', 'cancelled', permissive({ actor: 'customer_token', now: exactly }))).toEqual({
      allowed: false,
      refusal: 'inside-cancellation-cutoff',
    });
    expect(canTransition('booked', 'cancelled_late', permissive({ actor: 'customer_token', now: exactly })).allowed).toBe(
      true,
    );
  });

  it('lets staff cancel inside the cutoff, at any time', () => {
    expect(canTransition('booked', 'cancelled', permissive({ actor: 'staff' })).allowed).toBe(true);
  });
});

describe('APPT-06 — terminal corrections', () => {
  it('allows the correction at exactly seven days after the end', () => {
    const at7d = instant(END + CORRECTION_WINDOW_MS);
    expect(canTransition('no_show', 'completed', permissive({ now: at7d })).allowed).toBe(true);
  });

  it('refuses it one millisecond later', () => {
    const past = instant(END + CORRECTION_WINDOW_MS + 1);
    expect(canTransition('no_show', 'completed', permissive({ now: past }))).toEqual({
      allowed: false,
      refusal: 'correction-window-closed',
    });
  });

  it.each([
    ['no_show', 'completed'],
    ['completed', 'no_show'],
  ] as const)('refuses %s -> %s without a reason', (from, to) => {
    expect(canTransition(from, to, permissive({ reason: '   ' }))).toEqual({
      allowed: false,
      refusal: 'reason-required',
    });
  });

  it('refuses the correction to a customer token even with a reason', () => {
    expect(canTransition('no_show', 'completed', permissive({ actor: 'customer_token' }))).toEqual({
      allowed: false,
      refusal: 'actor-not-permitted',
    });
  });

  it('flags terminal-to-terminal moves as corrections, and others not', () => {
    expect(isCorrection('no_show', 'completed')).toBe(true);
    expect(isCorrection('completed', 'no_show')).toBe(true);
    expect(isCorrection('booked', 'confirmed')).toBe(false);
    expect(isCorrection('in_progress', 'completed')).toBe(false);
    const decision = canTransition('no_show', 'completed', permissive());
    expect(decision).toEqual({ allowed: true, isCorrection: true });
  });

  // A cancellation released the slot and it may already be resold — so
  // "un-cancelling" is a new booking, not a transition.
  it.each(['cancelled', 'cancelled_late'] as const)('gives %s no outgoing transitions at all', (from) => {
    expect(possibleTransitionsFrom(from)).toEqual([]);
  });
});

describe('the walk-out', () => {
  it('refuses cancelling an in-progress appointment without a reason', () => {
    expect(canTransition('in_progress', 'cancelled', permissive({ reason: null }))).toEqual({
      allowed: false,
      refusal: 'reason-required',
    });
  });

  it('allows it with one', () => {
    expect(canTransition('in_progress', 'cancelled', permissive({ reason: 'client walked out' })).allowed).toBe(true);
  });

  // A walk-out mid-service is never a LATE cancellation — that column is for
  // notice, and there is no notice once the client is in the chair.
  it('does not offer cancelled_late from in_progress', () => {
    expect(possibleTransitionsFrom('in_progress')).toEqual(['completed', 'cancelled']);
  });
});

describe('refusals distinguish "never" from "not by you"', () => {
  it('says not-permitted for a cell that is closed to everyone', () => {
    expect(canTransition('checked_in', 'no_show', permissive())).toEqual({
      allowed: false,
      refusal: 'not-permitted',
    });
  });

  it('says actor-not-permitted for a cell open to staff only', () => {
    expect(canTransition('booked', 'checked_in', permissive({ actor: 'customer_token' }))).toEqual({
      allowed: false,
      refusal: 'actor-not-permitted',
    });
  });
});

/**
 * A-014's reschedule table (D-6, APPT-05).
 *
 * Transcribed the same way as §7 above and for the same reason: a test that
 * walks the implementation's own `RESCHEDULABLE` map proves only that the map
 * is consistent with itself, and would confirm a wrong one just as cheerfully.
 *
 *   ·        nobody may move it
 *   S,C-out  staff any time; customer only OUTSIDE the cancellation cutoff
 */
const RESCHEDULE_TABLE = `
booked         | S,C-out
confirmed      | S,C-out
checked_in     | ·
in_progress    | ·
completed      | ·
no_show        | ·
cancelled      | ·
cancelled_late | ·
`;

const RESCHEDULE_GRID: Record<string, string> = Object.fromEntries(
  RESCHEDULE_TABLE.trim()
    .split('\n')
    .map((line) => line.split('|').map((c) => c.trim()))
    .map(([status, cell]) => [status!, cell!]),
);

describe('D-6 — which appointments may be moved', () => {
  it('has a row for every status, so a ninth state forces a decision', () => {
    expect(Object.keys(RESCHEDULE_GRID).sort()).toEqual([...APPOINTMENT_STATUSES].sort());
  });

  // OUTSIDE the cutoff: the customer arm is open where the table says so.
  const outside = (over: Partial<TransitionContext> = {}) =>
    permissive({ now: instant(START - (CUTOFF + 1) * 60_000), ...over });

  it.each(APPOINTMENT_STATUSES)('staff may move %s exactly as the table says', (status) => {
    const expected = RESCHEDULE_GRID[status] !== '·';
    expect(canReschedule(status, outside({ actor: 'staff' })).allowed).toBe(expected);
  });

  it.each(APPOINTMENT_STATUSES)('a customer may move %s only where the table says, outside the cutoff', (status) => {
    const expected = RESCHEDULE_GRID[status] === 'S,C-out';
    expect(canReschedule(status, outside({ actor: 'customer_token' })).allowed).toBe(expected);
  });

  it.each(APPOINTMENT_STATUSES)('the system actor may never move %s', (status) => {
    expect(canReschedule(status, outside({ actor: 'system' })).allowed).toBe(false);
  });

  /**
   * APPT-05, and the reason this item exists at all: "a reschedule is a
   * cancellation with extra steps". Without this clause the cutoff is
   * decorative — a customer inside it just moves the appointment to next month
   * and abandons it, and the salon has lost the slot with none of the record
   * a late cancellation leaves.
   */
  it('refuses a CUSTOMER inside the cutoff, and says why', () => {
    expect(canReschedule('booked', permissive({ actor: 'customer_token', now: instant(START - 60_000) }))).toEqual({
      allowed: false,
      refusal: 'inside-cancellation-cutoff',
    });
  });

  it('allows STAFF inside the cutoff — the front desk is not bound by it (D-11)', () => {
    expect(canReschedule('booked', permissive({ actor: 'staff', now: instant(START - 60_000) })).allowed).toBe(true);
  });

  // The boundary resolves toward the salon, decided once in `insideCutoff` and
  // shared with cancellation — exactly ON the cutoff counts as inside.
  it('treats exactly ON the cutoff as inside, for the customer', () => {
    const onTheBoundary = instant(START - CUTOFF * 60_000);
    expect(canReschedule('confirmed', permissive({ actor: 'customer_token', now: onTheBoundary }))).toEqual({
      allowed: false,
      refusal: 'inside-cancellation-cutoff',
    });
  });

  it('distinguishes "nobody may" from "not by you"', () => {
    expect(canReschedule('completed', outside({ actor: 'staff' }))).toEqual({
      allowed: false,
      refusal: 'not-permitted',
    });
    expect(canReschedule('booked', outside({ actor: 'system' }))).toEqual({
      allowed: false,
      refusal: 'actor-not-permitted',
    });
  });
});
