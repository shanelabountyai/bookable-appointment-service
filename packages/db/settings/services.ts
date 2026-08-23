/**
 * Service catalog CRUD, qualification, and deactivation (A-006, SVC-01..03).
 *
 * `packages/core/settings` decides whether a service or an override is legal;
 * this file reads and writes, and re-runs validation here rather than trusting
 * the caller — same reasoning as A-025's business settings.
 */
import {
  type QualificationOverrideInput,
  type ServiceInput,
  scaleSegments,
  validateQualificationOverride,
  validateService,
  validateServiceCutoff,
} from '../../core/settings';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export class ServiceRejected extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'ServiceRejected';
    this.field = field;
  }
}

export interface ServiceRow {
  id: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceCents: number;
  active: boolean;
  displayOrder: number;
  cancellationCutoffMinutes: number | null;
  requiredResourceTypeId: string | null;
}

const select = {
  id: true,
  name: true,
  durationMinutes: true,
  bufferBeforeMinutes: true,
  bufferAfterMinutes: true,
  priceCents: true,
  active: true,
  displayOrder: true,
  cancellationCutoffMinutes: true,
  requiredResourceTypeId: true,
} as const;

export async function listServices(db: Db, businessId: string, includeInactive = true): Promise<ServiceRow[]> {
  return db.service.findMany({
    where: { businessId, ...(includeInactive ? {} : { active: true }) },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    select,
  });
}

export interface SaveServiceInput extends ServiceInput {
  cancellationCutoffMinutes: number | null;
  /**
   * A-046 (RES-01). NULL means this service needs no room resource — a phone
   * consult, a blow-dry at the basin, and every service in a business that has
   * not defined resources at all. Written from the service form as of A-046;
   * before that only the setup seed ever set it, which is why the desk could
   * be refused on the authority of a value nobody could edit.
   */
  requiredResourceTypeId: string | null;
}

/**
 * Throws a single violation from EITHER validator — the service's own fields
 * (name/duration/buffers/price) or the D-11/D-19 cutoff coupling (operator
 * R-3) — whichever fails first. Both are re-checked here even though the form
 * checks them too, because the invariant belongs to the data, not the caller.
 */
async function assertValid(db: Db, businessId: string, input: SaveServiceInput): Promise<void> {
  const fieldViolations = validateService(input);
  if (fieldViolations.length > 0) throw new ServiceRejected(fieldViolations[0]!.field, fieldViolations[0]!.message);

  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { minimumLeadMinutes: true, cancellationCutoffMinutes: true },
  });
  const cutoffViolations = validateServiceCutoff(
    { id: '', name: input.name, cancellationCutoffMinutes: input.cancellationCutoffMinutes },
    business,
  );
  if (cutoffViolations.length > 0) {
    throw new ServiceRejected(cutoffViolations[0]!.field, cutoffViolations[0]!.message);
  }

  // A-046. `requiredResourceTypeId` arrives from a form, so it is ordinary
  // untrusted input: checked against THIS business rather than merely against
  // existence, or a hand-edited option value attaches the salon's colour
  // service to another tenant's chairs and the room silently stops binding.
  if (input.requiredResourceTypeId !== null) {
    const type = await db.resourceType.findFirst({
      where: { id: input.requiredResourceTypeId, businessId },
      select: { id: true },
    });
    if (!type) throw new ServiceRejected('requiredResourceTypeId', 'That resource type no longer exists.');
  }
}

export async function createService(db: Db, businessId: string, input: SaveServiceInput): Promise<ServiceRow> {
  await assertValid(db, businessId, input);
  const maxOrder = (await db.service.aggregate({ where: { businessId }, _max: { displayOrder: true } }))._max
    .displayOrder;
  return db.service.create({
    data: {
      businessId,
      name: input.name.trim(),
      durationMinutes: input.durationMinutes,
      bufferBeforeMinutes: input.bufferBeforeMinutes,
      bufferAfterMinutes: input.bufferAfterMinutes,
      priceCents: input.priceCents,
      cancellationCutoffMinutes: input.cancellationCutoffMinutes,
      requiredResourceTypeId: input.requiredResourceTypeId,
      displayOrder: (maxOrder ?? -1) + 1,
    },
    select,
  });
}

export async function updateService(
  db: Db,
  businessId: string,
  serviceId: string,
  input: SaveServiceInput,
): Promise<ServiceRow> {
  await assertValid(db, businessId, input);
  await assertSegmentsStillAddUp(db, serviceId, input.durationMinutes);
  return db.service.update({
    where: { id: serviceId },
    data: {
      name: input.name.trim(),
      durationMinutes: input.durationMinutes,
      bufferBeforeMinutes: input.bufferBeforeMinutes,
      bufferAfterMinutes: input.bufferAfterMinutes,
      priceCents: input.priceCents,
      cancellationCutoffMinutes: input.cancellationCutoffMinutes,
      requiredResourceTypeId: input.requiredResourceTypeId,
    },
    select,
  });
}

/**
 * A duration change on a SEGMENTED service is refused (SEG-01).
 *
 * The parts have to keep adding up to `durationMinutes`, because that is what
 * `blockedStart`/`blockedEnd` are derived from and therefore what the exclusion
 * constraint is actually enforcing. Silently rescaling the segments here would
 * be the tempting alternative and it is wrong twice over: it would move the gap
 * without anyone asking, and on a colour it would restate how long the chemistry
 * takes. The owner edits the parts, and the total follows from them.
 */
async function assertSegmentsStillAddUp(db: Db, serviceId: string, durationMinutes: number): Promise<void> {
  const segments = await db.serviceSegment.findMany({
    where: { serviceId, status: 'active' },
    select: { durationMinutes: true },
  });
  if (segments.length === 0) return;
  const total = segments.reduce((sum, s) => sum + s.durationMinutes, 0);
  if (total !== durationMinutes) {
    throw new ServiceRejected(
      'durationMinutes',
      `This service is split into ${segments.length} parts adding up to ${total} minutes. ` +
        'Edit the parts to change the total.',
    );
  }
}

/**
 * A provider's duration override has to leave every ACTIVE segment at a minute
 * or more (SEG-02) — refused here, at save time, rather than discovered at
 * booking time when the segments no longer fit the footprint.
 *
 * The gap is held fixed by `scaleSegments`, so an override shorter than the
 * gap plus one minute per active part is simply impossible, and saying so on
 * the form is the only honest answer.
 */
async function assertOverrideFitsSegments(
  db: Db,
  serviceId: string,
  overrideMinutes: number | null,
): Promise<void> {
  if (overrideMinutes === null) return;
  const segments = await db.serviceSegment.findMany({
    where: { serviceId, status: 'active' },
    orderBy: { ordinal: 'asc' },
    select: { durationMinutes: true, isGap: true },
  });
  if (segments.length === 0) return;
  if (scaleSegments(segments, overrideMinutes) === null) {
    const gapMinutes = segments.filter((s) => s.isGap).reduce((sum, s) => sum + s.durationMinutes, 0);
    throw new ServiceRejected(
      'durationOverrideMinutes',
      `This service has ${gapMinutes} minutes of processing time that never shortens, ` +
        `so an override has to leave room for the rest of it. ${overrideMinutes} minutes does not.`,
    );
  }
}

/**
 * How many non-terminal appointments this service — or, when `providerId` is
 * given, this provider FOR this service — still has booked in the future.
 *
 * SVC-03's gate for BOTH deactivating a service and unassigning a provider.
 * Returns 0 until A-009 exists to create appointments, which is exactly why
 * the full AVAIL-05-style impact preview (names, phones, per-appointment
 * actions) stays in A-019 rather than being built here — the same call the
 * operator review made for provider deactivation in A-025 (S-2).
 */
export async function countServiceFutureAppointments(
  db: Db,
  serviceId: string,
  now: Date,
  providerId?: string,
): Promise<number> {
  return db.appointment.count({
    where: {
      startAt: { gte: now },
      status: { notIn: ['cancelled', 'cancelled_late'] },
      ...(providerId ? { providerId } : {}),
      lines: { some: { serviceId } },
    },
  });
}

export class DeactivationRequiresConfirm extends Error {
  readonly futureAppointmentCount: number;
  constructor(futureAppointmentCount: number) {
    super(
      `This service has ${futureAppointmentCount} future appointment(s) booked. ` +
        'Confirm to deactivate anyway — existing appointments stay valid and renderable; only new bookings are refused.',
    );
    this.name = 'DeactivationRequiresConfirm';
    this.futureAppointmentCount = futureAppointmentCount;
  }
}

/**
 * Deactivate or reactivate a service (SVC-03).
 *
 * NOT deletion — `active: false` only. `AppointmentServiceLine.serviceId` is
 * `onDelete: Restrict`, so nothing here could delete a service with history
 * even by accident. A deactivation with future non-terminal appointments is
 * REFUSED unless `confirm: true`; confirming changes nothing about those
 * appointments — they remain exactly as bookable-in-the-past as they always
 * were, renderable with full status controls. Only future NEW bookings into
 * this service are refused from here on.
 */
export async function setServiceActive(
  db: Db,
  serviceId: string,
  active: boolean,
  now: Date,
  confirm = false,
): Promise<ServiceRow> {
  if (!active) {
    const count = await countServiceFutureAppointments(db, serviceId, now);
    if (count > 0 && !confirm) throw new DeactivationRequiresConfirm(count);
  }
  return db.service.update({ where: { id: serviceId }, data: { active }, select });
}

// ─────────────────────────── qualification (SVC-02) ───────────────────────────

export interface QualificationRow {
  id: string;
  providerId: string;
  serviceId: string;
  durationOverrideMinutes: number | null;
  priceOverrideCents: number | null;
}

const qualSelect = {
  id: true,
  providerId: true,
  serviceId: true,
  durationOverrideMinutes: true,
  priceOverrideCents: true,
} as const;

export async function listQualifications(db: Db, businessId: string): Promise<QualificationRow[]> {
  return db.serviceProvider.findMany({ where: { businessId }, select: qualSelect });
}

/**
 * Qualify a provider for a service, with optional overrides — or update the
 * overrides if she is already qualified. Upsert, not create-only: the staff
 * flow is "tick the box, maybe set a price" and re-ticking an already-checked
 * box must not be an error.
 */
export async function qualifyProvider(
  db: Db,
  businessId: string,
  serviceId: string,
  providerId: string,
  overrides: QualificationOverrideInput = { durationOverrideMinutes: null, priceOverrideCents: null },
): Promise<QualificationRow> {
  const violations = validateQualificationOverride(overrides);
  if (violations.length > 0) throw new ServiceRejected(violations[0]!.field, violations[0]!.message);
  await assertOverrideFitsSegments(db, serviceId, overrides.durationOverrideMinutes);

  return db.serviceProvider.upsert({
    where: { serviceId_providerId: { serviceId, providerId } },
    create: {
      businessId,
      serviceId,
      providerId,
      durationOverrideMinutes: overrides.durationOverrideMinutes,
      priceOverrideCents: overrides.priceOverrideCents,
    },
    update: {
      durationOverrideMinutes: overrides.durationOverrideMinutes,
      priceOverrideCents: overrides.priceOverrideCents,
    },
    select: qualSelect,
  });
}

/**
 * Unassign a provider from a service (SVC-03's other half). Same
 * future-appointment guard as service deactivation: refused unless confirmed
 * when she still has non-terminal appointments booked for that service.
 */
export async function unqualifyProvider(
  db: Db,
  serviceId: string,
  providerId: string,
  now: Date,
  confirm = false,
): Promise<void> {
  const count = await countServiceFutureAppointments(db, serviceId, now, providerId);
  if (count > 0 && !confirm) throw new DeactivationRequiresConfirm(count);

  await db.serviceProvider.deleteMany({ where: { serviceId, providerId } });
}
