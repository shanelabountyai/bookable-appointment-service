/**
 * Business policy validation (D-11, D-19, D-21).
 *
 * Pure: no database, no framework. The rules live here so BOTH writers can
 * enforce the same ones — the settings form and the service form — because the
 * dangerous combination is only visible when you look at both at once.
 */

/** The invariant this module exists for, stated once. */
export const LEAD_VS_CUTOFF_RULE =
  'minimumLeadMinutes must be >= every cancellation cutoff in force (business, and each active service override)';

export interface BusinessPolicy {
  slotIntervalMinutes: number;
  minimumLeadMinutes: number;
  cancellationCutoffMinutes: number;
  noShowBlockThreshold: number;
  bookingHorizonDays: number;
  bufferMayOverlapBreak: boolean;
  bufferMayExtendPastClose: boolean;
  ambiguousLocalTime: 'offer-both' | 'offer-earlier-only';
}

/** Only what the rule needs: an active service and its optional override. */
export interface ServiceCutoff {
  id: string;
  name: string;
  /** null means "inherit the business cutoff" — distinct from zero. */
  cancellationCutoffMinutes: number | null;
}

export interface PolicyViolation {
  field: string;
  message: string;
}

const isPositiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;
const isNonNegativeInt = (n: number): boolean => Number.isInteger(n) && n >= 0;

/**
 * Validates the business policy, INCLUDING the cross-check against every
 * active service's cutoff override.
 *
 * THE TRAP THIS CLOSES (D-11, reopened by D-19, caught by the Milestone 1
 * operator review): D-11 pairs `minimumLeadMinutes` with the BUSINESS cutoff,
 * so a 120-minute lead and a 120-minute cutoff look fine. D-19 then let each
 * service override the cutoff. Set colour's cutoff to 24 hours — an entirely
 * reasonable setting for a service that blocks half a stylist's day — and a
 * client who books Saturday's colour at 8am for 10am is STRUCTURALLY UNABLE to
 * cancel it: she is already inside a cutoff she could never have been outside
 * of. She rings the salon, the desk cancels for her, and her record now carries
 * a late cancel she had no way to avoid — which counts toward the CLIENT-04
 * self-serve block. The product's own no-show lever punishes her for its
 * configuration.
 *
 * Checked against `max(business, ...services)` rather than the business value
 * alone, and enforced on BOTH write paths, because either one can create the
 * pair while looking locally valid.
 */
export function validateBusinessPolicy(
  policy: BusinessPolicy,
  activeServices: readonly ServiceCutoff[] = [],
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  if (!isPositiveInt(policy.slotIntervalMinutes)) {
    violations.push({ field: 'slotIntervalMinutes', message: 'Slot interval must be a whole number of minutes above zero.' });
  }
  if (!isNonNegativeInt(policy.minimumLeadMinutes)) {
    violations.push({ field: 'minimumLeadMinutes', message: 'Minimum lead time must be zero or a whole number of minutes.' });
  }
  if (!isNonNegativeInt(policy.cancellationCutoffMinutes)) {
    violations.push({ field: 'cancellationCutoffMinutes', message: 'Cancellation cutoff must be zero or a whole number of minutes.' });
  }
  if (!isNonNegativeInt(policy.noShowBlockThreshold)) {
    violations.push({ field: 'noShowBlockThreshold', message: 'No-show threshold must be zero or a whole number.' });
  }
  if (!isPositiveInt(policy.bookingHorizonDays)) {
    violations.push({ field: 'bookingHorizonDays', message: 'Booking horizon must be a whole number of days above zero.' });
  }
  if (policy.ambiguousLocalTime !== 'offer-both' && policy.ambiguousLocalTime !== 'offer-earlier-only') {
    violations.push({ field: 'ambiguousLocalTime', message: 'Ambiguous-time policy must be offer-both or offer-earlier-only.' });
  }

  // Only run the coupling check on values that are themselves well-formed —
  // otherwise a non-integer lead produces two confusing errors instead of one.
  if (isNonNegativeInt(policy.minimumLeadMinutes) && isNonNegativeInt(policy.cancellationCutoffMinutes)) {
    const worst = worstCutoff(policy.cancellationCutoffMinutes, activeServices);
    if (policy.minimumLeadMinutes < worst.minutes) {
      violations.push({
        field: worst.source === 'business' ? 'cancellationCutoffMinutes' : 'minimumLeadMinutes',
        message: cutoffTrapMessage(policy.minimumLeadMinutes, worst),
      });
    }
  }

  return violations;
}

interface WorstCutoff {
  minutes: number;
  source: 'business' | 'service';
  serviceName?: string;
}

/** The longest cutoff any booking could actually be subject to. */
export function worstCutoff(
  businessCutoffMinutes: number,
  activeServices: readonly ServiceCutoff[],
): WorstCutoff {
  let worst: WorstCutoff = { minutes: businessCutoffMinutes, source: 'business' };
  for (const service of activeServices) {
    // null means inherit, which is already covered by the business value.
    if (service.cancellationCutoffMinutes === null) continue;
    if (service.cancellationCutoffMinutes > worst.minutes) {
      worst = {
        minutes: service.cancellationCutoffMinutes,
        source: 'service',
        serviceName: service.name,
      };
    }
  }
  return worst;
}

function cutoffTrapMessage(leadMinutes: number, worst: WorstCutoff): string {
  const who =
    worst.source === 'business'
      ? 'the business cancellation cutoff'
      : `“${worst.serviceName}”’s cancellation cutoff`;
  return (
    `Minimum lead time (${formatMinutes(leadMinutes)}) is shorter than ${who} ` +
    `(${formatMinutes(worst.minutes)}). A client could book a slot she is already unable to cancel, ` +
    `then be charged a late cancellation she had no way to avoid. Raise the lead time to at least ` +
    `${formatMinutes(worst.minutes)}, or shorten the cutoff.`
  );
}

/**
 * Validates a single service's cutoff against the business policy — the other
 * write path. Saving a service must not be able to create the same trap.
 */
export function validateServiceCutoff(
  service: ServiceCutoff,
  policy: Pick<BusinessPolicy, 'minimumLeadMinutes' | 'cancellationCutoffMinutes'>,
): PolicyViolation[] {
  if (service.cancellationCutoffMinutes === null) return [];
  if (!isNonNegativeInt(service.cancellationCutoffMinutes)) {
    return [
      {
        field: 'cancellationCutoffMinutes',
        message: 'Cancellation cutoff must be zero or a whole number of minutes.',
      },
    ];
  }
  if (service.cancellationCutoffMinutes <= policy.minimumLeadMinutes) return [];
  return [
    {
      field: 'cancellationCutoffMinutes',
      message: cutoffTrapMessage(policy.minimumLeadMinutes, {
        minutes: service.cancellationCutoffMinutes,
        source: 'service',
        serviceName: service.name,
      }),
    },
  ];
}

/**
 * "2 hours", "24 hours", "3 days" — for a message an owner reads, not a log.
 *
 * Hours are preferred up to three days because that is how this trade states
 * a cancellation policy: "24 hours notice", "48 hours notice". Rendering 1440
 * as "1 day" is arithmetically identical and reads as if it were written by
 * someone who has never taken the call.
 */
const HOURS_PREFERRED_BELOW_MINUTES = 3 * 1440;

export function formatMinutes(minutes: number): string {
  if (minutes === 0) return 'none';
  if (minutes % 60 === 0 && minutes < HOURS_PREFERRED_BELOW_MINUTES) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  return `${minutes} minutes`;
}
