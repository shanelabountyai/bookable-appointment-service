/**
 * A-106 — "WHEN CAN YOU FIT ME IN?", ASKED FROM THE DESK.
 *
 * `daysWithAvailability` and `anyProviderDays` have both taken an `audience`
 * since they were written, and every one of the four call sites passed
 * `'public'`: the customer answers this for herself on `/manage/{token}` and
 * the salon could not. A parameter with a default is a decision nobody ever
 * makes again — so the tests that matter are the ones that would fail if a
 * surface quietly reverted to the default, and the ones that prove the day
 * list and the day itself are the SAME opinion.
 *
 * THE FIXTURE IS THE ITEM (A-100's rule, third time). On the seeded book
 * everybody works the same days, so "tomorrow" is always the answer and a
 * search that walks exactly one day passes every assertion anybody would
 * write. Dana is therefore GONE FOR A WEEK here — one `TimeOff` row spanning
 * nine days, which is what "off with flu" actually looks like — and the
 * assertions below are about the SIZE of the gap, never merely that a day came
 * back.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { staffActor } from '../../core/auth';
import { addDays, calendarDay, instantFromIso, toDate } from '../../core/time';
import { resetDatabase } from '../testing';
import { seedSetup } from '../settings';
import { createAdHocBlock, createTimeOff } from '../availability';
import { anyProviderDays } from '../booking/any-provider';
import { bookAppointment } from '../booking/book';
import { daysForMove, rescheduleOptions } from '../appointments/reschedule';
import { DESK_DAY_SEARCH_DAYS, computeDaySlots, daysWithAvailability, deskSearchLastDay } from './slot-query';

const prisma = new PrismaClient();
const ACTOR = staffActor('staff-1');
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const at = (iso: string) => toDate(instantFromIso(iso));

/** Tuesday, the first day of the seed's working week. */
const DAY = '2026-06-09';
const NOW = at('2026-06-09T08:00:00-05:00');

/**
 * NINE DAYS OFF, opened before the salon does on the Tuesday and closed after
 * it shuts on the following Wednesday. Not seven: a week off that starts on a
 * Tuesday puts her back on a Tuesday, and a fixture whose gap happens to equal
 * the weekly cycle cannot tell "she is back" from "it is Tuesday again".
 */
const AWAY_FROM = '2026-06-09T00:00:00-05:00';
const AWAY_UNTIL = '2026-06-17T23:59:00-05:00';
/** The first day the salon is open after that: Thursday 18 June. */
const BACK = '2026-06-18';

let businessId: string;
let providerByName: Record<string, string> = {};
let serviceByName: Record<string, string> = {};

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const setup = await seedSetup(prisma);
  businessId = setup.businessId;
  const providers = await prisma.provider.findMany({ where: { businessId } });
  providerByName = Object.fromEntries(providers.map((p) => [p.displayName, p.id]));
  const services = await prisma.service.findMany({ where: { businessId } });
  serviceByName = Object.fromEntries(services.map((s) => [s.name, s.id]));
});

const dana = () => providerByName['Dana']!;
const cut = () => serviceByName['Cut']!;

const daysAway = () =>
  createTimeOff(prisma, { businessId, providerId: dana(), startAt: at(AWAY_FROM), endAt: at(AWAY_UNTIL) }, STAMP);

const deskDays = (over: Record<string, unknown> = {}) =>
  daysWithAvailability(prisma, {
    businessId,
    providerId: dana(),
    serviceIds: [cut()],
    fromDay: DAY,
    toDay: deskSearchLastDay(DAY),
    now: NOW,
    audience: 'staff',
    ...over,
  });

describe('A-106 — the desk can name the day she is back', () => {
  it('walks PAST a multi-day absence rather than stopping at tomorrow', async () => {
    await daysAway();
    const days = await deskDays();

    // The assertion that a one-day walk cannot pass. Nine days of absence
    // means the first answer is EIGHT calendar days out, not one — and a
    // search capped at A-103's week would have returned nothing at all.
    expect(days[0]).toBe(BACK);
    expect(days).not.toContain('2026-06-10');
    expect(days).not.toContain('2026-06-13');
    expect(days).not.toContain('2026-06-16');
    // Still inside the fortnight, and there is more than one day in the answer
    // — a list that stopped at the first hit would be a different feature.
    expect(days.length).toBeGreaterThan(1);
    expect(days.every((day) => day <= deskSearchLastDay(DAY))).toBe(true);
  });

  it('names a day only when the engine would actually sell it that day', async () => {
    await daysAway();
    const days = await deskDays();

    // SLOT-07's whole reason for existing: a day list built from a cheaper
    // predicate offers a day the booking page then refuses (checkpoint 6).
    // Asserted BOTH ways over the fortnight, so an omission is caught as well
    // as an over-offer.
    for (let i = 0; i < DESK_DAY_SEARCH_DAYS; i++) {
      const day = addDays(calendarDay(DAY), i);
      const sellable =
        (await computeDaySlots(prisma, { businessId, providerId: dana(), serviceIds: [cut()], day, now: NOW, audience: 'staff' })).slots
          .length > 0;
      expect([day, days.includes(day)]).toEqual([day, sellable]);
    }
  });

  it('the STAFF arm is not the public one — D-21 is why this was worth wiring', async () => {
    // Three days of horizon: the customer's list stops dead, the desk's does
    // not. Before A-106 every call site passed 'public', so the difference
    // this asserts was unreachable from any staff surface.
    await prisma.business.update({ where: { id: businessId }, data: { bookingHorizonDays: 3 } });

    const forStaff = await deskDays();
    const forPublic = await deskDays({ audience: 'public' });

    expect(forPublic.length).toBeGreaterThan(0);
    expect(forStaff.length).toBeGreaterThan(forPublic.length);
    expect(forStaff).toEqual(expect.arrayContaining(forPublic));
  });
});

describe('A-106 — the move panel asks about ITS appointment, not about the catalogue', () => {
  /** Nadia is with Dana on the Tuesday, and Dana is then away for nine days. */
  const bookNadia = async () => {
    const nadia = await prisma.client.create({ data: { businessId, name: 'Nadia Okafor' } });
    const booked = await bookAppointment(prisma, {
      businessId,
      providerId: dana(),
      serviceIds: [cut()],
      clientId: nadia.id,
      startAt: at('2026-06-09T10:00:00-05:00'),
      now: NOW,
      actor: ACTOR,
      audience: 'staff',
    });
    return booked.id;
  };

  it('agrees with the times the panel then shows, day for day', async () => {
    const appointmentId = await bookNadia();
    await daysAway();

    const days = await daysForMove(prisma, { appointmentId, fromDay: DAY, now: NOW, audience: 'staff' });
    expect(days[0]).toBe(BACK);

    // The agreement assertion (checkpoint 6's lesson): `daysForMove` and
    // `rescheduleOptions` carry DIFFERENT inputs — the snapshotted duration,
    // the appointment's own exclusion, its holder — so this is not one
    // function checked against itself.
    for (let i = 0; i < DESK_DAY_SEARCH_DAYS; i++) {
      const day = addDays(calendarDay(DAY), i);
      const offered = (await rescheduleOptions(prisma, { appointmentId, day, now: NOW, audience: 'staff' })).slots.length > 0;
      expect([day, days.includes(day)]).toEqual([day, offered]);
    }
  });

  it('does not let the appointment block its own move', async () => {
    const appointmentId = await bookNadia();
    // Her own Tuesday is in the list, and it is there BECAUSE she is excluded
    // from her own busy set — the day she is already on is the commonest thing
    // a desk moves within.
    const days = await daysForMove(prisma, { appointmentId, fromDay: DAY, now: NOW, audience: 'staff' });
    expect(days).toContain(DAY);
  });

  it('uses D-18s snapshotted duration, not what the catalogue says today', async () => {
    const appointmentId = await bookNadia();

    // The Cut is re-priced as an all-day service. Nobody's working day is ten
    // hours, so NOTHING in the catalogue fits any day in the fortnight — but
    // Nadia agreed to forty-five minutes, and D-18 says that is what moves.
    await prisma.service.update({ where: { id: cut() }, data: { durationMinutes: 600 } });

    // The list built from the live catalogue is empty, which is what this
    // panel would have shown had the override not been threaded through.
    expect(await deskDays()).toEqual([]);
    // Hers is not. A day list that dropped D-18 would tell the desk there is
    // nowhere to move her for a fortnight, on an appointment the move itself
    // would have accepted.
    const days = await daysForMove(prisma, { appointmentId, fromDay: DAY, now: NOW, audience: 'staff' });
    expect(days).toContain(DAY);
    expect(days.length).toBeGreaterThan(1);
  });
});

describe("A-106 — 'I don't mind who' asks the room about HER", () => {
  /**
   * `anyProviderTimes` has carried the holder since A-097; the day list beside
   * it had NO CLIENT FIELD AT ALL, so it asked the strict question about a
   * client the panel had already resolved — and the strict answer is the
   * SMALLER one, which is the direction that offers less than the write
   * accepts (A-082/A-083).
   *
   * A ROOM INTERESTING ENOUGH FOR THE TWO TO DIFFER, which is the only kind
   * that can fail: two chairs, one of them already Nadia's, and exactly one
   * candidate instant left in the whole day. On a book where anybody is free
   * the two lists are identical and this passes against a dropped parameter.
   */
  const SATURDAY = '2026-06-13';
  const SAT_NOW = at('2026-06-13T08:00:00-05:00');
  /** Her cut's after-buffer runs to 13:55, so a cut starting here shares her
   *  chair's ENVELOPE and never its BODY — A-063's shareable chair. */
  const CONTESTED = '2026-06-13T13:45:00-05:00';

  it('withholds the day without her, and offers it with her', async () => {
    // TWO chairs. A room that cannot bind cannot disagree with anything, and
    // a fixture with no room in it is what let A-069 through (CLAUDE.md).
    const spare = await prisma.resource.findMany({ where: { businessId, active: true }, orderBy: { name: 'asc' }, skip: 2 });
    await prisma.resource.updateMany({ where: { id: { in: spare.map((r) => r.id) } }, data: { active: false } });

    const nadia = await prisma.client.create({ data: { businessId, name: 'Nadia Okafor' } });
    const ben = await prisma.client.create({ data: { businessId, name: 'Ben Rios' } });
    // Chair 1 is Nadia's, from 13:00 to 13:55 with the buffer.
    await bookAppointment(prisma, {
      businessId, providerId: dana(), serviceIds: [cut()], clientId: nadia.id,
      startAt: at('2026-06-13T13:00:00-05:00'), now: SAT_NOW, actor: ACTOR, audience: 'staff',
    });
    // Chair 2 is Ben's for the rest of the afternoon.
    await bookAppointment(prisma, {
      businessId, providerId: providerByName['Priya']!, serviceIds: [serviceByName['Colour']!], clientId: ben.id,
      startAt: at(CONTESTED), now: SAT_NOW, actor: ACTOR, audience: 'staff',
    });

    // Everybody who could otherwise sell an uncontested time is out, and
    // Marcus is left with exactly one candidate: 13:45. 13:30's envelope runs
    // back into the morning block and 14:00's runs into the evening one, so
    // the day stands or falls on whose chair 13:45 needs.
    for (const name of ['Dana', 'Priya', 'Tess']) {
      await createTimeOff(
        prisma,
        { businessId, providerId: providerByName[name]!, startAt: at(`${SATURDAY}T00:00:00-05:00`), endAt: at(`${SATURDAY}T23:59:00-05:00`) },
        STAMP,
      );
    }
    const marcus = providerByName['Marcus']!;
    await createAdHocBlock(prisma, { businessId, providerId: marcus, startAt: at(`${SATURDAY}T00:00:00-05:00`), endAt: at(CONTESTED) }, STAMP);
    await createAdHocBlock(prisma, { businessId, providerId: marcus, startAt: at(`${SATURDAY}T14:40:00-05:00`), endAt: at(`${SATURDAY}T23:59:00-05:00`) }, STAMP);

    const common = {
      businessId,
      serviceIds: [cut()],
      fromDay: SATURDAY,
      toDay: SATURDAY,
      now: SAT_NOW,
      audience: 'staff' as const,
    };

    // The strict question — a stranger at the desk. Both chairs are spoken
    // for at the only instant left, so the salon genuinely cannot seat her.
    expect(await anyProviderDays(prisma, common)).toEqual([]);
    // The same question asked about NADIA, who is already in one of them.
    expect(await anyProviderDays(prisma, { ...common, holderKey: nadia.id })).toEqual([SATURDAY]);
  });
});
