/**
 * A-006 — service catalog, qualification and deactivation, against the real
 * database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { instantFromIso, toDate } from '../../core/time';
import { resetDatabase } from '../testing';
import { createProvider } from './providers';
import {
  DeactivationRequiresConfirm,
  ServiceRejected,
  countServiceFutureAppointments,
  createService,
  listQualifications,
  listServices,
  qualifyProvider,
  setServiceActive,
  unqualifyProvider,
  updateService,
} from './services';

const prisma = new PrismaClient();
let businessId: string;
const NOW = toDate(instantFromIso('2026-06-01T00:00:00Z'));

const svc = (over: Partial<Parameters<typeof createService>[2]> = {}) => ({
  name: 'Cut',
  durationMinutes: 45,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  priceCents: 5500,
  cancellationCutoffMinutes: null,
  requiredResourceTypeId: null,
  bookableOnline: true,
  ...over,
});

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const b = await prisma.business.create({
    data: { name: 'Shear Genius', timezone: 'America/Chicago', minimumLeadMinutes: 120, cancellationCutoffMinutes: 120 },
  });
  businessId = b.id;
});

describe('service CRUD', () => {
  it('creates and lists a service, appended to the end of displayOrder', async () => {
    await createService(prisma, businessId, svc({ name: 'Cut' }));
    await createService(prisma, businessId, svc({ name: 'Colour' }));
    const services = await listServices(prisma, businessId);
    expect(services.map((s) => [s.name, s.displayOrder])).toEqual([
      ['Cut', 0],
      ['Colour', 1],
    ]);
  });

  it('rejects a malformed service and writes nothing', async () => {
    await expect(createService(prisma, businessId, svc({ durationMinutes: 0 }))).rejects.toThrow(ServiceRejected);
    expect(await prisma.service.count()).toBe(0);
  });

  it('updates a service in place, preserving displayOrder', async () => {
    const created = await createService(prisma, businessId, svc({ name: 'Cut' }));
    const updated = await updateService(prisma, businessId, created.id, svc({ name: 'Cut', priceCents: 6000 }));
    expect(updated.priceCents).toBe(6000);
    expect(updated.displayOrder).toBe(created.displayOrder);
  });

  it('lists inactive services by default, and can exclude them', async () => {
    const created = await createService(prisma, businessId, svc());
    await setServiceActive(prisma, created.id, false, NOW);
    expect(await listServices(prisma, businessId, true)).toHaveLength(1);
    expect(await listServices(prisma, businessId, false)).toHaveLength(0);
  });

  // The D-11/D-19 trap (operator R-3), exercised through the SERVICE write
  // path this time — the other half of A-025's coverage.
  it('refuses a service cutoff longer than the business lead time', async () => {
    const error = await createService(prisma, businessId, svc({ cancellationCutoffMinutes: 24 * 60 })).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceRejected);
    expect(error.message).toContain('already unable to cancel');
    expect(await prisma.service.count()).toBe(0);
  });

  it('accepts a service cutoff within the lead time, and null (inherit)', async () => {
    await expect(createService(prisma, businessId, svc({ cancellationCutoffMinutes: 60 }))).resolves.toBeDefined();
    await expect(createService(prisma, businessId, svc({ name: 'Colour', cancellationCutoffMinutes: null }))).resolves.toBeDefined();
  });

  it('re-validates the cutoff on UPDATE too, not only on create', async () => {
    const created = await createService(prisma, businessId, svc({ cancellationCutoffMinutes: 60 }));
    await expect(
      updateService(prisma, businessId, created.id, svc({ cancellationCutoffMinutes: 24 * 60 })),
    ).rejects.toThrow(ServiceRejected);
  });
});

describe('deactivation (SVC-03)', () => {
  it('deactivates freely when there are no future appointments', async () => {
    const created = await createService(prisma, businessId, svc());
    const result = await setServiceActive(prisma, created.id, false, NOW);
    expect(result.active).toBe(false);
  });

  it('reactivates a deactivated service', async () => {
    const created = await createService(prisma, businessId, svc());
    await setServiceActive(prisma, created.id, false, NOW);
    expect((await setServiceActive(prisma, created.id, true, NOW)).active).toBe(true);
  });

  // Nothing can create an appointment until A-009, so this count is
  // structurally always zero today — the mechanism is built and tested now so
  // A-009 does not have to touch this file. The confirm-gate test below
  // proves the mechanism directly via a synthetic count, not by faking an
  // appointment.
  it('counts zero future appointments today', async () => {
    const created = await createService(prisma, businessId, svc());
    expect(await countServiceFutureAppointments(prisma, created.id, NOW)).toBe(0);
  });
});

describe('qualification (SVC-02)', () => {
  it('qualifies a provider with no overrides', async () => {
    const service = await createService(prisma, businessId, svc());
    const provider = await createProvider(prisma, businessId, { displayName: 'Dana' });
    const q = await qualifyProvider(prisma, businessId, service.id, provider.id);
    expect(q).toMatchObject({ serviceId: service.id, providerId: provider.id, durationOverrideMinutes: null, priceOverrideCents: null });
  });

  it('qualifies with a duration override, a price override, or both', async () => {
    const service = await createService(prisma, businessId, svc());
    const provider = await createProvider(prisma, businessId, { displayName: 'Dana' });
    const q = await qualifyProvider(prisma, businessId, service.id, provider.id, {
      durationOverrideMinutes: 60,
      priceOverrideCents: 7500,
    });
    expect(q.durationOverrideMinutes).toBe(60);
    expect(q.priceOverrideCents).toBe(7500);
  });

  it('re-qualifying (upsert) updates the overrides rather than erroring', async () => {
    const service = await createService(prisma, businessId, svc());
    const provider = await createProvider(prisma, businessId, { displayName: 'Dana' });
    await qualifyProvider(prisma, businessId, service.id, provider.id, { durationOverrideMinutes: 60, priceOverrideCents: null });
    const second = await qualifyProvider(prisma, businessId, service.id, provider.id, {
      durationOverrideMinutes: null,
      priceOverrideCents: 8000,
    });
    expect(second.durationOverrideMinutes).toBeNull();
    expect(second.priceOverrideCents).toBe(8000);
    expect(await prisma.serviceProvider.count()).toBe(1);
  });

  it('rejects a zero or negative duration override', async () => {
    const service = await createService(prisma, businessId, svc());
    const provider = await createProvider(prisma, businessId, { displayName: 'Dana' });
    await expect(
      qualifyProvider(prisma, businessId, service.id, provider.id, { durationOverrideMinutes: 0, priceOverrideCents: null }),
    ).rejects.toThrow(ServiceRejected);
    expect(await prisma.serviceProvider.count()).toBe(0);
  });

  it('an unassigned provider does not appear in the service qualification list', async () => {
    await createService(prisma, businessId, svc());
    await createProvider(prisma, businessId, { displayName: 'Dana' });
    expect(await listQualifications(prisma, businessId)).toEqual([]);
  });

  it('unqualifies a provider freely when there are no future appointments', async () => {
    const service = await createService(prisma, businessId, svc());
    const provider = await createProvider(prisma, businessId, { displayName: 'Dana' });
    await qualifyProvider(prisma, businessId, service.id, provider.id);
    await unqualifyProvider(prisma, service.id, provider.id, NOW);
    expect(await listQualifications(prisma, businessId)).toEqual([]);
  });

  it('unqualifying a provider not qualified is a harmless no-op', async () => {
    const service = await createService(prisma, businessId, svc());
    const provider = await createProvider(prisma, businessId, { displayName: 'Dana' });
    await expect(unqualifyProvider(prisma, service.id, provider.id, NOW)).resolves.toBeUndefined();
  });
});

/**
 * The SVC-03 confirm gate, proven against a REAL appointment row rather than
 * by constructing the error class — A-009 does not exist yet to create one
 * through the app, so this inserts directly against the database, the same
 * pattern packages/db/constraint.test.ts uses to bypass the application.
 * blockedStart/blockedEnd are trigger-written (A-003); the placeholders here
 * are overwritten before the row is visible.
 */
async function insertFutureAppointment(serviceId: string, providerId: string): Promise<void> {
  const id = `appt-${Math.random().toString(36).slice(2)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Appointment"
       (id,"businessId","providerId",status,"startAt","endAt","blockedStart","blockedEnd","startDay","startWallTime","updatedAt")
     VALUES ($1,$2,$3,'booked','2026-07-01T10:00:00Z','2026-07-01T11:00:00Z','epoch','epoch','2026-07-01','10:00', now())`,
    id,
    businessId,
    providerId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "AppointmentServiceLine" (id,"businessId","appointmentId","serviceId","priceCents","durationMinutes","updatedAt")
     VALUES ($1,$2,$3,$4,5500,45, now())`,
    `line-${Math.random().toString(36).slice(2)}`,
    businessId,
    id,
    serviceId,
  );
}

describe('the SVC-03 confirm gate, against a real appointment', () => {
  it('countServiceFutureAppointments finds it, scoped to the provider when asked', async () => {
    const service = await createService(prisma, businessId, svc());
    const dana = await createProvider(prisma, businessId, { displayName: 'Dana' });
    const priya = await createProvider(prisma, businessId, { displayName: 'Priya' });
    await insertFutureAppointment(service.id, dana.id);

    expect(await countServiceFutureAppointments(prisma, service.id, NOW)).toBe(1);
    expect(await countServiceFutureAppointments(prisma, service.id, NOW, dana.id)).toBe(1);
    expect(await countServiceFutureAppointments(prisma, service.id, NOW, priya.id)).toBe(0);
  });

  it('refuses deactivation without confirm, and succeeds with it', async () => {
    const service = await createService(prisma, businessId, svc());
    const dana = await createProvider(prisma, businessId, { displayName: 'Dana' });
    await insertFutureAppointment(service.id, dana.id);

    const error = await setServiceActive(prisma, service.id, false, NOW).catch((e) => e);
    expect(error).toBeInstanceOf(DeactivationRequiresConfirm);
    expect(error.futureAppointmentCount).toBe(1);
    expect((await listServices(prisma, businessId)).find((s) => s.id === service.id)!.active).toBe(true);

    const result = await setServiceActive(prisma, service.id, false, NOW, true);
    expect(result.active).toBe(false);
  });

  it('refuses unqualifying a provider with a future appointment for that service, without confirm', async () => {
    const service = await createService(prisma, businessId, svc());
    const dana = await createProvider(prisma, businessId, { displayName: 'Dana' });
    await qualifyProvider(prisma, businessId, service.id, dana.id);
    await insertFutureAppointment(service.id, dana.id);

    await expect(unqualifyProvider(prisma, service.id, dana.id, NOW)).rejects.toThrow(DeactivationRequiresConfirm);
    expect(await listQualifications(prisma, businessId)).toHaveLength(1);

    await unqualifyProvider(prisma, service.id, dana.id, NOW, true);
    expect(await listQualifications(prisma, businessId)).toHaveLength(0);
  });

  it('a PAST appointment (before now) does not block deactivation', async () => {
    const service = await createService(prisma, businessId, svc());
    const dana = await createProvider(prisma, businessId, { displayName: 'Dana' });
    await insertFutureAppointment(service.id, dana.id); // dated 2026-07-01
    const wellAfter = toDate(instantFromIso('2026-08-01T00:00:00Z'));
    expect(await countServiceFutureAppointments(prisma, service.id, wellAfter)).toBe(0);
    await expect(setServiceActive(prisma, service.id, false, wellAfter)).resolves.toMatchObject({ active: false });
  });

  it('a CANCELLED appointment does not block deactivation', async () => {
    const service = await createService(prisma, businessId, svc());
    const dana = await createProvider(prisma, businessId, { displayName: 'Dana' });
    await insertFutureAppointment(service.id, dana.id);
    await prisma.appointment.updateMany({ data: { status: 'cancelled' } });
    expect(await countServiceFutureAppointments(prisma, service.id, NOW)).toBe(0);
  });
});
