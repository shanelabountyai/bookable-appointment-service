/**
 * Reading and writing business policy + the provider roster (A-025).
 *
 * `packages/core/settings` decides whether a policy is legal; this file reads
 * and writes. The validation is re-run HERE rather than trusted from the form,
 * because a form is one caller and the invariant belongs to the data.
 */
import { type BusinessPolicy, type PolicyViolation, validateBusinessPolicy } from '../../core/settings';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export class PolicyRejected extends Error {
  readonly violations: PolicyViolation[];
  constructor(violations: PolicyViolation[]) {
    super(violations.map((v) => v.message).join(' '));
    this.name = 'PolicyRejected';
    this.violations = violations;
  }
}

export interface BusinessSettings extends BusinessPolicy {
  id: string;
  name: string;
  timezone: string;
}

export async function getBusinessSettings(db: Db, businessId: string): Promise<BusinessSettings | null> {
  const b = await db.business.findUnique({ where: { id: businessId } });
  if (!b) return null;
  return {
    id: b.id,
    name: b.name,
    timezone: b.timezone,
    slotIntervalMinutes: b.slotIntervalMinutes,
    minimumLeadMinutes: b.minimumLeadMinutes,
    cancellationCutoffMinutes: b.cancellationCutoffMinutes,
    noShowBlockThreshold: b.noShowBlockThreshold,
    bookingHorizonDays: b.bookingHorizonDays,
    bufferMayOverlapBreak: b.bufferMayOverlapBreak,
    bufferMayExtendPastClose: b.bufferMayExtendPastClose,
    ambiguousLocalTime: b.ambiguousLocalTime as BusinessPolicy['ambiguousLocalTime'],
  };
}

export interface UpdateBusinessInput extends BusinessPolicy {
  name: string;
  timezone: string;
}

/**
 * Saves business policy, refusing anything that would trap a client.
 *
 * The ACTIVE services are loaded and passed to the validator (operator R-3):
 * the lead/cutoff trap is only visible when the business lead time and every
 * per-service cutoff override are considered together, so validating the
 * business row in isolation would let exactly the dangerous pair through.
 */
export async function updateBusinessSettings(
  db: Db,
  businessId: string,
  input: UpdateBusinessInput,
): Promise<BusinessSettings> {
  const activeServices = await db.service.findMany({
    where: { businessId, active: true },
    select: { id: true, name: true, cancellationCutoffMinutes: true },
  });

  const violations = validateBusinessPolicy(input, activeServices);
  if (input.name.trim().length === 0) {
    violations.push({ field: 'name', message: 'The business needs a name.' });
  }
  if (violations.length > 0) throw new PolicyRejected(violations);

  const b = await db.business.update({
    where: { id: businessId },
    data: {
      name: input.name.trim(),
      timezone: input.timezone,
      slotIntervalMinutes: input.slotIntervalMinutes,
      minimumLeadMinutes: input.minimumLeadMinutes,
      cancellationCutoffMinutes: input.cancellationCutoffMinutes,
      noShowBlockThreshold: input.noShowBlockThreshold,
      bookingHorizonDays: input.bookingHorizonDays,
      bufferMayOverlapBreak: input.bufferMayOverlapBreak,
      bufferMayExtendPastClose: input.bufferMayExtendPastClose,
      ambiguousLocalTime: input.ambiguousLocalTime,
    },
  });

  return {
    id: b.id,
    name: b.name,
    timezone: b.timezone,
    slotIntervalMinutes: b.slotIntervalMinutes,
    minimumLeadMinutes: b.minimumLeadMinutes,
    cancellationCutoffMinutes: b.cancellationCutoffMinutes,
    noShowBlockThreshold: b.noShowBlockThreshold,
    bookingHorizonDays: b.bookingHorizonDays,
    bufferMayOverlapBreak: b.bufferMayOverlapBreak,
    bufferMayExtendPastClose: b.bufferMayExtendPastClose,
    ambiguousLocalTime: b.ambiguousLocalTime as BusinessPolicy['ambiguousLocalTime'],
  };
}
