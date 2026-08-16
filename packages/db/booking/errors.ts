import type { Slot } from '../../core/scheduling';

/**
 * The slot is gone (BOOK-02) — HTTP 409, never a 500.
 *
 * Carries REFRESHED ALTERNATIVES, because "that time was just taken" with no
 * next step is the moment a customer closes the tab and rings instead. The
 * alternatives are recomputed AFTER the failure, so they reflect the state
 * that actually caused it rather than the stale list the customer was looking
 * at.
 */
export class SlotTaken extends Error {
  readonly alternatives: Slot[];
  constructor(alternatives: Slot[]) {
    super('That time has just been taken.');
    this.name = 'SlotTaken';
    this.alternatives = alternatives;
  }
}

/** The requested start is not a slot this provider is offering — outside
 *  hours, inside a break, in the past, inside the lead time. Distinct from
 *  SlotTaken: nobody took it, it was never on offer. Staff may override
 *  (BOOK-05); customers never can. */
export class SlotNotOffered extends Error {
  readonly reasons: readonly string[];
  readonly alternatives: Slot[];
  constructor(reasons: readonly string[], alternatives: Slot[]) {
    super(`That time is not available (${reasons.join(', ') || 'not offered'}).`);
    this.name = 'SlotNotOffered';
    this.reasons = reasons;
    this.alternatives = alternatives;
  }
}

/** The booking was refused for a reason that is the caller's fault and not a
 *  race — a customer trying to override, a missing reason on a staff
 *  override, a start that is not on a whole minute. */
export class BookingRejected extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'BookingRejected';
    this.field = field;
  }
}
