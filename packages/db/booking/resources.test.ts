/**
 * A-031 — chair capacity, enforced by the database (RES-01..05, D-30).
 *
 * The scenario that motivates the whole epic is RES-05, and it only became
 * possible when A-030 shipped: a client developing colour holds a chair her
 * stylist is not using, so a 4-chair salon with 4 stylists can want 8 chairs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { staffActor } from '../../core/auth';
import { instantFromIso, toDate } from '../../core/time';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from './book';
import { NoResourceFree, SlotTaken } from './errors';
import { findFreeResource } from './resources';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');
const at = (iso: string) => toDate(instantFromIso(iso));
const NOW = at('2026-06-09T08:00:00-05:00');

let businessId: string;
let chairTypeId: string;
let serviceId: string;
let providerIds: string[] = [];

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const business = await prisma.business.create({
    data: {
      name: 'Shear Genius',
      timezone: 'America/Chicago',
      slotIntervalMinutes: 15,
      minimumLeadMinutes: 0,
      bookingHorizonDays: 90,
    },
  });
  businessId = business.id;

  const chairType = await prisma.resourceType.create({ data: { businessId, name: 'Chair' } });
  chairTypeId = chairType.id;
  // TWO chairs, so the pool binds inside a test rather than needing four
  // providers to demonstrate the same thing.
  for (const name of ['Chair 1', 'Chair 2']) {
    await prisma.resource.create({ data: { businessId, resourceTypeId: chairTypeId, name } });
  }

  const service = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500, requiredResourceTypeId: chairTypeId },
  });
  serviceId = service.id;

  providerIds = [];
  await createWeeklyWindow(
    prisma,
    { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
    STAMP,
  );
  for (const displayName of ['Dana', 'Priya', 'Marcus']) {
    const provider = await prisma.provider.create({ data: { businessId, displayName } });
    providerIds.push(provider.id);
    await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId: provider.id } });
    await createWeeklyWindow(
      prisma,
      { businessId, providerId: provider.id, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
      STAMP,
    );
  }
});

const book = (over: Record<string, unknown> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId: providerIds[0]!,
    serviceIds: [serviceId],
    clientId: null,
    startAt: at('2026-06-09T10:00:00-05:00'),
    now: NOW,
    actor: ACTOR,
    audience: 'staff',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

describe('chair assignment (RES-01, D-30)', () => {
  it('assigns a chair without anyone choosing one, and holds it for the envelope', async () => {
    const appointment = await book();
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
      include: { resourceHold: true, resource: true },
    });
    expect(row.resource!.name).toBe('Chair 1');
    // The hold spans the ENVELOPE, not the worked spans (RES-02).
    expect(row.resourceHold!.blockedStart).toEqual(row.blockedStart);
    expect(row.resourceHold!.blockedEnd).toEqual(row.blockedEnd);
  });

  it('gives the second concurrent client a different chair', async () => {
    await book();
    const second = await book({ providerId: providerIds[1]! });
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: second.id },
      include: { resource: true },
    });
    expect(row.resource!.name).toBe('Chair 2');
  });

  it('REFUSES the third — two chairs, three stylists, three clients at once', async () => {
    await book();
    await book({ providerId: providerIds[1]! });
    await expect(book({ providerId: providerIds[2]! })).rejects.toBeInstanceOf(NoResourceFree);
  });

  it('reuses a chair back-to-back — half-open, or the salon loses a seating every hour', async () => {
    const first = await book();
    const firstRow = await prisma.appointment.findUniqueOrThrow({ where: { id: first.id } });
    const next = await book({ providerId: providerIds[1]!, startAt: firstRow.blockedEnd });
    const nextRow = await prisma.appointment.findUniqueOrThrow({
      where: { id: next.id },
      include: { resource: true },
    });
    expect(nextRow.resource!.name).toBe('Chair 1');
  });

  it('frees the chair on cancellation, and not on completion', async () => {
    const first = await book();
    await prisma.appointment.update({ where: { id: first.id }, data: { status: 'completed' } });
    // `completed` still holds its chair — the hour has passed but the seat was used.
    await book({ providerId: providerIds[1]! });
    await expect(book({ providerId: providerIds[2]! })).rejects.toBeInstanceOf(NoResourceFree);

    await prisma.appointment.update({ where: { id: first.id }, data: { status: 'cancelled' } });
    await expect(book({ providerId: providerIds[2]! })).resolves.toBeDefined();
  });
});

describe('RES-05 — the case A-030 created', () => {
  it('a developing client holds a chair her stylist is not using', async () => {
    // A colour: 30 worked, 60 developing, 30 worked. Dana is free for the
    // middle hour; the chair is not.
    const colour = await prisma.service.create({
      data: {
        businessId,
        name: 'Colour',
        durationMinutes: 120,
        priceCents: 14000,
        requiredResourceTypeId: chairTypeId,
      },
    });
    await prisma.serviceProvider.create({ data: { businessId, serviceId: colour.id, providerId: providerIds[0]! } });
    await prisma.serviceSegment.createMany({
      data: [
        { businessId, serviceId: colour.id, ordinal: 0, durationMinutes: 30, isGap: false },
        { businessId, serviceId: colour.id, ordinal: 1, durationMinutes: 60, isGap: true },
        { businessId, serviceId: colour.id, ordinal: 2, durationMinutes: 30, isGap: false },
      ],
    });
    await book({ serviceIds: [colour.id] });

    // Dana is genuinely free at 10:30 — the provider axis permits it — and
    // takes a second client, who needs the OTHER chair.
    const inGap = await book({ startAt: at('2026-06-09T10:30:00-05:00') });
    const inGapRow = await prisma.appointment.findUniqueOrThrow({
      where: { id: inGap.id },
      include: { resource: true },
    });
    expect(inGapRow.resource!.name).toBe('Chair 2');

    // ...and now the room is full, even though Priya and Marcus are both idle.
    // This is the booking D-20's premise said could never happen.
    await expect(book({ providerId: providerIds[1]! })).rejects.toBeInstanceOf(NoResourceFree);
  });
});

describe('the constraint is the enforcer, not the chooser (D-2, D-30)', () => {
  it('refuses a hand-written double-hold of one chair, bypassing the app entirely', async () => {
    const first = await book();
    const firstRow = await prisma.appointment.findUniqueOrThrow({ where: { id: first.id } });
    // A second appointment that holds NO chair (an override), so this is a
    // genuinely different appointment reaching for a chair already held —
    // rather than a duplicate hold, which the one-hold-per-appointment index
    // would refuse for an unrelated reason.
    const other = await book({
      providerId: providerIds[1]!,
      isOverride: true,
      overrideReason: 'test fixture',
    });
    const message = await prisma
      .$executeRawUnsafe(
        `INSERT INTO "AppointmentResourceHold"
           ("id","businessId","appointmentId","resourceId","status","blockedStart","blockedEnd")
         VALUES ('sneaky',$1,$2,$3,'booked',$4::timestamptz,$5::timestamptz)`,
        businessId,
        other.id,
        firstRow.resourceId,
        firstRow.blockedStart.toISOString(),
        firstRow.blockedEnd.toISOString(),
      )
      .then(
        () => '',
        (e: { message?: string }) => e.message ?? '',
      );
    // Named, so this cannot pass because of some unrelated failure.
    expect(message).toContain('appointment_resource_no_overlap');
  });

  it('a staff override holds NO chair, so the constraint never refuses a knowing decision', async () => {
    await book();
    await book({ providerId: providerIds[1]! });
    const override = await book({
      providerId: providerIds[2]!,
      isOverride: true,
      overrideReason: 'squeezing her in at the backwash',
    });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: override.id } });
    expect(row.resourceId).toBeNull();
    expect(await prisma.appointmentResourceHold.count({ where: { appointmentId: row.id } })).toBe(0);
  });
});

describe('findFreeResource', () => {
  it('returns null when every chair is taken', async () => {
    await book();
    await book({ providerId: providerIds[1]! });
    const free = await findFreeResource(prisma, {
      businessId,
      resourceTypeId: chairTypeId,
      start: at('2026-06-09T10:00:00-05:00'),
      end: at('2026-06-09T11:00:00-05:00'),
    });
    expect(free).toBeNull();
  });

  it('ignores a service that needs no resource at all', async () => {
    const consult = await prisma.service.create({
      data: { businessId, name: 'Phone consult', durationMinutes: 15, priceCents: 0 },
    });
    await prisma.serviceProvider.create({ data: { businessId, serviceId: consult.id, providerId: providerIds[2]! } });
    await book();
    await book({ providerId: providerIds[1]! });
    // Both chairs are taken and this still books, because it needs none.
    const appointment = await book({ providerId: providerIds[2]!, serviceIds: [consult.id] });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.resourceId).toBeNull();
  });
});

// Referenced so the import is used even if the SlotTaken path moves.
void SlotTaken;
