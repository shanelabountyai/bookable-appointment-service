/**
 * Provider roster CRUD (A-025, SVC-03's provider half).
 *
 * Deactivation writes `Provider.active` and NOTHING ELSE here. The AVAIL-05
 * impact preview — "she has nine appointments booked, here is each one with a
 * phone number" — belongs to A-019 (operator S-2): no appointment can exist
 * until A-009, so a preview built here would ship untested against an empty
 * set and would have to be rewritten the moment it met a real book.
 */
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface ProviderRow {
  id: string;
  displayName: string;
  active: boolean;
  displayOrder: number;
}

export class ProviderRejected extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'ProviderRejected';
    this.field = field;
  }
}

/** Ordered the way every staff surface must order providers: `displayOrder`,
 *  then name as a stable tiebreak. SVC-02's "any provider" rule breaks ties on
 *  `displayOrder`, so an unstable order there would make the assignment
 *  non-deterministic and its acceptance test meaningless. */
export async function listProviders(db: Db, businessId: string, includeInactive = true): Promise<ProviderRow[]> {
  return db.provider.findMany({
    where: { businessId, ...(includeInactive ? {} : { active: true }) },
    orderBy: [{ displayOrder: 'asc' }, { displayName: 'asc' }],
    select: { id: true, displayName: true, active: true, displayOrder: true },
  });
}

export async function createProvider(
  db: Db,
  businessId: string,
  input: { displayName: string; displayOrder?: number },
): Promise<ProviderRow> {
  const displayName = input.displayName.trim();
  if (!displayName) throw new ProviderRejected('displayName', 'A provider needs a name.');

  // Append to the end of the roster by default, rather than colliding on 0 and
  // leaving the order to the name tiebreak.
  const displayOrder =
    input.displayOrder ??
    ((await db.provider.aggregate({ where: { businessId }, _max: { displayOrder: true } }))._max.displayOrder ?? -1) + 1;

  return db.provider.create({
    data: { businessId, displayName, displayOrder },
    select: { id: true, displayName: true, active: true, displayOrder: true },
  });
}

export async function updateProvider(
  db: Db,
  providerId: string,
  input: { displayName?: string; displayOrder?: number },
): Promise<ProviderRow> {
  const data: Prisma.ProviderUpdateInput = {};
  if (input.displayName !== undefined) {
    const displayName = input.displayName.trim();
    if (!displayName) throw new ProviderRejected('displayName', 'A provider needs a name.');
    data.displayName = displayName;
  }
  if (input.displayOrder !== undefined) {
    if (!Number.isInteger(input.displayOrder)) {
      throw new ProviderRejected('displayOrder', 'Display order must be a whole number.');
    }
    data.displayOrder = input.displayOrder;
  }
  return db.provider.update({
    where: { id: providerId },
    data,
    select: { id: true, displayName: true, active: true, displayOrder: true },
  });
}

/**
 * Deactivate / reactivate a provider.
 *
 * DEACTIVATION IS NOT DELETION, and that is the whole design. A stylist who
 * quits with three weeks booked must keep every appointment renderable with
 * full status controls (SVC-03's shape, applied to the provider half): the
 * clients still exist, the history still matters, and `Appointment.providerId`
 * is `onDelete: Restrict` precisely so nobody can erase her out from under
 * them. An inactive provider simply stops being offered.
 */
export async function setProviderActive(db: Db, providerId: string, active: boolean): Promise<ProviderRow> {
  return db.provider.update({
    where: { id: providerId },
    data: { active },
    select: { id: true, displayName: true, active: true, displayOrder: true },
  });
}

/**
 * How many non-terminal appointments a provider still holds.
 *
 * A-025 uses this only to WARN before deactivating. A-019 turns the same count
 * into the AVAIL-05 preview with names, phones and per-appointment actions.
 * Returns 0 until A-009 exists to create appointments — correct, and the
 * reason the full preview is not built here.
 */
export async function countFutureAppointments(db: Db, providerId: string, now: Date): Promise<number> {
  return db.appointment.count({
    where: {
      providerId,
      startAt: { gte: now },
      status: { notIn: ['cancelled', 'cancelled_late'] },
    },
  });
}
