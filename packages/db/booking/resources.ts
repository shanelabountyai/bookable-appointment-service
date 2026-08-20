/**
 * Chair assignment (RES-01..04, D-30).
 *
 * The desk never picks a chair. This finds the first free one of the type the
 * visit needs, and the exclusion constraint on `AppointmentResourceHold` is what
 * actually guarantees it stays free — this query is the *chooser*, not the
 * enforcer. Two transactions can both pick chair 1; one of them then loses to
 * the constraint and is reported as `SlotTaken`, exactly like a lost race on the
 * provider axis (RES-03). That is the same division of labour D-2 established:
 * never check-then-write as the correctness mechanism.
 */
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { ACTIVE_STATUSES } from '../../core/scheduling';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * The resource type this visit needs, or null when it needs none.
 *
 * A visit spanning several services takes the FIRST line's requirement. v1 has
 * one chair per visit: a cut-then-colour happens in one chair, and modelling a
 * client who moves mid-visit is a different feature with a different data shape.
 * ponytail: first-line wins, revisit when a service genuinely needs a second type.
 */
export async function requiredResourceTypeId(db: Db, serviceIds: readonly string[]): Promise<string | null> {
  if (serviceIds.length === 0) return null;
  const service = await db.service.findUnique({
    where: { id: serviceIds[0]! },
    select: { requiredResourceTypeId: true },
  });
  return service?.requiredResourceTypeId ?? null;
}

/**
 * The first free resource of a type over [start, end), or null when every one
 * is taken.
 *
 * Ordered by name so assignment is deterministic and a re-run of the seed puts
 * the same client in the same chair — a demo that shuffles chairs on every run
 * looks broken even when it is right.
 */
export async function findFreeResource(
  db: Db,
  args: { businessId: string; resourceTypeId: string; start: Date; end: Date },
): Promise<string | null> {
  const free = await db.resource.findFirst({
    where: {
      businessId: args.businessId,
      resourceTypeId: args.resourceTypeId,
      active: true,
      holds: {
        none: {
          status: { in: [...ACTIVE_STATUSES] },
          // Instant-overlap, never a date filter — the same predicate the busy
          // set uses, and wrong in the same way if written as `date(start) = day`.
          blockedStart: { lt: args.end },
          blockedEnd: { gt: args.start },
        },
      },
    },
    orderBy: { name: 'asc' },
    select: { id: true },
  });
  return free?.id ?? null;
}
