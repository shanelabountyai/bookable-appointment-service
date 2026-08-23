/**
 * A-046 — the room as data the operator owns (RES-01, D-30).
 *
 * The CRUD half. The half that matters — that changing these rows changes what
 * the engine and the write path do — lives in `booking/resources.test.ts`,
 * next to the refusals it governs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { instantFromIso, toDate } from '../../core/time';
import { resetDatabase } from '../testing';
import {
  ResourceRejected,
  countFutureHolds,
  createResource,
  createResourceType,
  listResourceTypeChoices,
  listResourceTypes,
  setResourceActive,
} from './resources';
import { createService } from './services';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T08:00:00-05:00'));
let businessId: string;

const svc = (over: Partial<Parameters<typeof createService>[2]> = {}) => ({
  name: 'Cut',
  durationMinutes: 45,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  priceCents: 5500,
  cancellationCutoffMinutes: null,
  requiredResourceTypeId: null,
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
  const business = await prisma.business.create({
    data: { name: 'Shear Genius', timezone: 'America/Chicago', minimumLeadMinutes: 0, cancellationCutoffMinutes: 120 },
  });
  businessId = business.id;
});

describe('resource types', () => {
  it('refuses a blank name and a duplicate', async () => {
    await expect(createResourceType(prisma, businessId, { name: '  ' })).rejects.toBeInstanceOf(ResourceRejected);
    await createResourceType(prisma, businessId, { name: 'Chair' });
    const error = await createResourceType(prisma, businessId, { name: 'Chair' }).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceRejected);
    expect(error.field).toBe('typeName');
  });

  it('lists resources in the order the room actually fills', async () => {
    const type = await createResourceType(prisma, businessId, { name: 'Chair' });
    // Created out of order on purpose: `findFreeResource` assigns by name, so
    // a settings page ordered by creation would disagree with the assigner and
    // make "why is Chair 3 always empty?" unanswerable.
    for (const name of ['Chair 3', 'Chair 1', 'Chair 2']) {
      await createResource(prisma, businessId, { resourceTypeId: type.id, name });
    }
    const [listed] = await listResourceTypes(prisma, businessId);
    expect(listed!.resources.map((r) => r.name)).toEqual(['Chair 1', 'Chair 2', 'Chair 3']);
  });

  it('reports capacity as ACTIVE resources only — the number the engine used', async () => {
    const type = await createResourceType(prisma, businessId, { name: 'Chair' });
    const one = await createResource(prisma, businessId, { resourceTypeId: type.id, name: 'Chair 1' });
    await createResource(prisma, businessId, { resourceTypeId: type.id, name: 'Chair 2' });
    await setResourceActive(prisma, one.id, false);

    const [listed] = await listResourceTypes(prisma, businessId);
    expect(listed!.capacity).toBe(1);
    // ...and the retired one is still LISTED, or it could never be put back.
    expect(listed!.resources).toHaveLength(2);
  });

  it('names the services that require it, so retiring the last one has a stated cost', async () => {
    const type = await createResourceType(prisma, businessId, { name: 'Chair' });
    await createService(prisma, businessId, svc({ name: 'Colour', requiredResourceTypeId: type.id }));
    await createService(prisma, businessId, svc({ name: 'Phone consult' }));

    const [listed] = await listResourceTypes(prisma, businessId);
    expect(listed!.requiringServices.map((s) => s.name)).toEqual(['Colour']);
  });
});

describe('resources', () => {
  it('refuses a blank name, a duplicate within the type, and an unknown type', async () => {
    const type = await createResourceType(prisma, businessId, { name: 'Chair' });
    await expect(createResource(prisma, businessId, { resourceTypeId: type.id, name: ' ' })).rejects.toBeInstanceOf(
      ResourceRejected,
    );
    await createResource(prisma, businessId, { resourceTypeId: type.id, name: 'Chair 1' });
    await expect(
      createResource(prisma, businessId, { resourceTypeId: type.id, name: 'Chair 1' }),
    ).rejects.toBeInstanceOf(ResourceRejected);
    await expect(createResource(prisma, businessId, { resourceTypeId: 'nope', name: 'Chair 9' })).rejects.toBeInstanceOf(
      ResourceRejected,
    );
  });

  it('countFutureHolds asks the HOLD, so an after-buffer still counts as occupied', async () => {
    const type = await createResourceType(prisma, businessId, { name: 'Chair' });
    const chair = await createResource(prisma, businessId, { resourceTypeId: type.id, name: 'Chair 1' });
    const provider = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
    const service = await createService(prisma, businessId, svc({ requiredResourceTypeId: type.id }));

    // Body ends BEFORE `now`; the 25-minute after-buffer does not. The chair
    // is still hers, and a retirement confirm that said "nothing booked" would
    // be wrong by exactly that buffer.
    //
    // `blockedStart`/`blockedEnd` are DERIVED BY TRIGGER from the appointment's
    // own buffer columns, so the buffer is set here rather than the envelope —
    // writing the envelope by hand looks like it works and is silently
    // overwritten, which cost this test one debugging pass.
    const startAt = toDate(instantFromIso('2026-06-09T07:00:00-05:00'));
    const endAt = toDate(instantFromIso('2026-06-09T07:45:00-05:00'));
    const appointment = await prisma.appointment.create({
      data: {
        businessId,
        providerId: provider.id,
        status: 'in_progress',
        startAt,
        endAt,
        bufferAfterMinutes: 25,
        blockedStart: startAt,
        blockedEnd: endAt,
        startDay: '2026-06-09',
        startWallTime: '07:00',
        resourceId: chair.id,
        lines: {
          create: [
            {
              businessId,
              serviceId: service.id,
              ordinal: 0,
              priceCents: service.priceCents,
              durationMinutes: service.durationMinutes,
            },
          ],
        },
      },
    });
    const hold = await prisma.appointmentResourceHold.findUniqueOrThrow({
      where: { appointmentId: appointment.id },
    });
    // Prove the premise before trusting the assertion: the envelope really
    // does outlive the body, or this test passes for the wrong reason.
    expect(hold.blockedEnd).toEqual(toDate(instantFromIso('2026-06-09T08:10:00-05:00')));
    expect(hold.blockedEnd.getTime()).toBeGreaterThan(NOW.getTime());
    expect(endAt.getTime()).toBeLessThan(NOW.getTime());

    expect(await countFutureHolds(prisma, chair.id, NOW)).toBe(1);
  });

  it('a cancelled appointment stops counting against a retirement', async () => {
    const type = await createResourceType(prisma, businessId, { name: 'Chair' });
    const chair = await createResource(prisma, businessId, { resourceTypeId: type.id, name: 'Chair 1' });
    const provider = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
    const service = await createService(prisma, businessId, svc({ requiredResourceTypeId: type.id }));

    const startAt = toDate(instantFromIso('2026-06-09T10:00:00-05:00'));
    const appointment = await prisma.appointment.create({
      data: {
        businessId,
        providerId: provider.id,
        status: 'booked',
        startAt,
        endAt: toDate(instantFromIso('2026-06-09T10:45:00-05:00')),
        blockedStart: startAt,
        blockedEnd: toDate(instantFromIso('2026-06-09T10:55:00-05:00')),
        startDay: '2026-06-09',
        startWallTime: '10:00',
        resourceId: chair.id,
        lines: {
          create: [
            {
              businessId,
              serviceId: service.id,
              ordinal: 0,
              priceCents: service.priceCents,
              durationMinutes: service.durationMinutes,
            },
          ],
        },
      },
    });

    expect(await countFutureHolds(prisma, chair.id, NOW)).toBe(1);
    await prisma.appointment.update({ where: { id: appointment.id }, data: { status: 'cancelled' } });
    expect(await countFutureHolds(prisma, chair.id, NOW)).toBe(0);
  });
});

describe('listResourceTypeChoices', () => {
  it('is scoped to the business — the service form posts one of these back', async () => {
    const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });
    await createResourceType(prisma, businessId, { name: 'Chair' });
    await createResourceType(prisma, other.id, { name: 'Chair' });

    const choices = await listResourceTypeChoices(prisma, businessId);
    expect(choices).toHaveLength(1);
  });
});
