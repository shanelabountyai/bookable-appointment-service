/**
 * Service and qualification-override validation (SVC-01, SVC-02). Pure: no
 * database. Cutoff validation is `validateServiceCutoff` in policy.ts — this
 * module owns the rest of the service's own fields plus the per-provider
 * override fields.
 */
import type { PolicyViolation } from './policy';

export interface ServiceInput {
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceCents: number;
}

const isPositiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;
const isNonNegativeInt = (n: number): boolean => Number.isInteger(n) && n >= 0;

/**
 * Validates a service's OWN fields. Does not touch the cutoff — call
 * `validateServiceCutoff` (policy.ts) separately with the business policy,
 * because that check needs context this function deliberately does not take.
 */
export function validateService(input: ServiceInput): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  if (input.name.trim().length === 0) {
    violations.push({ field: 'name', message: 'A service needs a name.' });
  }
  if (!isPositiveInt(input.durationMinutes)) {
    violations.push({ field: 'durationMinutes', message: 'Duration must be a whole number of minutes above zero.' });
  }
  if (!isNonNegativeInt(input.bufferBeforeMinutes)) {
    violations.push({ field: 'bufferBeforeMinutes', message: 'Buffer before must be zero or a whole number of minutes.' });
  }
  if (!isNonNegativeInt(input.bufferAfterMinutes)) {
    violations.push({ field: 'bufferAfterMinutes', message: 'Buffer after must be zero or a whole number of minutes.' });
  }
  // Zero is a legitimate price (a complimentary consult), so >= 0, not > 0.
  if (!isNonNegativeInt(input.priceCents)) {
    violations.push({ field: 'priceCents', message: 'Price must be zero or a whole number of cents.' });
  }

  return violations;
}

export interface QualificationOverrideInput {
  durationOverrideMinutes: number | null;
  priceOverrideCents: number | null;
}

/**
 * Validates a provider's override on one service (SVC-02). Both fields are
 * independently optional — a provider can override just the price (a senior
 * stylist charges more for the identical cut) or just the duration (a junior
 * stylist needs longer), or both, or neither.
 */
export function validateQualificationOverride(input: QualificationOverrideInput): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  if (input.durationOverrideMinutes !== null && !isPositiveInt(input.durationOverrideMinutes)) {
    violations.push({
      field: 'durationOverrideMinutes',
      message: 'Duration override must be a whole number of minutes above zero.',
    });
  }
  if (input.priceOverrideCents !== null && !isNonNegativeInt(input.priceOverrideCents)) {
    violations.push({ field: 'priceOverrideCents', message: 'Price override must be zero or a whole number of cents.' });
  }
  return violations;
}

/** The duration slot computation actually uses for this provider×service
 *  pair (SVC-02): the override when qualified with one, the base otherwise. */
export function effectiveDurationMinutes(base: number, overrideMinutes: number | null | undefined): number {
  return overrideMinutes ?? base;
}

/** The price a booking for this provider×service pair is charged (feeds
 *  D-18's snapshot at booking time — this function is the "what would it be
 *  right now" half; the snapshot itself is A-009's job). */
export function effectivePriceCents(base: number, overrideCents: number | null | undefined): number {
  return overrideCents ?? base;
}
