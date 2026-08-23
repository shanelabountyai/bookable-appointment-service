/**
 * A-046 — THE ROOM, AS DATA THE OPERATOR OWNS (RES-01, D-30).
 *
 * A-031 built the resource layer and A-032 taught the engine to read it, but
 * `ResourceType`/`Resource`/`Service.requiredResourceTypeId` were written by
 * the setup seed and by NOTHING ELSE. The consequence only became live at
 * demo checkpoint 3, when the chairs finally bound: the desk is refused a
 * booking, and a column push is told a client "stays: no chair free at the new
 * time", on the authority of a row the product has never once shown them and
 * cannot change. A refusal naming a thing the operator cannot see is how a
 * salon ends up booking on paper.
 *
 * This is the CRUD half. It deliberately does not delete: `Resource` is
 * `onDelete: Restrict` from `AppointmentResourceHold` for the same reason
 * `Provider` is from `Appointment` — a chair with history is not erasable
 * without erasing the history. Retiring is `active = false`, exactly as it is
 * for a stylist, and `findRoomFullIntervals` already counts ACTIVE resources
 * only, so a retired chair shrinks the room the moment it is retired.
 */
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { ACTIVE_STATUSES } from '../../core/scheduling';

type Db = Prisma.TransactionClient | PrismaClient;

export interface ResourceRow {
  id: string;
  name: string;
  active: boolean;
}

export interface ResourceTypeRow {
  id: string;
  name: string;
  resources: ResourceRow[];
  /** How many ACTIVE resources of this type exist — the room's capacity, and
   *  the number every "is the room full?" question is asked against. */
  capacity: number;
  /** Services that require this type. Zero means retiring the last chair costs
   *  nothing today; non-zero means it closes those services entirely, and the
   *  surface has to say which. */
  requiringServices: { id: string; name: string; active: boolean }[];
}

export class ResourceRejected extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'ResourceRejected';
    this.field = field;
  }
}

/** Types with their resources, ordered by name — the same ordering
 *  `findFreeResource` assigns by, so the screen lists chairs in the order the
 *  room actually fills. A settings page that orders them differently from the
 *  assigner makes "why is Chair 3 always empty?" unanswerable. */
export async function listResourceTypes(db: Db, businessId: string): Promise<ResourceTypeRow[]> {
  const types = await db.resourceType.findMany({
    where: { businessId },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      resources: { orderBy: { name: 'asc' }, select: { id: true, name: true, active: true } },
      services: { orderBy: { displayOrder: 'asc' }, select: { id: true, name: true, active: true } },
    },
  });

  return types.map((type) => ({
    id: type.id,
    name: type.name,
    resources: type.resources,
    capacity: type.resources.filter((r) => r.active).length,
    requiringServices: type.services,
  }));
}

/** For the service form's requirement selector — "needs no room resource" plus
 *  one option per type. */
export async function listResourceTypeChoices(db: Db, businessId: string): Promise<{ id: string; name: string }[]> {
  return db.resourceType.findMany({ where: { businessId }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
}

export async function createResourceType(db: Db, businessId: string, input: { name: string }): Promise<ResourceTypeRow> {
  const name = input.name.trim();
  if (!name) throw new ResourceRejected('typeName', 'A resource type needs a name.');
  const clash = await db.resourceType.findFirst({ where: { businessId, name }, select: { id: true } });
  if (clash) throw new ResourceRejected('typeName', `There is already a type called ${name}.`);

  const type = await db.resourceType.create({ data: { businessId, name }, select: { id: true, name: true } });
  return { ...type, resources: [], capacity: 0, requiringServices: [] };
}

export async function createResource(
  db: Db,
  businessId: string,
  input: { resourceTypeId: string; name: string },
): Promise<ResourceRow> {
  const name = input.name.trim();
  if (!name) throw new ResourceRejected('resourceName', 'A resource needs a name.');
  const type = await db.resourceType.findFirst({
    where: { id: input.resourceTypeId, businessId },
    select: { id: true },
  });
  if (!type) throw new ResourceRejected('resourceName', 'That resource type no longer exists.');

  // Names are what `findFreeResource` orders by and what every refusal
  // sentence says out loud, so two "Chair 2"s make the room's own report
  // ambiguous. Not a database constraint — this is the only writer, and adding
  // a unique index to a live table for a rule with one caller is the migration
  // D-12 exists to avoid.
  const clash = await db.resource.findFirst({
    where: { businessId, resourceTypeId: input.resourceTypeId, name },
    select: { id: true },
  });
  if (clash) throw new ResourceRejected('resourceName', `There is already one called ${name}.`);

  return db.resource.create({
    data: { businessId, resourceTypeId: input.resourceTypeId, name },
    select: { id: true, name: true, active: true },
  });
}

/**
 * Retire or return a resource.
 *
 * NOT a deletion, and the holds already sitting on it are deliberately left
 * alone: an appointment booked into Chair 3 last week keeps its hold when
 * Chair 3 is retired, because rewriting history to say she sat somewhere else
 * is a worse answer than a chair that is out of service and still remembers.
 * `findRoomFullIntervals` excludes inactive resources from BOTH the capacity
 * and the holds counted against it, so a retired chair shrinks the room
 * without also filling it.
 */
export async function setResourceActive(db: Db, resourceId: string, active: boolean): Promise<ResourceRow> {
  return db.resource.update({
    where: { id: resourceId },
    data: { active },
    select: { id: true, name: true, active: true },
  });
}

/**
 * How many appointments still ahead of `now` are holding this resource.
 *
 * The confirm before retiring. Counted on the HOLD, not on `Appointment.
 * resourceId`, because the hold is what the exclusion constraint ranges over
 * and its `blockedEnd` is the envelope — an appointment whose body has ended
 * but whose after-buffer has not is still in that chair.
 */
export async function countFutureHolds(db: Db, resourceId: string, now: Date): Promise<number> {
  return db.appointmentResourceHold.count({
    where: { resourceId, status: { in: [...ACTIVE_STATUSES] }, blockedEnd: { gt: now } },
  });
}
