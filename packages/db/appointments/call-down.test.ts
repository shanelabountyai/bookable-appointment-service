/**
 * A-021 against a real database (APPT-02).
 *
 * The list is DERIVED from `status`, so the interesting case is which
 * statuses count as "not yet confirmed" — `booked` and nothing else, in
 * particular not `confirmed` itself and not any of the ways an appointment
 * can already be off tomorrow's book.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { listUnconfirmedTomorrow } from './call-down';

const prisma = new PrismaClient();

const at = (iso: string) => toDate(instantFromIso(iso));

const TOMORROW = '2026-08-20';
const ELSEWHERE = '2026-08-21';

let businessId: string;
let providerId: string;
let serviceId: string;
let clientId: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const business = await prisma.business.create({
    data: { name: 'Shear Genius', timezone: 'America/Chicago' },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  providerId = dana.id;
  const cut = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 },
  });
  serviceId = cut.id;
  await prisma.serviceProvider.create({ data: { businessId, serviceId: cut.id, providerId: dana.id } });

  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;
});

async function seed(options: { day: string; status: string; hour: string }) {
  const startAt = at(`${options.day}T${options.hour}:00-05:00`);
  const endAt = at(`${options.day}T${options.hour === '09:00' ? '10:00' : '16:00'}:00-05:00`);
  await prisma.appointment.create({
    data: {
      businessId,
      providerId,
      clientId,
      status: options.status as 'booked',
      startAt,
      endAt,
      blockedStart: startAt,
      blockedEnd: endAt,
      startDay: options.day,
      startWallTime: options.hour,
      lines: { create: { businessId, serviceId, ordinal: 0, priceCents: 5500, durationMinutes: 60 } },
    },
  });
}

describe('listUnconfirmedTomorrow', () => {
  it('finds a booked appointment on the given day', async () => {
    await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });

    const rows = await listUnconfirmedTomorrow(prisma, { businessId, tomorrow: TOMORROW });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerName: 'Dana',
      clientName: 'Ada Chen',
      clientPhone: '5125550101',
      serviceNames: ['Cut'],
    });
  });

  it('excludes confirmed — she already had her call', async () => {
    await seed({ day: TOMORROW, status: 'confirmed', hour: '15:00' });

    expect(await listUnconfirmedTomorrow(prisma, { businessId, tomorrow: TOMORROW })).toHaveLength(0);
  });

  it.each(['cancelled', 'cancelled_late', 'no_show', 'completed'])(
    'excludes %s — not tomorrow’s problem anymore',
    async (status) => {
      await seed({ day: TOMORROW, status, hour: '15:00' });

      expect(await listUnconfirmedTomorrow(prisma, { businessId, tomorrow: TOMORROW })).toHaveLength(0);
    },
  );

  it('excludes a booked appointment on a different day', async () => {
    await seed({ day: ELSEWHERE, status: 'booked', hour: '15:00' });

    expect(await listUnconfirmedTomorrow(prisma, { businessId, tomorrow: TOMORROW })).toHaveLength(0);
  });

  it('sorts by time', async () => {
    await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });
    await seed({ day: TOMORROW, status: 'booked', hour: '09:00' });

    const rows = await listUnconfirmedTomorrow(prisma, { businessId, tomorrow: TOMORROW });

    expect(rows.map((r) => r.startAt.getTime())).toEqual([...rows.map((r) => r.startAt.getTime())].sort((a, b) => a - b));
    expect(rows[0]!.startAt.getTime()).toBeLessThan(rows[1]!.startAt.getTime());
  });
});
