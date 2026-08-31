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
    /** The ENVELOPE — body plus buffers, gaps included (RES-02). */
    start: Date;
    end: Date;
    /**
     * A-063. Who is going to be sitting in it, and for how much of the
     * envelope. Omitted, this asks the strict question it always asked: a
     * chair with any overlapping hold is taken. Supplied, it asks the true
     * one — a chair the SAME client already holds over overlapping BUFFERS is
     * the chair she is already in, and taking a second one puts one body in
     * two of four chairs and reports the room full to a real client.
     *
     * `key` is her client id; `null` means nobody is named yet (a walk-in the
     * desk has not keyed), and a nameless client can never share, because two
     * anonymous appointments are two different people until proven otherwise.
     */
    holder?: { key: string | null; bodyStart: Date; bodyEnd: Date } | null;
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
  // A-063 — THIS MIRRORS THE TWO EXCLUSION CONSTRAINTS, deliberately and
  // line for line. The chooser asking a laxer question than the database
  // answers means a chosen chair is refused at the write as `SlotTaken`,
  // which is a lie to the desk; asking a stricter one means chairs that are
  // genuinely free are never offered. `''` is a key no hold can carry (the
  // trigger writes the client id or `appt:<id>`), so an absent holder makes
  // the first arm match every row — the strict question, unchanged.
  const holderKey = args.holder?.key ?? '';
  const bodyStart = args.holder?.bodyStart ?? args.start;
  const bodyEnd = args.holder?.bodyEnd ?? args.end;

  const taken = {
    status: { in: [...ACTIVE_STATUSES] },
    ...(args.excludeAppointmentId ? { appointmentId: { not: args.excludeAppointmentId } } : {}),
    OR: [
      {
        // Instant-overlap, never a date filter — the same predicate the busy
        // set uses, and wrong in the same way if written as `date(start) = day`.
        // Envelopes may overlap for ONE holder: her own buffers, her own chair.
        blockedStart: { lt: args.end },
        blockedEnd: { gt: args.start },
        holderKey: { not: holderKey },
      },
      {
        // Bodies never overlap, whoever the holder is. D-17's mother and
        // daughter are one client record and two people in two chairs.
        bodyStart: { lt: bodyEnd },
        bodyEnd: { gt: bodyStart },
      },
    ],
  } satisfies Prisma.AppointmentResourceHoldWhereInput;

  const free = {
    businessId: args.businessId,
    resourceTypeId: args.resourceTypeId,
    active: true,
    holds: { none: taken },
  } satisfies Prisma.ResourceWhereInput;

  // A-063 — the chair follows the client. Without this the loop above is free
  // to hand her a DIFFERENT empty chair, which is admissible and still wrong:
  // the point is not that sharing is allowed, it is that she keeps the one she
  // is sitting in. A move's own chair (A-034) wins over it — a reschedule that
  // reshuffles the room is the defect that parameter exists to prevent.
  const prefer = args.preferResourceId ?? (await chairAlreadyHeldBy(db, args, holderKey, bodyStart, bodyEnd));

  if (prefer) {
    const kept = await db.resource.findFirst({ where: { ...free, id: prefer }, select: { id: true } });
    if (kept) return kept.id;
  }

  const first = await db.resource.findFirst({ where: free, orderBy: { name: 'asc' }, select: { id: true } });
  return first?.id ?? null;
}

/**
 * The chair this holder is already sitting in over an overlapping envelope, if
 * any (A-063). Only ever a PREFERENCE: `findFreeResource` still checks it is
 * admissible, so a chair she holds at 13:50 that somebody else has at 14:30 is
 * correctly passed over for one that is free for the whole visit.
 */
async function chairAlreadyHeldBy(
  db: Db,
  args: { businessId: string; resourceTypeId: string; start: Date; end: Date; excludeAppointmentId?: string | null },
  holderKey: string,
  bodyStart: Date,
  bodyEnd: Date,
): Promise<string | null> {
  if (!holderKey) return null;
  const hold = await db.appointmentResourceHold.findFirst({
    where: {
      businessId: args.businessId,
      holderKey,
      status: { in: [...ACTIVE_STATUSES] },
      blockedStart: { lt: args.end },
      blockedEnd: { gt: args.start },
      // Sequential bodies only — the case this exists for is buffers touching,
      // and a body overlap is two people however the phone number reads.
      OR: [{ bodyEnd: { lte: bodyStart } }, { bodyStart: { gte: bodyEnd } }],
      resource: { resourceTypeId: args.resourceTypeId, active: true },
      ...(args.excludeAppointmentId ? { appointmentId: { not: args.excludeAppointmentId } } : {}),
    },
    orderBy: { blockedStart: 'asc' },
    select: { resourceId: true },
  });
  return hold?.resourceId ?? null;
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
  args: {
    businessId: string;
    appointmentId: string;
    resourceId: string;
    start: Date;
    end: Date;
    /** A-063 — forwarded unchanged; a move is entitled to share for the same
     *  reason a booking is, and refuses for the same reasons too. */
    holder?: { key: string | null; bodyStart: Date; bodyEnd: Date } | null;
  },
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
    holder: args.holder ?? null,
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
