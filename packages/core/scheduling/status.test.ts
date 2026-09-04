import { describe, expect, it } from 'vitest';
import { ACTIVE_STATUSES, CONSUMED_STATUSES, SLOT_FREEING_STATUSES, TERMINAL_STATUSES } from './status';

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
