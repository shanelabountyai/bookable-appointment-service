/**
 * A-043 — what's opened up (WAIT-02).
 *
 * Almost every test here is a BOUND, on purpose. The list's whole risk is
 * being unbounded: `appointmentsInRange` next door has no lower time bound
 * anywhere, which is right there — its window is the absence being written —
 * and would be ruinous here, where an unbounded query means every cancellation
 * the salon has ever taken, with a count badge to match. So the fixtures prove
 * what is NOT on the list before they prove what is.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { listOpenedSlots } from './opened';

const prisma = new PrismaClient();

const at = (iso: string) => toDate(instantFromIso(iso));

/** Frozen, and every fixture is relative to it. A test that reads the clock is
 *  wrong even when it passes (CLAUDE.md). */
const NOW = at('2026-08-15T10:00:00-05:00');
/** Yesterday, in the salon's book — comfortably inside the lookback. */
const CANCELLED_AT = at('2026-08-14T09:00:00-05:00');

let businessId: string;
let providerId: string;
let serviceId: string;
let colourId: string;
let clientId: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const business = await prisma.business.create({ data: { name: 'Shear Genius', timezone: 'America/Chicago' } });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  providerId = dana.id;

  const cut = await prisma.service.create({ data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 } });
  const colour = await prisma.service.create({
    data: { businessId, name: 'Colour', durationMinutes: 90, priceCents: 12000 },
  });
  serviceId = cut.id;
  colourId = colour.id;
  await prisma.serviceProvider.createMany({
    data: [
      { businessId, serviceId: cut.id, providerId: dana.id },
      { businessId, serviceId: colour.id, providerId: dana.id },
    ],
  });

  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;
});

/**
 * Written directly rather than booked-then-cancelled: the point of every
 * fixture below is one axis (when it starts, when it was cancelled, what is
 * over it now), and `bookAppointment` would drag lead times and windows in.
 * The blocked range and its `AppointmentBlock` rows are trigger-written either
 * way, which is the part these assertions actually depend on.
 */
async function seed(options: {
  day: string;
  hour: string;
  endHour: string;
  status?: string;
  service?: string;
  provider?: string;
  isOverride?: boolean;
  cancelledAt?: Date;
}) {
  const startAt = at(`${options.day}T${options.hour}:00-05:00`);
  const endAt = at(`${options.day}T${options.endHour}:00-05:00`);
  const appointment = await prisma.appointment.create({
    data: {
      businessId,
      providerId: options.provider ?? providerId,
      clientId,
      status: (options.status ?? 'cancelled') as 'cancelled',
      startAt,
      endAt,
      blockedStart: startAt,
      blockedEnd: endAt,
      startDay: options.day,
      startWallTime: options.hour,
      isOverride: options.isOverride ?? false,
      lines: {
        create: { businessId, serviceId: options.service ?? serviceId, ordinal: 0, priceCents: 5500, durationMinutes: 60 },
      },
    },
  });
  // ALWAYS stamped, never left to the real clock: `updatedAt` is what the
  // lookback reads, and a fixture that inherits `now()` makes this suite pass
  // or fail depending on the day it is run. Raw, because `@updatedAt` would
  // overwrite anything the client sent.
  const cancelledAt = options.cancelledAt ?? CANCELLED_AT;
  await prisma.$executeRaw`UPDATE "Appointment" SET "updatedAt" = ${cancelledAt} WHERE "id" = ${appointment.id}`;
  return appointment;
}

const list = () => listOpenedSlots(prisma, { businessId, now: NOW });

describe('the bounds', () => {
  it('drops a slot whose time has already passed — yesterday cannot be sold', async () => {
    await seed({ day: '2026-08-14', hour: '14:00', endHour: '15:00' });

    expect(await list()).toHaveLength(0);
  });

  it('drops a cancellation older than the lookback, however open the slot still is', async () => {
    await seed({
      day: '2026-09-30',
      hour: '14:00',
      endHour: '15:00',
      cancelledAt: at('2026-07-01T09:00:00-05:00'),
    });

    expect(await list()).toHaveLength(0);
    // …and it is the lookback doing it, not the September date.
    expect(await listOpenedSlots(prisma, { businessId, now: NOW, lookbackDays: 365 })).toHaveLength(1);
  });

  it('drops a slot somebody has already re-booked', async () => {
    await seed({ day: '2026-08-20', hour: '14:00', endHour: '15:00' });
    await seed({ day: '2026-08-20', hour: '14:30', endHour: '15:30', status: 'booked' });

    expect(await list()).toHaveLength(0);
  });

  it('drops a slot the provider is now off for — that is the conflicts screen, not a thing to sell', async () => {
    await seed({ day: '2026-08-20', hour: '14:00', endHour: '15:00' });
    await prisma.timeOff.create({
      data: {
        businessId,
        providerId,
        startAt: at('2026-08-20T09:00:00-05:00'),
        endAt: at('2026-08-20T17:00:00-05:00'),
        reason: 'sick',
      },
    });

    expect(await list()).toHaveLength(0);
  });

  it.each(['no_show', 'completed'])('drops %s — terminal, but it still occupies its time (D-7)', async (status) => {
    await seed({ day: '2026-08-20', hour: '14:00', endHour: '15:00', status });

    expect(await list()).toHaveLength(0);
  });

  it('drops a cancelled override — a zero-width range never held any time to give back', async () => {
    await seed({ day: '2026-08-20', hour: '14:00', endHour: '15:00', isOverride: true });

    expect(await list()).toHaveLength(0);
  });

  it('drops a slot on a provider who has since been deactivated', async () => {
    await seed({ day: '2026-08-20', hour: '14:00', endHour: '15:00' });
    await prisma.provider.update({ where: { id: providerId }, data: { active: false } });

    expect(await list()).toHaveLength(0);
  });
});

describe('what is on it', () => {
  it('reports the freed interval with everything a phone call needs', async () => {
    await seed({ day: '2026-08-20', hour: '14:00', endHour: '17:00', service: colourId });

    const [slot] = await list();

    expect(slot).toMatchObject({
      providerName: 'Dana',
      clientName: 'Ada Chen',
      clientPhone: '5125550101',
      serviceNames: ['Colour'],
      primaryServiceId: colourId,
      freedMinutes: 180,
      status: 'cancelled',
    });
  });

  it.each(['cancelled', 'cancelled_late'])('counts %s — both free the slot', async (status) => {
    await seed({ day: '2026-08-20', hour: '14:00', endHour: '15:00', status });

    expect(await list()).toHaveLength(1);
  });

  it('orders by how soon the time expires, not by when it was cancelled', async () => {
    // Cancelled a week ago, and it dies first.
    await seed({
      day: '2026-08-18',
      hour: '14:00',
      endHour: '15:00',
      cancelledAt: at('2026-08-08T09:00:00-05:00'),
    });
    // Cancelled this morning, and there is a fortnight to fill it.
    await seed({ day: '2026-08-29', hour: '11:00', endHour: '12:00' });

    const slots = await list();

    expect(slots.map((s) => s.startAt)).toEqual([
      at('2026-08-18T14:00:00-05:00'),
      at('2026-08-29T11:00:00-05:00'),
    ]);
  });

  it('is scoped to the business', async () => {
    const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });
    await seed({ day: '2026-08-20', hour: '14:00', endHour: '15:00' });

    expect(await listOpenedSlots(prisma, { businessId: other.id, now: NOW })).toHaveLength(0);
  });
});
