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
let tessId: string;
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
    data: { businessId, name: 'Cut', durationMinutes: 45, bufferBeforeMinutes: 10, bufferAfterMinutes: 5, priceCents: 5500 },
  });
  colourId = colour.id;
  cutId = cut.id;

  // A-119 — THE JUNIOR, and she is the whole of the qualification half of
  // D-56. Tess does cuts and not colour, so a Cut+Colour entry has no
  // footprint at her chair at all: dropping the line she cannot do would
  // compose a SHORTER visit that fits more spans, which is the
  // offered-then-refused shape this repo keeps catching.
  const tess = await prisma.provider.create({ data: { businessId, displayName: 'Tess', displayOrder: 2 } });
  tessId = tess.id;

  // Dana runs colour a little faster than the base duration.
  await prisma.serviceProvider.create({
    data: { businessId, serviceId: colour.id, providerId: dana.id, durationOverrideMinutes: 75 },
  });
  await prisma.serviceProvider.create({ data: { businessId, serviceId: colour.id, providerId: priya.id } });
  for (const providerId of [dana.id, priya.id, tess.id]) {
    await prisma.serviceProvider.create({ data: { businessId, serviceId: cut.id, providerId } });
  }

  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;
});

describe('createWaitlistEntry', () => {
  it('rejects an inverted range', async () => {
    await expect(
      createWaitlistEntry(prisma, {
        businessId,
        clientId,
        serviceIds: [colourId],
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
        serviceIds: [colourId],
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
        serviceIds: [colourId],
        providerIds: [stranger.id],
        fromDay: '2026-08-01',
        toDay: '2026-09-01',
        dayParts: [],
      }),
    ).rejects.toThrow(WaitlistEntryRejected);
  });

  it('D-56 — rejects an entry with no services at all', async () => {
    // An empty array is a legal TEXT[], and an empty visit composes to a ZERO
    // footprint, which fits every span that ever frees: she would be offered
    // the whole book, forever. The column cannot say this; this is the guard.
    await expect(
      createWaitlistEntry(prisma, {
        businessId,
        clientId,
        serviceIds: [],
        providerIds: [],
        fromDay: '2026-08-01',
        toDay: '2026-09-01',
        dayParts: [],
      }),
    ).rejects.toThrow(WaitlistEntryRejected);
  });

  it('D-56 — rejects the same service twice, which would double her footprint', async () => {
    await expect(
      createWaitlistEntry(prisma, {
        businessId,
        clientId,
        serviceIds: [colourId, colourId],
        providerIds: [],
        fromDay: '2026-08-01',
        toDay: '2026-09-01',
        dayParts: [],
      }),
    ).rejects.toThrow(WaitlistEntryRejected);
  });

  it('D-56 — rejects a service that is not on this business', async () => {
    const other = await prisma.business.create({ data: { name: 'Other Salon', timezone: 'America/Chicago' } });
    const theirs = await prisma.service.create({
      data: { businessId: other.id, name: 'Perm', durationMinutes: 60, priceCents: 9000 },
    });
    await expect(
      createWaitlistEntry(prisma, {
        businessId,
        clientId,
        serviceIds: [cutId, theirs.id],
        providerIds: [],
        fromDay: '2026-08-01',
        toDay: '2026-09-01',
        dayParts: [],
      }),
    ).rejects.toThrow(WaitlistEntryRejected);
  });

  it('D-56 — keeps the visit in the order it was asked for', async () => {
    const entry = await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [cutId, colourId],
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });
    // Not sorted, not de-duplicated into a set: D-23's footprint reads the
    // first and last entries of this array.
    expect(entry.serviceIds).toEqual([cutId, colourId]);
    expect(entry.serviceNames).toEqual(['Cut', 'Colour']);
  });

  it('creates and shapes the row — "any Saturday morning, Dana or Priya"', async () => {
    const entry = await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [colourId],
      providerIds: [danaId, priyaId],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: ['saturday', 'morning'],
    });
    expect(entry.clientName).toBe('Ada Chen');
    expect(entry.serviceNames).toEqual(['Colour']);
    expect(entry.status).toBe('active');
  });
});

describe('listWaitlistEntries', () => {
  it('lists active entries oldest first, and status filters', async () => {
    const first = await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [colourId],
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });
    const second = await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [cutId],
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
            day: calendarDay(day),
      time: wallTime('09:00'),
      freedMinutes: 60,
    });

    async function waiting() {
      return createWaitlistEntry(prisma, {
        businessId,
        clientId,
        serviceIds: [cutId],
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
        serviceIds: [cutId],
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
      serviceIds: [colourId],
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });

    // Dana's override: 75 + 5 + 15 = 95 minutes footprint.
    const matches = await matchFreedSlot(prisma, {
      businessId,
      providerId: danaId,
      ...saturdayMorning,
      freedMinutes: 95,
    });
    expect(matches.map((m) => m.id)).toEqual([entry.id]);
  });

  it('does not fit when the freed window is shorter than the footprint', async () => {
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [colourId],
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });

    const matches = await matchFreedSlot(prisma, {
      businessId,
      providerId: danaId,
      ...saturdayMorning,
      freedMinutes: 94,
    });
    expect(matches).toEqual([]);
  });

  it('excludes an entry that named other providers', async () => {
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [colourId],
      providerIds: [priyaId],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });

    const matches = await matchFreedSlot(prisma, {
      businessId,
      providerId: danaId,
      ...saturdayMorning,
      freedMinutes: 95,
    });
    expect(matches).toEqual([]);
  });

  it('excludes an entry outside its date range', async () => {
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [colourId],
      providerIds: [],
      fromDay: '2026-09-01',
      toDay: '2026-09-30',
      dayParts: [],
    });

    const matches = await matchFreedSlot(prisma, {
      businessId,
      providerId: danaId,
      ...saturdayMorning,
      freedMinutes: 95,
    });
    expect(matches).toEqual([]);
  });

  it('day-parts are a conjunction — Saturday morning misses a Saturday afternoon freed slot', async () => {
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [colourId],
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: ['saturday', 'morning'],
    });

    const matches = await matchFreedSlot(prisma, {
      businessId,
      providerId: danaId,
            day: calendarDay('2026-08-22'),
      time: wallTime('14:00'),
      freedMinutes: 95,
    });
    expect(matches).toEqual([]);
  });

  it('D-56 — a span freed by a service she never asked for still matches, because she fits it', async () => {
    const entry = await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [cutId],
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });

    // A COLOUR came free. Before D-56 this filtered `serviceId` in SQL and
    // returned nobody: a waiting cut was invisible to every span the salon
    // did not free by cutting somebody's hair. Her footprint at Dana is
    // 10 + 45 + 5 = 60, and there are 95 minutes going spare.
    const matches = await matchFreedSlot(prisma, {
      businessId,
      providerId: danaId,
      ...saturdayMorning,
      freedMinutes: 95,
    });
    expect(matches.map((m) => m.id)).toEqual([entry.id]);
    expect(matches[0]?.footprintMinutes).toBe(60);
  });
});

/**
 * A-119 / D-56 — THE TWO-SERVICE VISIT, WHICH IS HALF THE SALON'S SATURDAY.
 *
 * The operator measured this before it was built: a Cut+Colour waitlisting
 * stored as `Cut` MATCHED a freed cut that cannot hold her appointment and was
 * NOT offered the three-hour span that can. The two errors run in OPPOSITE
 * directions, so the fixture has to run both ways against the same entry —
 * asserting only the second would pass against the bug that was there.
 *
 * Priya has no overrides, so her Cut+Colour is D-23's composition of the
 * catalogue: the FIRST line's `bufferBefore` (cut, 10) + 45 + 90 + the LAST
 * line's `bufferAfter` (colour, 15) = 160. Buffers do NOT stack between the
 * lines — the 5 and the 10 in the middle are the client sitting in the chair,
 * not the chair being tidied between clients.
 */
describe('matchFreedSlot — a whole visit (D-56)', () => {
  const saturdayMorning = { day: calendarDay('2026-08-22'), time: wallTime('09:00') };
  const CUT_THEN_COLOUR_AT_PRIYA = 160;

  const cutThenColour = () =>
    createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [cutId, colourId],
      providerIds: [priyaId],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });

  const at = (freedMinutes: number, providerId = priyaId) =>
    matchFreedSlot(prisma, { businessId, providerId, ...saturdayMorning, freedMinutes });

  it('THE FALSE MATCH: a span holding her first service but not her visit is refused', async () => {
    const entry = await cutThenColour();
    // 100 minutes: comfortably longer than her cut's 60-minute footprint,
    // nowhere near the 160 her appointment needs. The old matcher measured
    // the stored `Cut` and put her name against exactly this.
    expect(await at(100)).toEqual([]);
    // …and it is the LENGTH refusing her, not the entry being broken.
    expect((await at(CUT_THEN_COLOUR_AT_PRIYA)).map((m) => m.id)).toEqual([entry.id]);
  });

  it('THE MISSED MATCH: a long span freed by a service that is not hers is offered', async () => {
    const entry = await cutThenColour();
    // Nothing on this call names a service at all any more — the structural
    // half of D-56. A 190-minute hole in Priya's Saturday holds her whole
    // visit, and what vacated it is not a question the matcher can ask.
    const matches = await at(190);
    expect(matches.map((m) => m.id)).toEqual([entry.id]);
    expect(matches[0]?.serviceNames).toEqual(['Cut', 'Colour']);
    expect(matches[0]?.footprintMinutes).toBe(CUT_THEN_COLOUR_AT_PRIYA);
  });

  it('EXACTLY the footprint fits, and one minute under does not', async () => {
    await cutThenColour();
    expect((await at(CUT_THEN_COLOUR_AT_PRIYA)).length).toBe(1);
    expect(await at(CUT_THEN_COLOUR_AT_PRIYA - 1)).toEqual([]);
  });

  it('ORDER IS THE FOOTPRINT: colour-then-cut is a different length from cut-then-colour', async () => {
    // 5 + 90 + 45 + 5 = 145, against 160 the other way round. Same two
    // services, same provider; only the ENDS differ, which is exactly what
    // D-23 composes. A matcher that sorted or de-duplicated these ids would
    // quietly re-price every combination booking in the salon.
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [colourId, cutId],
      providerIds: [priyaId],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });
    expect((await at(145)).map((m) => m.footprintMinutes)).toEqual([145]);
    expect(await at(144)).toEqual([]);
  });

  it("composes at THIS provider's own durations, not the catalogue's", async () => {
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      // No preference: she will take whoever, so ONE entry is measured
      // against two different chairs.
      serviceIds: [cutId, colourId],
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });
    // Dana colours in 75 rather than 90 (SVC-02): 10 + 45 + 75 + 15 = 145.
    expect((await at(145, danaId)).map((m) => m.footprintMinutes)).toEqual([145]);
    expect(await at(144, danaId)).toEqual([]);
    // Priya's chair, the same entry, fifteen minutes longer.
    expect(await at(145)).toEqual([]);
  });

  it('A LINE SHE CANNOT DO IS A REFUSAL, NOT A ZERO — the junior is never offered the visit', async () => {
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [cutId, colourId],
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });
    // Tess cuts and does not colour. A whole day of her time is still not a
    // span this visit fits, and the failure to rule out is the one that SKIPS
    // the unqualified line and offers her the 60-minute cut instead — which
    // fits, and is a booking the write would then refuse.
    expect(await at(600, tessId)).toEqual([]);
    // The same span, a cut-only entry, the same junior: she IS offered that,
    // so the refusal above is about the colour and not about Tess.
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [cutId],
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });
    expect((await at(600, tessId)).map((m) => m.footprintMinutes)).toEqual([60]);
  });
});
