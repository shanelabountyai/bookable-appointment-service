/**
 * A-046 — THE ROOM'S DAY (RES-01, D-30).
 *
 * The day grid answers "is Dana free?". Since A-030 that stopped being the
 * only question the desk needs answered, because a client developing colour
 * holds a chair her stylist is not using — four stylists can seat eight
 * clients in four chairs, and the fifth is refused. Until this read model the
 * refusal was the FIRST time the room was ever mentioned on a screen.
 *
 * Deliberately a sibling of `loadDayView` rather than a second page: it is
 * called with THAT function's query bounds, so the strip and the grid measure
 * the same day. Two loaders each computing their own midnight is how a room
 * strip comes to sit half an hour off the columns it is meant to explain.
 */
import { ACTIVE_STATUSES } from '../../core/scheduling';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface DayHold {
  appointmentId: string;
  /** The ENVELOPE — buffers and gaps included (RES-02). This is what makes the
   *  strip worth looking at: a colour's block here is visibly longer than the
   *  same colour on its provider's column, and that difference IS the epic. */
  start: Date;
  end: Date;
  clientName: string | null;
  providerName: string;
  serviceNames: string[];
  status: string;
}

export interface DayResource {
  id: string;
  name: string;
  active: boolean;
  holds: DayHold[];
}

export interface DayRoom {
  typeId: string;
  typeName: string;
  /** ACTIVE resources of this type — the capacity every "room full" answer is
   *  computed against, so the strip shows exactly the number the engine used. */
  capacity: number;
  resources: DayResource[];
}

/**
 * One type per row-group, one resource per row, holds within.
 *
 * An INACTIVE resource appears only when it still holds something today: a
 * retired chair with a client already in it has to stay visible until she
 * leaves, and one retired last winter is noise. That asymmetry is the same one
 * the deactivation confirm is built around — retiring never rewrites history.
 */
export async function loadRoom(db: Db, args: { businessId: string; from: Date; to: Date }): Promise<DayRoom[]> {
  const types = await db.resourceType.findMany({
    where: { businessId: args.businessId },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      resources: { orderBy: { name: 'asc' }, select: { id: true, name: true, active: true } },
    },
  });
  if (types.length === 0) return [];

  const holds = await db.appointmentResourceHold.findMany({
    where: {
      businessId: args.businessId,
      status: { in: [...ACTIVE_STATUSES] },
      // Instant-overlap, never a date filter — the 23:30 colour whose envelope
      // runs past midnight belongs to both days (the busy-set trap, same shape).
      blockedStart: { lt: args.to },
      blockedEnd: { gt: args.from },
    },
    orderBy: { blockedStart: 'asc' },
    select: {
      appointmentId: true,
      resourceId: true,
      status: true,
      blockedStart: true,
      blockedEnd: true,
      appointment: {
        select: {
          provider: { select: { displayName: true } },
          client: { select: { name: true } },
          lines: { orderBy: { ordinal: 'asc' }, select: { service: { select: { name: true } } } },
        },
      },
    },
  });

  const byResource = new Map<string, DayHold[]>();
  for (const hold of holds) {
    const list = byResource.get(hold.resourceId) ?? [];
    list.push({
      appointmentId: hold.appointmentId,
      start: hold.blockedStart,
      end: hold.blockedEnd,
      clientName: hold.appointment.client?.name ?? null,
      providerName: hold.appointment.provider.displayName,
      serviceNames: hold.appointment.lines.map((l) => l.service.name),
      status: hold.status,
    });
    byResource.set(hold.resourceId, list);
  }

  return types.map((type) => ({
    typeId: type.id,
    typeName: type.name,
    capacity: type.resources.filter((r) => r.active).length,
    resources: type.resources
      .map((resource) => ({ ...resource, holds: byResource.get(resource.id) ?? [] }))
      .filter((resource) => resource.active || resource.holds.length > 0),
  }));
}
