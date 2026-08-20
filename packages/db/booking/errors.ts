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

/**
 * CLIENT-04's lever: this client may not book HERSELF (D-27).
 *
 * Deliberately its own error and not a `BookingRejected`, because the two need
 * opposite handling: a rejected booking is a form to fix, and this one is a
 * phone call to make — "please call the salon" is the only next step, and the
 * public surface must not offer to retry.
 *
 * Carries the counts for the STAFF-facing log and tests, never for the
 * customer's screen: telling an anonymous visitor how many times the person
 * holding this phone number has missed appointments is an information leak
 * (spec §1.3) — the number does not identify her to us, but our answer
 * identifies her to whoever is typing it.
 */
export class SelfServeBlocked extends Error {
  readonly noShows: number;
  readonly threshold: number;
  constructor(noShows: number, threshold: number) {
    super('This appointment cannot be booked online.');
    this.name = 'SelfServeBlocked';
    this.noShows = noShows;
    this.threshold = threshold;
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

/**
 * RES-03 — every chair of the required type is taken for this envelope.
 *
 * Distinct from `SlotTaken` because the answer to it is different: the provider
 * IS free, so offering the customer a different time for the same stylist is
 * right, while telling staff "the room is full" is what lets them decide to
 * override (RES-04). Both map to 409; only the wording differs.
 */
export class NoResourceFree extends Error {
  readonly resourceTypeName: string;
  constructor(resourceTypeName: string) {
    super(`Every ${resourceTypeName} is taken for that time.`);
    this.name = 'NoResourceFree';
    this.resourceTypeName = resourceTypeName;
  }
}
