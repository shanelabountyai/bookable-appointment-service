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

    const today = '2026-08-15';
    expect((await listWaitlistEntries(prisma, { businessId, today })).map((e) => e.id)).toEqual([first.id, second.id]);

    await setWaitlistEntryStatus(prisma, { businessId, entryId: first.id, status: 'fulfilled' });
    expect((await listWaitlistEntries(prisma, { businessId, today })).map((e) => e.id)).toEqual([second.id]);
    expect((await listWaitlistEntries(prisma, { businessId, today, status: 'fulfilled' })).map((e) => e.id)).toEqual([
      first.id,
    ]);
  });

  /**
   * A-110 — AN ENTRY EXPIRES WITH ITS OWN WINDOW, AND THE TWO HALVES OF THE
   * FEATURE MUST SAY SO TOGETHER.
   *
   * `expired` is in the enum and nothing has ever written it, so the standing
   * queue showed an entry whose `toDay` was in June all through September —
   * looking exactly like somebody to ring — while `matchFreedSlot` refused to
   * match her against anything that could still open up. Silently dead and
   * visibly live.
   *
   * THE ASSERTION THAT DEFINES THE ITEM IS THE EQUALITY, not either half on
   * its own: this repo has now caught the same shape five times (A-093's map,
   * checkpoint 6's `canSeat`, A-108's badge, A-109's floor), and "make them
   * agree" only holds if a test says out loud that they do.
   *
   * A ONE-DAY WINDOW CANNOT SEE IT — on `fromDay === toDay === today` the
   * wrong question and the right one return the same list — so the window
   * here is three weeks long and the walk crosses its closing edge.
   */
  describe('expiry, derived from toDay (A-110)', () => {
    // fromDay far enough back that `fromDay <= day` is never what decides an
    // answer: the ONLY edge under test is the closing one.
    const FROM = '2026-08-01';
    const TO = '2026-08-22'; // a Saturday, and the last day she would take.

    /** Cut, any stylist, any day-part: everything except the window itself is
     *  satisfied, so a disagreement can only be the window. 60 freed minutes
     *  against a 45-minute footprint fits with room to spare. */
    const freedOn = (day: string) => ({
      businessId,
      providerId: danaId,
      serviceId: cutId,
      day: calendarDay(day),
      time: wallTime('09:00'),
      freedMinutes: 60,
    });

    async function waiting() {
      return createWaitlistEntry(prisma, {
        businessId,
        clientId,
        serviceId: cutId,
        providerIds: [],
        fromDay: FROM,
        toDay: TO,
        dayParts: [],
      });
    }

    it('is on the queue up to and including its last day, and gone the day after', async () => {
      const entry = await waiting();
      const listedOn = async (today: string) =>
        (await listWaitlistEntries(prisma, { businessId, today })).some((row) => row.id === entry.id);

      expect(await listedOn('2026-08-21')).toBe(true);
      // Inclusive: "up to Saturday the 22nd" includes Saturday the 22nd.
      expect(await listedOn(TO)).toBe(true);
      expect(await listedOn('2026-08-23')).toBe(false);
      expect(await listedOn('2026-09-09')).toBe(false);
    });

    it('is still on the queue when its window has not opened yet', async () => {
      const entry = await createWaitlistEntry(prisma, {
        businessId,
        clientId,
        serviceId: cutId,
        providerIds: [],
        fromDay: '2026-10-01',
        toDay: '2026-10-31',
        dayParts: [],
      });
      // "Not started" is not "lapsed", and a queue that hid her would lose
      // every client who rang in September about half-term.
      expect((await listWaitlistEntries(prisma, { businessId, today: '2026-09-09' })).map((r) => r.id)).toEqual([
        entry.id,
      ]);
    });

    it('the queue and the matcher agree on every day across the closing edge', async () => {
      const entry = await waiting();
      for (const day of ['2026-08-20', '2026-08-21', TO, '2026-08-23', '2026-08-24', '2026-09-09']) {
        const listed = (await listWaitlistEntries(prisma, { businessId, today: day })).some(
          (row) => row.id === entry.id,
        );
        const matched = (await matchFreedSlot(prisma, freedOn(day))).some((row) => row.id === entry.id);
        // The desk works ONE day at a time: whoever is on the queue that day
        // is exactly whoever an hour freeing that day could be offered to.
        expect(matched, `the two halves disagree about ${day}`).toBe(listed);
      }
    });

    it('a fulfilled entry stays readable however long ago its window was', async () => {
      const entry = await waiting();
      await setWaitlistEntryStatus(prisma, { businessId, entryId: entry.id, status: 'fulfilled' });
      // Expiry qualifies `active` only. Date-filtering history would make the
      // status filter lie about what the salon actually did last month.
      expect(
        (await listWaitlistEntries(prisma, { businessId, today: '2026-12-25', status: 'fulfilled' })).map((r) => r.id),
      ).toEqual([entry.id]);
    });
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
