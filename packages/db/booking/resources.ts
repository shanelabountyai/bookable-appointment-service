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
  args: {
    businessId: string;
    resourceTypeId: string;
    start: Date;
    end: Date;
    /**
     * A-034. An appointment being MOVED must not count its own chair against
     * its own destination — the same parameter, for the same reason, as the
     * one the busy set carries (spec §4.6). Without it, every move inside a
     * busy hour fails on the chair the mover is in the act of vacating.
     */
    excludeAppointmentId?: string | null;
    /**
     * A-034. Keep the chair she is already in, when it is still free at the
     * destination. Cosmetic on a single reschedule; on a column push it is the
     * difference between a uniform shift that keeps its seating and one that
     * reshuffles the room and then runs out of chairs.
     */
    preferResourceId?: string | null;
  },
): Promise<string | null> {
  const free = {
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
        ...(args.excludeAppointmentId ? { appointmentId: { not: args.excludeAppointmentId } } : {}),
      },
    },
  } satisfies Prisma.ResourceWhereInput;

  if (args.preferResourceId) {
    const kept = await db.resource.findFirst({
      where: { ...free, id: args.preferResourceId },
      select: { id: true },
    });
    if (kept) return kept.id;
  }

  const first = await db.resource.findFirst({ where: free, orderBy: { name: 'asc' }, select: { id: true } });
  return first?.id ?? null;
}

/**
 * The chair an appointment should hold AT ITS DESTINATION (A-034, RES-03).
 *
 * The rule, stated once because three write paths now depend on it: **a move
 * re-picks the chair it is already holding, and a move never starts or stops
 * holding one.** An appointment with no chair has none deliberately — a staff
 * override (D-30), a service that needs no resource, a business with no
 * resources at all — and a move is not the place to change that.
 *
 * `null` means every chair of the type is taken for the destination envelope.
 * What that MEANS is the caller's to decide: a reschedule refuses with
 * `NoResourceFree`, a column push leaves that one behind (D-26).
 */
export async function chairForMove(
  db: Db,
  args: { businessId: string; appointmentId: string; resourceId: string; start: Date; end: Date },
): Promise<string | null> {
  const current = await db.resource.findUnique({
    where: { id: args.resourceId },
    select: { resourceTypeId: true },
  });
  if (!current) return null;

  return findFreeResource(db, {
    businessId: args.businessId,
    resourceTypeId: current.resourceTypeId,
    start: args.start,
    end: args.end,
    excludeAppointmentId: args.appointmentId,
    preferResourceId: args.resourceId,
  });
}

/**
 * The type's name, for the sentence a human reads ("Every chair is taken for
 * that time"). Only ever called on the refusal path, so the extra read costs
 * nothing on the path that matters.
 */
export async function resourceTypeName(db: Db, serviceIds: readonly string[]): Promise<string> {
  const id = await requiredResourceTypeId(db, serviceIds);
  if (!id) return 'resource';
  const type = await db.resourceType.findUnique({ where: { id }, select: { name: true } });
  return type?.name ?? 'resource';
}
