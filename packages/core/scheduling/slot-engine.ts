import type { SlotQuery, SlotResult } from './types';

export class NotImplementedError extends Error {
  constructor() {
    super(
      'computeSlots is not implemented yet. This is backlog item A-008 — ' +
        'build it TDD against slot-engine.test.ts, then extend to the full matrix in ' +
        'docs/reviews/03-slot-engine-spec.md. Prerequisites: A-002 (packages/core/time) ' +
        'and the A-003 schema decisions it consumes.',
    );
    this.name = 'NotImplementedError';
  }
}

/**
 * The core learning artifact (00-master-prd.md SLOT-01..08).
 *
 * PURE FUNCTION. No I/O, no Date.now(), no process.env, no Intl call that reads
 * the system zone. `now` is a parameter. Identical output under any process TZ.
 *
 * Implementation guidance (spec §5): use Temporal (temporal-polyfill) ONLY to
 * resolve window opens/closes/breaks to Instants at the boundary — a handful of
 * calls per provider-day — then do ALL grid iteration, overlap testing, and
 * buffer arithmetic on plain epoch-millisecond integers. The physical axis has
 * no DST; integer arithmetic on it is DST-proof by construction.
 */
export function computeSlots(_query: SlotQuery): SlotResult {
  throw new NotImplementedError();
}
