import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATUSES,
  AWAITING_START_STATUSES,
  CONSUMED_STATUSES,
  PUSHABLE_STATUSES,
  SLOT_FREEING_STATUSES,
  STILL_ON_THEIR_WAY_STATUSES,
  TERMINAL_STATUSES,
  isAwaitingStart,
  isPushable,
  isStillOnTheirWay,
} from './status';

/**
 * A-086. The derivation, pinned — so a ninth status cannot land in the
 * utilization numerator by simply being added to the enum.
 *
 * The first assertion is the one that fails: it names today's answer out
 * loud, so anyone adding a status has to come here and DECIDE whether the
 * salon spent that hour, rather than inheriting whichever list happened to
 * include it.
 */
describe('CONSUMED_STATUSES — the hours the salon actually spent', () => {
  it('is exactly the two settled statuses that still occupy their time', () => {
    expect(CONSUMED_STATUSES).toEqual(['completed', 'no_show']);
  });

  it('is terminal AND active — both halves, neither list on its own', () => {
    for (const status of CONSUMED_STATUSES) {
      expect(TERMINAL_STATUSES).toContain(status);
      expect(ACTIVE_STATUSES).toContain(status);
    }
    for (const freed of SLOT_FREEING_STATUSES) {
      expect(CONSUMED_STATUSES as readonly string[]).not.toContain(freed);
    }
  });
});

/**
 * A-090. THE THREE LISTS ONE RUNNING-LATE COLUMN ASKS, pinned against each
 * other rather than each on its own.
 *
 * This is the assertion the defect needed. Before this item the chip's question
 * was not a list at all — `view-model.ts` hand-typed `status === 'booked'`,
 * twice — so the three answers could not be compared, and a CONFIRMED client
 * sat on the desk's call list as "booked 14:00, likely 14:40" while her chip on
 * the same screen showed 14:00 and nothing else.
 *
 * The nesting is the invariant, and each boundary is a separate operational
 * fact rather than a coincidence:
 *
 *   ring her  ⊂  project a later start onto her  ⊂  a push may move her
 *
 * `checked_in` is the first boundary: she is in the building, so nobody rings
 * her, and the desk still tells her to her face when she will go in.
 * `in_progress` is the second: she is in the chair, so a push still moves the
 * row and a projected START on it is not late — it is wrong.
 */
describe('the three lists a running-late column asks', () => {
  it('names each one out loud, so a ninth status has to be DECIDED into them', () => {
    expect(STILL_ON_THEIR_WAY_STATUSES).toEqual(['booked', 'confirmed']);
    expect(AWAITING_START_STATUSES).toEqual(['booked', 'confirmed', 'checked_in']);
    expect(PUSHABLE_STATUSES).toEqual(['booked', 'confirmed', 'checked_in', 'in_progress']);
  });

  it('nests: anybody worth ringing is projected, and anybody projected is pushable', () => {
    for (const status of STILL_ON_THEIR_WAY_STATUSES) {
      expect(AWAITING_START_STATUSES as readonly string[]).toContain(status);
    }
    for (const status of AWAITING_START_STATUSES) {
      expect(PUSHABLE_STATUSES as readonly string[]).toContain(status);
    }
  });

  it('draws its two boundaries where the salon does', () => {
    // In the building, not on the phone list, still told when she goes in.
    expect(isStillOnTheirWay('checked_in')).toBe(false);
    expect(isAwaitingStart('checked_in')).toBe(true);
    // In the chair: the push still moves her row, and no start is projected.
    expect(isAwaitingStart('in_progress')).toBe(false);
    expect(isPushable('in_progress')).toBe(true);
  });

  it('projects onto nothing that has finished, one way or another', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isAwaitingStart(status)).toBe(false);
    }
  });
});
