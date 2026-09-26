/**
 * SEC-01 / SEC-02 — no write reaches across a business boundary.
 *
 * Every staff action takes the ids it acts on from a form, and the session
 * supplies the business. So the attack is always the same shape: staff at A
 * posts B's ids. Each sink below is called as A with B's ids and must refuse;
 * then ALL of B's rows are compared with a snapshot taken before any of it, so
 * a sink that "refused" after writing something is caught too.
 *
 * The chain case matters most: linking B's stylist to A's service used to be
 * allowed (`qualifyProvider`), and a staff OVERRIDE skips the engine and only
 * checks that link — so A could book A's clients into B's column. Proven
 * against the unguarded code before the fix.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../core/time';
import { staffActor } from '../core/auth';
import { PrismaClient } from './generated/client/index.js';
import { resetDatabase } from './testing';
import { createWeeklyWindow } from './availability';
import { bookAppointment } from './booking';
import { transitionAppointment } from './appointments/transition';
import { changeVisitServices } from './appointments/change-services';
import { daysForMove, rescheduleAppointment, rescheduleOptions } from './appointments/reschedule';
import { qualifyProvider, setServiceActive, unqualifyProvider, updateService } from './settings/services';
import { replaceSegments } from './settings/segments';
import { countFutureAppointments, setProviderActive, updateProvider } from './settings/providers';
import { countFutureHolds, createResource, createResourceType, setResourceActive } from './settings/resources';
import { clearRunningLate, setRunningLate } from './day/running-late';

const prisma = new PrismaClient();
const STAFF = staffActor('staff-1');
const STAFF_ROW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const at = (iso: string) => toDate(instantFromIso(iso));
const DAY = '2026-06-09'; // Tuesday
const NOW = at('2026-06-09T08:00:00-05:00');

interface Tenant {
  businessId: string;
  providerId: string;
  serviceId: string;
  clientId: string;
  resourceId: string;
  appointmentId: string;
}

async function makeTenant(name: string, phone: string): Promise<Tenant> {
  const { id: businessId } = await prisma.business.create({
    data: { name, timezone: 'America/Chicago', minimumLeadMinutes: 0, bookingHorizonDays: 365 },
  });
  const { id: providerId } = await prisma.provider.create({ data: { businessId, displayName: `${name} stylist` } });
  const type = await createResourceType(prisma, businessId, { name: 'Chair' });
  const { id: resourceId } = await createResource(prisma, businessId, { resourceTypeId: type.id, name: 'Chair 1' });
  const { id: serviceId } = await prisma.service.create({
    data: {
      businessId,
      name: 'Cut',
      durationMinutes: 45,
      priceCents: 5500,
      bufferAfterMinutes: 10,
      requiredResourceTypeId: type.id,
    },
  });
  await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId } });
  const { id: clientId } = await prisma.client.create({ data: { businessId, name: `${name} client`, phone } });
  for (const providerIdOrNull of [null, providerId]) {
    await createWeeklyWindow(
      prisma,
      { businessId, providerId: providerIdOrNull, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
      STAFF_ROW,
    );
  }
  const { id: appointmentId } = await bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [serviceId],
    clientId,
    startAt: at('2026-06-09T10:00:00-05:00'),
    now: NOW,
    actor: STAFF,
    audience: 'staff',
  });
  await setRunningLate(prisma, { businessId, providerId, day: DAY, minutes: 20, actor: STAFF, now: NOW });
  return { businessId, providerId, serviceId, clientId, resourceId, appointmentId };
}

/** Every row B owns that any sink below could touch. */
async function snapshot(businessId: string) {
  const where = { where: { businessId } };
  return {
    appointments: await prisma.appointment.findMany({ ...where, include: { lines: true }, orderBy: { id: 'asc' } }),
    services: await prisma.service.findMany({ ...where, orderBy: { id: 'asc' } }),
    segments: await prisma.serviceSegment.findMany({ ...where, orderBy: { id: 'asc' } }),
    links: await prisma.serviceProvider.findMany({ ...where, orderBy: { id: 'asc' } }),
    providers: await prisma.provider.findMany({ ...where, orderBy: { id: 'asc' } }),
    resources: await prisma.resource.findMany({ ...where, orderBy: { id: 'asc' } }),
    late: await prisma.providerRunningLate.findMany({ ...where, orderBy: { id: 'asc' } }),
  };
}

let a: Tenant;
let b: Tenant;
let before: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
  await prisma.$connect();
  await resetDatabase(prisma);
  a = await makeTenant('Salon A', '5125550101');
  b = await makeTenant('Salon B', '5125550202');
  before = await snapshot(b.businessId);
  // The premise: B's rows exist, or "unchanged" would be vacuously true.
  expect(before.appointments).toHaveLength(1);
  expect(before.late).toHaveLength(1);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('staff at A posting B ids', () => {
  const asA = () => a.businessId;

  it('cannot move, cancel, re-service or reschedule B’s appointment', async () => {
    const id = b.appointmentId;
    await expect(
      transitionAppointment(prisma, { businessId: asA(), appointmentId: id, to: 'cancelled', actor: STAFF, now: NOW }),
    ).rejects.toThrow();
    await expect(
      changeVisitServices(prisma, { businessId: asA(), appointmentId: id, serviceIds: [a.serviceId], now: NOW, actor: STAFF }),
    ).rejects.toThrow();
    await expect(
      rescheduleAppointment(prisma, {
        businessId: asA(),
        appointmentId: id,
        startAt: at('2026-06-09T14:00:00-05:00'),
        now: NOW,
        actor: STAFF,
        audience: 'staff',
      }),
    ).rejects.toThrow();
    await expect(rescheduleOptions(prisma, { businessId: asA(), appointmentId: id, day: DAY, now: NOW })).rejects.toThrow();
    await expect(daysForMove(prisma, { businessId: asA(), appointmentId: id, fromDay: DAY, now: NOW })).rejects.toThrow();
  });

  it('cannot edit B’s services, segments, providers, qualifications or chairs', async () => {
    await expect(
      updateService(prisma, asA(), b.serviceId, {
        name: 'Hijacked',
        durationMinutes: 45,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 10,
        priceCents: 1,
        cancellationCutoffMinutes: null,
        requiredResourceTypeId: null,
        bookableOnline: true,
      }),
    ).rejects.toThrow(/not on this book/);
    await expect(setServiceActive(prisma, asA(), b.serviceId, false, NOW, true)).rejects.toThrow(/not on this book/);
    await expect(
      replaceSegments(prisma, asA(), b.serviceId, [
        { durationMinutes: 20, isGap: false },
        { durationMinutes: 10, isGap: true },
        { durationMinutes: 15, isGap: false },
      ]),
    ).rejects.toThrow(/not on this book/);
    await unqualifyProvider(prisma, asA(), b.serviceId, b.providerId, NOW, true);
    await expect(updateProvider(prisma, asA(), b.providerId, { displayName: 'Hijacked' })).rejects.toThrow(
      /not on this book/,
    );
    await expect(setProviderActive(prisma, asA(), b.providerId, false)).rejects.toThrow(/not on this book/);
    await expect(setResourceActive(prisma, asA(), b.resourceId, false)).rejects.toThrow(/not on this book/);
    await clearRunningLate(prisma, { businessId: asA(), providerId: b.providerId, day: DAY });
  });

  it('cannot link B’s stylist to A’s service, and so cannot book into B’s column', async () => {
    await expect(qualifyProvider(prisma, asA(), a.serviceId, b.providerId)).rejects.toThrow(/not on this book/);

    // Even with a stray cross-tenant link (written straight to the table, as
    // it could have been before the guard), booking must refuse B's stylist.
    const stray = await prisma.serviceProvider.create({
      data: { businessId: a.businessId, serviceId: a.serviceId, providerId: b.providerId },
    });
    await expect(
      bookAppointment(prisma, {
        businessId: asA(),
        providerId: b.providerId,
        serviceIds: [a.serviceId],
        clientId: a.clientId,
        startAt: at('2026-06-09T13:00:00-05:00'),
        now: NOW,
        actor: STAFF,
        audience: 'staff',
        // The override is the door that matters: it skips "is this time
        // offered", which is otherwise what happens to refuse this (B's hours
        // do not load for A). Only the link check stands in its way.
        isOverride: true,
        overrideReason: 'squeeze in',
      }),
    ).rejects.toThrow(/not on this book/);
    await prisma.serviceProvider.delete({ where: { id: stray.id } });
  });

  it('cannot attach B’s client to an A booking', async () => {
    await expect(
      bookAppointment(prisma, {
        businessId: asA(),
        providerId: a.providerId,
        serviceIds: [a.serviceId],
        clientId: b.clientId,
        startAt: at('2026-06-09T13:00:00-05:00'),
        now: NOW,
        actor: STAFF,
        audience: 'staff',
      }),
    ).rejects.toThrow(/not on this book/);
  });

  it('reads no counts from B', async () => {
    expect(await countFutureAppointments(prisma, asA(), b.providerId, NOW)).toBe(0);
    expect(await countFutureHolds(prisma, asA(), b.resourceId, NOW)).toBe(0);
    // …and the same counts asked as B are non-zero, so the zeros above are
    // the scope and not an empty fixture.
    expect(await countFutureAppointments(prisma, b.businessId, b.providerId, NOW)).toBe(1);
    expect(await countFutureHolds(prisma, b.businessId, b.resourceId, NOW)).toBe(1);
  });

  it('left every one of B’s rows exactly as it was', async () => {
    expect(await snapshot(b.businessId)).toEqual(before);
  });
});
