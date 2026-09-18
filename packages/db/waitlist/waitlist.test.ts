/**
 * A-023 — waitlist entries and fit-aware matching (WAIT-01, WAIT-02).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromDate, instant, instantFromIso, toDate } from '../../core/time';
import { staffActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { bookAppointment } from '../booking/book';
import { SlotTaken } from '../booking/errors';
import {
  WaitlistEntryRejected,
  createWaitlistEntry,
  listWaitlistEntries,
  matchFreedSlot,
  nextBookedFor,
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

  // A-124/D-60 — THE MATCHER ASKS THE ENGINE NOW, SO THE FIXTURE NEEDS A BOOK.
  //
  // Until this item every test here was arithmetic: a number of freed minutes
  // against a composed footprint, with no hours, no rows and nothing to
  // disagree with. That is exactly the substitution the item removes — the
  // matcher was predicting the chooser's answer without asking the chooser —
  // so the fixture now has working hours and the freed span in each test is
  // carved out of a real day.
  //
  // Both patterns are written because `resolveAvailableWindows` INTERSECTS
  // them: a provider with no weekly rows of her own is closed, whatever the
  // business says.
  for (const providerId of [null, danaId, priyaId, tessId]) {
    for (let weekday = 0; weekday < 7; weekday++) {
      await prisma.weeklyWindow.create({
        data: { businessId, providerId, weekday, open: OPEN, close: CLOSE },
      });
    }
  }
});

const at = (iso: string) => toDate(instantFromIso(iso));

/** The salon's hours in this fixture. Chicago, so a summer instant is -05:00. */
const OPEN = '09:00';
const CLOSE = '19:00';
const CDT = '-05:00';

/** A Thursday, well before every Saturday these tests free time on, so the
 *  lead time and the horizon are never what decides an answer. Frozen — a test
 *  that reads the clock is wrong even when it passes. */
const NOW = at(`2026-08-19T09:00:00${CDT}`);

/**
 * Leaves exactly ONE free run in a provider's day, and returns the freed range
 * that sits inside it.
 *
 * Ad-hoc blocks rather than appointments: the run is what the engine and
 * `freeRunsFor` see once everything else is subtracted, and a block is the
 * cheapest honest way to say "the rest of that day is taken". Where a test
 * needs a real appointment sold INSIDE the freed range — which is the case
 * this whole item is about — it books one, because only a row can be partially
 * resold.
 */
async function onlyFreeFrom(
  providerId: string,
  args: { day: string; from: string; minutes: number },
): Promise<{ from: Date; to: Date }> {
  const from = at(`${args.day}T${args.from}:00${CDT}`);
  const to = toDate(instant(fromDate(from) + args.minutes * 60_000));
  const dayOpen = at(`${args.day}T${OPEN}:00${CDT}`);
  const dayClose = at(`${args.day}T${CLOSE}:00${CDT}`);
  if (fromDate(from) > fromDate(dayOpen)) {
    await prisma.adHocBlock.create({ data: { businessId, providerId, startAt: dayOpen, endAt: from, reason: 'busy' } });
  }
  if (fromDate(to) < fromDate(dayClose)) {
    await prisma.adHocBlock.create({ data: { businessId, providerId, startAt: to, endAt: dayClose, reason: 'busy' } });
  }
  return { from, to };
}

/** A freed range named on an otherwise untouched day: nothing is blocked, so
 *  the RUN around it is the whole working day. This is the shape the neighbour
 *  fixture needs and the shape every pre-A-124 test accidentally assumed. */
function freedRange(args: { day: string; from: string; minutes: number }): { from: Date; to: Date } {
  const from = at(`${args.day}T${args.from}:00${CDT}`);
  return { from, to: toDate(instant(fromDate(from) + args.minutes * 60_000)) };
}

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
      ...freedRange({ day, from: '09:00', minutes: 60 }),
      now: NOW,
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
        const matched = (await matchFreedSlot(prisma, freedOn(day))).entries.some((row) => row.id === entry.id);
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

/**
 * A-124 / D-60 — WHAT A FREED SPAN MATCHES, NOW THAT IT ASKS THE BOOK.
 *
 * Every test in here used to be arithmetic — a number of freed minutes against
 * a composed footprint — and that is precisely the substitution the item
 * removes. The fixture has hours and rows; the freed span is a range in a real
 * Saturday; and what decides an answer is `computeSlotsIn`, the same function
 * the write path runs.
 *
 * SATURDAY 2026-08-22, open 09:00–19:00. The footprints, composed per D-23 and
 * per SVC-02's overrides, because every expectation below is read off them:
 *
 *   Cut            body 45,  buffers 10/5   -> footprint 60
 *   Colour (Priya) body 90,  buffers 5/15   -> footprint 110
 *   Colour (Dana)  body 75,  buffers 5/15   -> footprint 95   (her override)
 *   Cut+Colour (Priya) body 135, 10/15      -> footprint 160
 *   Cut+Colour (Dana)  body 120, 10/15      -> footprint 145
 */
describe('matchFreedSlot', () => {
  const SATURDAY = '2026-08-22';

  const waitingFor = (serviceIds: string[], over: Partial<{ providerIds: string[]; dayParts: string[] }> = {}) =>
    createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds,
      providerIds: over.providerIds ?? [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: over.dayParts ?? [],
    });

  const match = (providerId: string, freed: { from: Date; to: Date }) =>
    matchFreedSlot(prisma, { businessId, providerId, ...freed, now: NOW });

  it("offers the whole run, at an instant the ENGINE picked — with Dana's own duration", async () => {
    const entry = await waitingFor([colourId]);
    const freed = await onlyFreeFrom(danaId, { day: SATURDAY, from: '09:00', minutes: 95 });

    const { entries, span } = await match(danaId, freed);
    expect(entries.map((m) => m.id)).toEqual([entry.id]);
    // Her footprint at Dana's chair, not the catalogue's (SVC-02).
    expect(entries[0]?.footprintMinutes).toBe(95);
    // THE INSTANT IS THE ENGINE'S. The Book link carries this, so the offer
    // and the write are asking one question; it used to carry the freed
    // range's own start for everybody.
    expect(entries[0]?.startAt).toEqual(at(`${SATURDAY}T09:00:00${CDT}`));
    expect(span?.remainder.minutes).toBe(95);
  });

  it('THE LEADING BUFFER SITS OUTSIDE THE RUN AT A WINDOW EDGE, and inside it anywhere else', async () => {
    await waitingFor([colourId]);
    // 90 minutes from OPEN: her body (75) plus the buffer AFTER her (15) is
    // exactly the run, and the 5 minutes before her fall outside it — there is
    // nobody ahead of her at nine o'clock to tidy up after. The engine allows
    // that (its window predicate is on the body), so the matcher must too: a
    // reader stricter than the write refuses work the salon needs.
    expect((await match(danaId, await onlyFreeFrom(danaId, { day: SATURDAY, from: '09:00', minutes: 90 }))).entries)
      .toHaveLength(1);
    await prisma.adHocBlock.deleteMany({ where: { businessId } });
    // One minute less and her tail runs into whoever is next: refused.
    expect((await match(danaId, await onlyFreeFrom(danaId, { day: SATURDAY, from: '09:00', minutes: 89 }))).entries)
      .toEqual([]);
  });

  it('excludes an entry that named other providers', async () => {
    await waitingFor([colourId], { providerIds: [priyaId] });
    const freed = await onlyFreeFrom(danaId, { day: SATURDAY, from: '09:00', minutes: 300 });
    expect((await match(danaId, freed)).entries).toEqual([]);
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
    const freed = await onlyFreeFrom(danaId, { day: SATURDAY, from: '09:00', minutes: 300 });
    expect((await match(danaId, freed)).entries).toEqual([]);
  });

  it('DAY-PARTS ARE JUDGED ON THE START SHE WOULD GET, not on whatever freed the span', async () => {
    await waitingFor([colourId], { dayParts: ['saturday', 'morning'] });
    // The freed range starts at two o'clock and the free run is the whole
    // afternoon: there is no morning start anywhere in it.
    const afternoon = await onlyFreeFrom(danaId, { day: SATURDAY, from: '14:00', minutes: 300 });
    expect((await match(danaId, afternoon)).entries).toEqual([]);

    // The same entry, a span that STRADDLES noon. The old matcher asked
    // `tagsFor(day, freed.time)` once, about the freed start, and would have
    // refused this whole run for the same reason. She is offered a morning
    // start inside it.
    await prisma.adHocBlock.deleteMany({ where: { businessId } });
    const straddling = await onlyFreeFrom(danaId, { day: SATURDAY, from: '11:00', minutes: 240 });
    const { entries } = await match(danaId, straddling);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.startAt.getTime()).toBeLessThan(at(`${SATURDAY}T12:00:00${CDT}`).getTime());
  });

  it('D-56 — a span freed by a service she never asked for still matches, because she fits it', async () => {
    const entry = await waitingFor([cutId]);
    // A COLOUR came free. Nothing on this call names a service at all.
    const freed = await onlyFreeFrom(danaId, { day: SATURDAY, from: '09:00', minutes: 95 });
    const { entries } = await match(danaId, freed);
    expect(entries.map((m) => m.id)).toEqual([entry.id]);
    expect(entries[0]?.footprintMinutes).toBe(60);
  });

  /**
   * THE THREE WRONG ANSWERS THE OPERATOR MEASURED AT THE PHASE 15 CLOSE, each
   * one a case where a minutes comparison and the book disagree. Every one of
   * them passed the whole suite before this item, because no fixture in it had
   * a day with anything else in it.
   */
  describe('the freed span is the RUN, not the appointment that left (D-60)', () => {
    it('A PARTIAL SALE KEEPS THE ROW: a client who fits the remainder and not the original start', async () => {
      const entry = await waitingFor([cutId, colourId], { providerIds: [danaId] });
      // A 215-minute balayage cancelled at 13:00, with a 35-minute blow-dry
      // sold into its FRONT. 13:35–16:35 is three hours of Dana's Saturday.
      const freed = await onlyFreeFrom(danaId, { day: SATURDAY, from: '13:00', minutes: 215 });
      await prisma.adHocBlock.create({
        data: {
          businessId,
          providerId: danaId,
          startAt: freed.from,
          endAt: toDate(instant(fromDate(freed.from) + 35 * 60_000)),
          reason: 'sold into the front of it',
        },
      });

      const { entries, span } = await match(danaId, freed);
      // The remainder is what the desk reads, and it starts where the blow-dry
      // ends — not where the balayage did.
      expect(span?.remainder.start).toEqual(at(`${SATURDAY}T13:35:00${CDT}`));
      expect(span?.remainder.minutes).toBe(180);
      expect(entries.map((m) => m.id)).toEqual([entry.id]);
      // AND THE INSTANT IS INSIDE THE REMAINDER. The old link carried 13:00,
      // which is the one instant in this range the write refuses.
      expect(entries[0]!.startAt.getTime()).toBeGreaterThanOrEqual(at(`${SATURDAY}T13:35:00${CDT}`).getTime());
    });

    it('A SHORT FREED RANGE BESIDE AN EMPTY STRETCH: 55 minutes back is three hours to sell', async () => {
      const entry = await waitingFor([cutId, colourId], { providerIds: [priyaId] });
      // Priya's Saturday is otherwise empty; a 55-minute cut at nine was
      // cancelled. Her visit is 160 minutes, and 160 > 55 — the old matcher
      // said nobody fits while the write accepted her at its start.
      const freed = freedRange({ day: SATURDAY, from: '09:00', minutes: 55 });
      const { entries, span } = await match(priyaId, freed);
      // The listing is still right to call it 55 minutes: the rest was already
      // open. The RUN is the whole day, and that is what she was matched into.
      expect(span?.remainder.minutes).toBe(55);
      expect(span?.run.minutes).toBe(600);
      expect(entries.map((m) => m.id)).toEqual([entry.id]);
      expect(entries[0]?.footprintMinutes).toBe(160);
    });

    it('FITS BY MINUTES, NO START ON THE GRID: the arithmetic says yes and the engine says no', async () => {
      await waitingFor([colourId], { providerIds: [danaId] });
      // Exactly her 95-minute footprint, free — and starting at five past ten.
      // The grid anchors at window open in 15-minute steps, so the only start
      // that would fit is 10:10 and the engine never offers it. A minutes
      // comparison cannot see this at all.
      const freed = await onlyFreeFrom(danaId, { day: SATURDAY, from: '10:05', minutes: 95 });
      const { entries, span } = await match(danaId, freed);
      expect(span?.remainder.minutes).toBe(95);
      expect(entries).toEqual([]);
    });

    it("A DAY THAT HAS PASSED OFFERS NOBODY — and says so rather than returning an empty list", async () => {
      await waitingFor([cutId]);
      // `matchFreedSlot`'s date filters have always used the freed day rather
      // than today, so the entry itself is live for this range. What makes it
      // unofferable is that the time is gone.
      const freed = freedRange({ day: '2026-08-15', from: '09:00', minutes: 300 });
      const answer = await matchFreedSlot(prisma, { businessId, providerId: danaId, ...freed, now: NOW });
      // `span === null` is the fact both doors word. An empty `entries` with a
      // live span means "nobody fits"; this means "there is nothing to fit".
      expect(answer.span).toBeNull();
      expect(answer.entries).toEqual([]);
    });

    it('A RANGE THAT STRADDLES LUNCH REPORTS THE SIDE HOLDING MOST OF IT — not the longest run in the day', async () => {
      // Found by the e2e sweep, not by this file: the seed gives Dana a
      // 12:00–13:00 break, and a tail freed 10:55–13:05 touches TWO runs. The
      // first version chose by RUN length, so it picked the whole afternoon —
      // which overlaps the freed range by five minutes — and the row fell under
      // A-109's floor and vanished. No fixture here had a break in it.
      const window = await prisma.weeklyWindow.findFirstOrThrow({
        where: { businessId, providerId: danaId, weekday: 6 },
      });
      await prisma.windowBreak.create({ data: { businessId, weeklyWindowId: window.id, open: '12:00', close: '13:00' } });

      const freed = freedRange({ day: SATURDAY, from: '10:55', minutes: 130 });
      const { span } = await match(danaId, freed);
      // BOTH edges (A-093's rule): an assertion on the start alone passes
      // against the wrong run's clipped sliver, since neither run starts later
      // than 13:00.
      expect(span?.remainder.start).toEqual(at(`${SATURDAY}T10:55:00${CDT}`));
      expect(span?.remainder.end).toEqual(at(`${SATURDAY}T12:00:00${CDT}`));
      expect(span?.run.start).toEqual(at(`${SATURDAY}T09:00:00${CDT}`));
    });

    it('A FULLY RESOLD RANGE IS GONE, not merely empty', async () => {
      await waitingFor([cutId]);
      const freed = freedRange({ day: SATURDAY, from: '13:00', minutes: 60 });
      await prisma.adHocBlock.create({
        data: { businessId, providerId: danaId, startAt: freed.from, endAt: freed.to, reason: 'resold' },
      });
      expect((await match(danaId, freed)).span).toBeNull();
    });
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
 * A-124 re-cut these against a real book. The lengths are unchanged; what
 * decides them is the engine rather than a subtraction.
 */
describe('matchFreedSlot — a whole visit (D-56)', () => {
  const SATURDAY = '2026-08-22';
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

  /** A run of exactly `minutes`, hemmed in on BOTH sides — so the visit's
   *  whole envelope has to fit, which is the ordinary mid-afternoon case. */
  const inARunOf = async (minutes: number, providerId = priyaId) => {
    await prisma.adHocBlock.deleteMany({ where: { businessId } });
    const freed = await onlyFreeFrom(providerId, { day: SATURDAY, from: '11:00', minutes });
    return (await matchFreedSlot(prisma, { businessId, providerId, ...freed, now: NOW })).entries;
  };

  it('THE FALSE MATCH: a run holding her first service but not her visit is refused', async () => {
    const entry = await cutThenColour();
    // 100 minutes: comfortably longer than her cut's 60-minute footprint,
    // nowhere near the 160 her appointment needs. The old matcher measured the
    // stored `Cut` and put her name against exactly this.
    expect(await inARunOf(100)).toEqual([]);
    // …and it is the LENGTH refusing her, not the entry being broken.
    expect((await inARunOf(CUT_THEN_COLOUR_AT_PRIYA + 15)).map((m) => m.id)).toEqual([entry.id]);
  });

  it('THE MISSED MATCH: a long run freed by a service that is not hers is offered', async () => {
    const entry = await cutThenColour();
    const matches = await inARunOf(190);
    expect(matches.map((m) => m.id)).toEqual([entry.id]);
    expect(matches[0]?.serviceNames).toEqual(['Cut', 'Colour']);
    expect(matches[0]?.footprintMinutes).toBe(CUT_THEN_COLOUR_AT_PRIYA);
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
    // A run hemmed in on both sides has to hold the whole envelope AND start
    // on the grid, so the two orders separate at a wider gap than the bare
    // difference between 145 and 160: colour-then-cut takes the 11:15
    // candidate here and cut-then-colour does not.
    expect((await inARunOf(160)).map((m) => m.footprintMinutes)).toEqual([145]);
    expect(await inARunOf(150)).toEqual([]);
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
    expect((await inARunOf(150, danaId)).map((m) => m.footprintMinutes)).toEqual([145]);
    // Priya's chair, the same entry, fifteen minutes longer — the same run
    // does not hold her.
    expect(await inARunOf(150, priyaId)).toEqual([]);
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
    // Tess cuts and does not colour. A whole afternoon of her time is still
    // not a run this visit fits, and the failure to rule out is the one that
    // SKIPS the unqualified line and offers her the 60-minute cut instead —
    // which fits, and is a booking the write would then refuse.
    expect(await inARunOf(400, tessId)).toEqual([]);
    // The same run, a cut-only entry, the same junior: she IS offered that, so
    // the refusal above is about the colour and not about Tess.
    await createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [cutId],
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-01',
      dayParts: [],
    });
    expect((await inARunOf(400, tessId)).map((m) => m.footprintMinutes)).toEqual([60]);
  });
});

describe('closing an entry, and naming what she already holds (A-125, D-61)', () => {
  const STAFF = staffActor('staff-1');

  const waitingForCut = () =>
    createWaitlistEntry(prisma, {
      businessId,
      clientId,
      serviceIds: [cutId],
      providerIds: [],
      fromDay: '2026-08-01',
      toDay: '2026-09-30',
      dayParts: [],
    });

  const book = (
    args: { providerId: string; startAt: Date; clientId?: string | null; waitlistEntryId?: string | null },
  ) =>
    bookAppointment(prisma, {
      businessId,
      providerId: args.providerId,
      serviceIds: [cutId],
      clientId: args.clientId === undefined ? clientId : args.clientId,
      startAt: args.startAt,
      now: NOW,
      actor: STAFF,
      audience: 'staff',
      waitlistEntryId: args.waitlistEntryId ?? null,
    });

  const statusOf = async (id: string) =>
    (await prisma.waitlistEntry.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  const matchedOn = async (providerId: string, freed: { from: Date; to: Date }) =>
    (await matchFreedSlot(prisma, { businessId, providerId, ...freed, now: NOW })).entries.map((m) => m.id);

  it('BOOKED FROM THE PANEL: the entry is fulfilled, and absent from the next span', async () => {
    const entry = await waitingForCut();
    const nextSpan = freedRange({ day: '2026-08-29', from: '10:00', minutes: 60 });
    // The premise: before the booking she IS a match for next week's span.
    expect(await matchedOn(priyaId, nextSpan)).toEqual([entry.id]);

    await book({ providerId: danaId, startAt: at(`2026-08-22T10:00:00${CDT}`), waitlistEntryId: entry.id });

    expect(await statusOf(entry.id)).toBe('fulfilled');
    expect(await matchedOn(priyaId, nextSpan)).toEqual([]);
  });

  it('A REFUSED BOOKING LEAVES HER WAITING: SlotTaken rolls the close back with it', async () => {
    const entry = await waitingForCut();
    const other = await prisma.client.create({ data: { businessId, name: 'Bea Ortiz', phone: '5125550102' } });
    const startAt = at(`2026-08-22T10:00:00${CDT}`);
    await book({ providerId: danaId, startAt, clientId: other.id });

    await expect(book({ providerId: danaId, startAt, waitlistEntryId: entry.id })).rejects.toBeInstanceOf(SlotTaken);
    expect(await statusOf(entry.id)).toBe('active');
  });

  it('closes only an ACTIVE entry of the client actually booked', async () => {
    const entry = await waitingForCut();
    const other = await prisma.client.create({ data: { businessId, name: 'Bea Ortiz', phone: '5125550102' } });

    // The desk swapped the client on the panel: Bea is booked, Ada still waits.
    await book({
      providerId: danaId,
      startAt: at(`2026-08-22T10:00:00${CDT}`),
      clientId: other.id,
      waitlistEntryId: entry.id,
    });
    expect(await statusOf(entry.id)).toBe('active');

    // Already closed is not an error, and is not reopened or rewritten.
    await setWaitlistEntryStatus(prisma, { businessId, entryId: entry.id, status: 'cancelled' });
    await book({ providerId: danaId, startAt: at(`2026-08-22T12:00:00${CDT}`), waitlistEntryId: entry.id });
    expect(await statusOf(entry.id)).toBe('cancelled');
  });

  it('"BOOKED ON THE 29TH, SOONER IF YOU CAN": she still matches, and the row can name the booking', async () => {
    const entry = await waitingForCut();
    const cancelled = await book({ providerId: priyaId, startAt: at(`2026-08-24T10:00:00${CDT}`) });
    await prisma.appointment.update({ where: { id: cancelled.id }, data: { status: 'cancelled' } });
    const later = await book({ providerId: priyaId, startAt: at(`2026-08-29T11:00:00${CDT}`) });
    const latest = await book({ providerId: danaId, startAt: at(`2026-09-05T11:00:00${CDT}`) });

    // Never a filter: a sooner span still offers her.
    const sooner = freedRange({ day: '2026-08-22', from: '10:00', minutes: 60 });
    expect(await matchedOn(danaId, sooner)).toEqual([entry.id]);

    // The EARLIEST live one — not the cancelled one before it, and not the
    // last row (a last-wins Map would name 5 Sep).
    const named = await nextBookedFor(prisma, { businessId, clientIds: [clientId], now: NOW });
    expect(named.get(clientId)).toEqual({ startAt: later.startAt, providerName: 'Priya' });

    // Once that one is past, the next one is named.
    const afterIt = await nextBookedFor(prisma, { businessId, clientIds: [clientId], now: later.endAt });
    expect(afterIt.get(clientId)).toEqual({ startAt: latest.startAt, providerName: 'Dana' });
  });
});
