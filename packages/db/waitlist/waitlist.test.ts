/**
 * A-023 — waitlist entries and fit-aware matching (WAIT-01, WAIT-02).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { calendarDay, wallTime } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import {
  WaitlistEntryRejected,
  createWaitlistEntry,
  listWaitlistEntries,
  matchFreedSlot,
  setWaitlistEntryStatus,
} from './waitlist';

const prisma = new PrismaClient();

let businessId: string;
let danaId: string;
let priyaId: string;
let colourId: string;
let cutId: string;
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
    data: { name: 'Shear Genius', timezone: 'America/Chicago', minimumLeadMinutes: 0, bookingHorizonDays: 365 },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana', displayOrder: 0 } });
  const priya = await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } });
  danaId = dana.id;
  priyaId = priya.id;

  // Unequal buffers (project convention) — a bug that swaps before/after
  // would still pass an equal-buffer fixture.
  const colour = await prisma.service.create({
    data: { businessId, name: 'Colour', durationMinutes: 90, bufferBeforeMinutes: 5, bufferAfterMinutes: 15, priceCents: 12000 },
  });
  const cut = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 45, priceCents: 5500 },
  });
  colourId = colour.id;
  cutId = cut.id;

  // Dana runs colour a little faster than the base duration.
  await prisma.serviceProvider.create({
    data: { businessId, serviceId: colour.id, providerId: dana.id, durationOverrideMinutes: 75 },
  });
  await prisma.serviceProvider.create({ data: { businessId, serviceId: colour.id, providerId: priya.id } });

  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;
});

describe('createWaitlistEntry', () => {
  it('rejects an inverted range', async () => {
    await expect(
      createWaitlistEntry(prisma, {
        businessId,
        clientId,
        serviceId: colourId,
        providerIds: [],
        fromDay: '2026-09-01',
        toDay: '2026-08-01',
        dayParts: [],
      }),
    ).rejects.toThrow(WaitlistEntryRejected);
  });

  it('rejects a day-part outside the closed vocabulary', async () => {
    await expect(
      createWaitlistEntry(prisma, {
        businessId,
        clientId,
        serviceId: colourId,
        providerIds: [],
        fromDay: '2026-08-01',
        toDay: '2026-09-01',
        dayParts: ['whenever'],
      }),
    ).rejects.toThrow(WaitlistEntryRejected);
  });

  it('rejects a provider not on this business', async () => {
    const other = await prisma.business.create({ data: { name: 'Other Salon', timezone: 'America/Chicago' } });
    const stranger = await prisma.provider.create({ data: { businessId: other.id, displayName: 'Someone Else' } });
    await expect(
      createWaitlistEntry(prisma, {
        businessId,
        clientId,
        serviceId: colourId,
        providerIds: [stranger.id],
        fromDay: '2026-08-01',
        toDay: '2026-09-01',
        dayParts: [],
      }),
    ).rejects.toThrow(WaitlistEntryRejected);
  });

  it('creates and shapes the row — "any Saturday morning, Dana or Priya"', async () => {
    const entry = await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceId: colourId,
      providerIds: [danaId, priyaId],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: ['saturday', 'morning'],
    });
    expect(entry.clientName).toBe('Ada Chen');
    expect(entry.serviceName).toBe('Colour');
    expect(entry.status).toBe('active');
  });
});

describe('listWaitlistEntries', () => {
  it('lists active entries oldest first, and status filters', async () => {
    const first = await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceId: colourId,
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });
    const second = await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceId: cutId,
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });

    expect((await listWaitlistEntries(prisma, businessId)).map((e) => e.id)).toEqual([first.id, second.id]);

    await setWaitlistEntryStatus(prisma, { businessId, entryId: first.id, status: 'fulfilled' });
    expect((await listWaitlistEntries(prisma, businessId)).map((e) => e.id)).toEqual([second.id]);
    expect((await listWaitlistEntries(prisma, businessId, 'fulfilled')).map((e) => e.id)).toEqual([first.id]);
  });
});

describe('matchFreedSlot', () => {
  const saturdayMorning = { day: calendarDay('2026-08-22'), time: wallTime('09:00') }; // a Saturday

  it('matches an "any provider" entry whose service fits, with Dana\'s own duration', async () => {
    const entry = await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceId: colourId,
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });

    // Dana's override: 75 + 5 + 15 = 95 minutes footprint.
    const matches = await matchFreedSlot(prisma, {
      businessId,
      providerId: danaId,
      serviceId: colourId,
      ...saturdayMorning,
      freedMinutes: 95,
    });
    expect(matches.map((m) => m.id)).toEqual([entry.id]);
  });

  it('does not fit when the freed window is shorter than the footprint', async () => {
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceId: colourId,
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });

    const matches = await matchFreedSlot(prisma, {
      businessId,
      providerId: danaId,
      serviceId: colourId,
      ...saturdayMorning,
      freedMinutes: 94,
    });
    expect(matches).toEqual([]);
  });

  it('excludes an entry that named other providers', async () => {
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceId: colourId,
      providerIds: [priyaId],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });

    const matches = await matchFreedSlot(prisma, {
      businessId,
      providerId: danaId,
      serviceId: colourId,
      ...saturdayMorning,
      freedMinutes: 95,
    });
    expect(matches).toEqual([]);
  });

  it('excludes an entry outside its date range', async () => {
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceId: colourId,
      providerIds: [],
      fromDay: '2026-09-01',
      toDay: '2026-09-30',
      dayParts: [],
    });

    const matches = await matchFreedSlot(prisma, {
      businessId,
      providerId: danaId,
      serviceId: colourId,
      ...saturdayMorning,
      freedMinutes: 95,
    });
    expect(matches).toEqual([]);
  });

  it('day-parts are a conjunction — Saturday morning misses a Saturday afternoon freed slot', async () => {
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceId: colourId,
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: ['saturday', 'morning'],
    });

    const matches = await matchFreedSlot(prisma, {
      businessId,
      providerId: danaId,
      serviceId: colourId,
      day: calendarDay('2026-08-22'),
      time: wallTime('14:00'),
      freedMinutes: 95,
    });
    expect(matches).toEqual([]);
  });

  it('a different service never matches, even for the same client and day', async () => {
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceId: cutId,
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });

    const matches = await matchFreedSlot(prisma, {
      businessId,
      providerId: danaId,
      serviceId: colourId,
      ...saturdayMorning,
      freedMinutes: 95,
    });
    expect(matches).toEqual([]);
  });
});
