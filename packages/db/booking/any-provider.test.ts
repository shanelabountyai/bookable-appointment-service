/**
 * A-056 — "anything Thursday? I don't mind who" (SVC-02), against a real
 * database.
 *
 * SVC-02 says the assignment is "deterministic, so an acceptance test can
 * assert it". This is that test, and it is the reason the rule is worth having
 * rather than "pick anyone free": load-balancing is the difference between the
 * senior booked solid and the junior at 40%.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { staffActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from './book';
import { anyProviderAt, anyProviderDays, anyProviderTimes } from './any-provider';

const prisma = new PrismaClient();
const STAFF_WINDOW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const STAFF = staffActor('staff-1');

const at = (iso: string) => toDate(instantFromIso(iso));

// Tuesday 9 June 2026, Chicago.
const DAY = '2026-06-09';
const NOW = at('2026-06-08T08:00:00-05:00');

let businessId: string;
let dana: string;
let priya: string;
let marcus: string;
let cutId: string;
let colourId: string;

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
      slotIntervalMinutes: 30,
      minimumLeadMinutes: 0,
      cancellationCutoffMinutes: 120,
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;

  // displayOrder is SVC-02's tiebreak, so it is explicit and distinct.
  dana = (await prisma.provider.create({ data: { businessId, displayName: 'Dana', displayOrder: 0 } })).id;
  priya = (await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } })).id;
  marcus = (await prisma.provider.create({ data: { businessId, displayName: 'Marcus', displayOrder: 2 } })).id;

  cutId = (
    await prisma.service.create({ data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 } })
  ).id;
  colourId = (
    await prisma.service.create({ data: { businessId, name: 'Colour', durationMinutes: 60, priceCents: 12000 } })
  ).id;

  // Everyone cuts; only Dana colours — so a colour has exactly one answer and
  // the "all of it or none of it" rule has something to bite on.
  await prisma.serviceProvider.createMany({
    data: [
      { businessId, serviceId: cutId, providerId: dana },
      { businessId, serviceId: cutId, providerId: priya },
      { businessId, serviceId: cutId, providerId: marcus },
      { businessId, serviceId: colourId, providerId: dana },
    ],
  });

  await createWeeklyWindow(
    prisma,
    { businessId, providerId: null, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
    STAFF_WINDOW,
  );
  for (const id of [dana, priya, marcus]) {
    await createWeeklyWindow(
      prisma,
      { businessId, providerId: id, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
      STAFF_WINDOW,
    );
  }
});

const times = (serviceIds: string[] = [cutId]) =>
  anyProviderTimes(prisma, { businessId, serviceIds, day: DAY, now: NOW, audience: 'staff' });

const book = (providerId: string, startAt: Date, serviceIds: string[] = [cutId]) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds,
    clientId: null,
    startAt,
    now: NOW,
    actor: STAFF,
    audience: 'staff',
  });

describe('the merged list', () => {
  it('answers the whole day in ONE call, with a name on every time', async () => {
    const offered = await times();

    expect(offered.length).toBeGreaterThan(0);
    // One row per distinct TIME, never one per provider-time: three stylists
    // free at nine o'clock is one offer to the client, not three.
    expect(new Set(offered.map((o) => o.at.getTime())).size).toBe(offered.length);
    expect(offered.every((o) => o.providerName.length > 0)).toBe(true);
    // Chronological, on the instant (D-4) — never on a label.
    expect(offered.map((o) => o.at.getTime())).toEqual([...offered.map((o) => o.at.getTime())].sort((a, b) => a - b));
  });

  it('says how many stylists are free at each time', async () => {
    const before = await times();
    expect(before[0]!.freeCount).toBe(3);

    await book(dana, at('2026-06-09T09:00:00-05:00'));
    const after = await times();
    const nine = after.find((o) => o.at.getTime() === at('2026-06-09T09:00:00-05:00').getTime());
    expect(nine!.freeCount).toBe(2);
  });

  it('drops a time only when the LAST qualified stylist is taken', async () => {
    const nine = at('2026-06-09T09:00:00-05:00');
    await book(dana, nine);
    await book(priya, nine);
    expect((await times()).some((o) => o.at.getTime() === nine.getTime())).toBe(true);

    await book(marcus, nine);
    expect((await times()).some((o) => o.at.getTime() === nine.getTime())).toBe(false);
  });

  /** VISIT-01, all-or-nothing: only Dana colours, so a cut+colour has exactly
   *  one possible answer even though three people cut. */
  it('offers only stylists qualified for the WHOLE visit', async () => {
    const offered = await anyProviderTimes(prisma, {
      businessId,
      serviceIds: [cutId, colourId],
      day: DAY,
      now: NOW,
      audience: 'staff',
    });
    expect(offered.length).toBeGreaterThan(0);
    expect(new Set(offered.map((o) => o.providerId))).toEqual(new Set([dana]));
    expect(offered.every((o) => o.freeCount === 1)).toBe(true);
  });

  it('returns nothing when nobody is qualified', async () => {
    const soloId = (
      await prisma.service.create({ data: { businessId, name: 'Perm', durationMinutes: 60, priceCents: 9000 } })
    ).id;
    expect(await times([soloId])).toEqual([]);
  });
});

describe("SVC-02's assignment", () => {
  /** The PRD's own words: "fewest booked minutes on that business date, ties
   *  broken by displayOrder". */
  it('gives the time to whoever has the lightest day', async () => {
    // Dana works two hours that day; Priya one; Marcus none.
    await book(dana, at('2026-06-09T09:00:00-05:00'));
    await book(dana, at('2026-06-09T10:00:00-05:00'));
    await book(priya, at('2026-06-09T09:00:00-05:00'));

    const three = (await times()).find((o) => o.at.getTime() === at('2026-06-09T15:00:00-05:00').getTime());
    expect(three!.providerName).toBe('Marcus');
  });

  it('breaks a tie on displayOrder, not on who was found first', async () => {
    // Nobody has anything booked: a three-way tie at zero minutes.
    const offered = await times();
    // Dana is displayOrder 0.
    expect(offered[0]!.providerName).toBe('Dana');
    expect(offered.every((o) => o.providerName === 'Dana')).toBe(true);
  });

  it('is deterministic — the same book gives the same answer every time', async () => {
    await book(dana, at('2026-06-09T09:00:00-05:00'));
    const first = await times();
    const second = await times();
    expect(second.map((o) => o.providerId)).toEqual(first.map((o) => o.providerId));
  });

  /** D-7: a no-show still OCCUPIED the stylist's time. Balancing the next
   *  booking onto her because a client failed to turn up would be balancing on
   *  fiction. */
  it('counts a no-show against the stylist who stood there', async () => {
    const appointment = await book(priya, at('2026-06-09T09:00:00-05:00'));
    await prisma.appointment.update({ where: { id: appointment.id }, data: { status: 'no_show' } });

    // Dana and Marcus are on zero; Priya is on 60. Dana wins on displayOrder.
    const three = (await times()).find((o) => o.at.getTime() === at('2026-06-09T15:00:00-05:00').getTime());
    expect(three!.providerName).toBe('Dana');

    // ...and Priya is genuinely behind, not merely not-first: with Dana loaded
    // too, Marcus takes it rather than Priya.
    await book(dana, at('2026-06-09T10:00:00-05:00'));
    await book(dana, at('2026-06-09T11:00:00-05:00'));
    const later = (await times()).find((o) => o.at.getTime() === at('2026-06-09T15:00:00-05:00').getTime());
    expect(later!.providerName).toBe('Marcus');
  });

  /** A cancellation frees the time AND the load — SLOT_FREEING_STATUSES is
   *  the same list the busy set uses (D-7). */
  it('stops counting a cancelled appointment against her', async () => {
    const appointment = await book(priya, at('2026-06-09T09:00:00-05:00'));
    await book(dana, at('2026-06-09T09:00:00-05:00'));
    await book(dana, at('2026-06-09T10:00:00-05:00'));

    await prisma.appointment.update({ where: { id: appointment.id }, data: { status: 'cancelled' } });

    // Priya is back to zero and ties Marcus; her displayOrder is lower.
    const three = (await times()).find((o) => o.at.getTime() === at('2026-06-09T15:00:00-05:00').getTime());
    expect(three!.providerName).toBe('Priya');
  });
});

describe('the days list', () => {
  it('offers a day when ANY qualified stylist can take it', async () => {
    const days = await anyProviderDays(prisma, {
      businessId,
      serviceIds: [cutId],
      fromDay: DAY,
      toDay: '2026-06-16',
      now: NOW,
      audience: 'staff',
    });
    // Tuesdays only — the seeded window is weekday 2.
    expect(days).toEqual([DAY, '2026-06-16']);
  });

  /** The day must disappear only when the last stylist's day is full, which is
   *  the whole difference from asking one provider. */
  it('keeps a day that is full for one stylist and open for another', async () => {
    // Fill Dana's Tuesday entirely.
    for (let hour = 9; hour < 17; hour++) {
      await book(dana, at(`2026-06-09T${String(hour).padStart(2, '0')}:00:00-05:00`));
    }
    const days = await anyProviderDays(prisma, {
      businessId,
      serviceIds: [cutId],
      fromDay: DAY,
      toDay: DAY,
      now: NOW,
      audience: 'staff',
    });
    expect(days).toEqual([DAY]);
  });

  it('returns nothing when nobody is qualified', async () => {
    const soloId = (
      await prisma.service.create({ data: { businessId, name: 'Perm', durationMinutes: 60, priceCents: 9000 } })
    ).id;
    expect(
      await anyProviderDays(prisma, {
        businessId,
        serviceIds: [soloId],
        fromDay: DAY,
        toDay: '2026-06-16',
        now: NOW,
        audience: 'staff',
      }),
    ).toEqual([]);
  });
});

/**
 * A-071 — WHO ELSE CAN DO IT AT THIS EXACT INSTANT.
 *
 * The half of A-056's promise it did not keep. The row said 14:00, Dana, 3
 * free; the desk took a phone call, came back, submitted, and the public flow
 * had taken Dana. The panel then said "that time is not free" and offered an
 * OVERRIDE that would knowingly double-book her — while Priya and Marcus were
 * both free at two o'clock. Either the desk takes the override (wrong) or it
 * starts the search again with the client on the phone, and the premise of the
 * row it tapped is thrown away at the last step.
 */
describe('who else can do it at this instant (A-071)', () => {
  const TWO = at('2026-06-09T14:00:00-05:00');

  const whoElse = (serviceIds: string[] = [cutId]) =>
    anyProviderAt(prisma, { businessId, serviceIds, at: TWO, now: NOW, audience: 'staff' });

  it('names the stylist SVC-02 would assign, and how many are free', async () => {
    const instead = await whoElse();

    // Nobody has anything booked, so the tiebreak is `displayOrder`.
    expect(instead).toMatchObject({ providerName: 'Dana', freeCount: 3 });
  });

  /** THE ROW'S OWN CASE. Dana goes; the answer is another NAME at the same
   *  time, not a refusal and certainly not an override. */
  it('names somebody ELSE the moment the first one is taken', async () => {
    await book(dana, TWO);

    const instead = await whoElse();

    expect(instead).toMatchObject({ providerName: 'Priya', freeCount: 2 });
    expect(instead!.providerId).not.toBe(dana);
    // The INSTANT is unchanged — that is the whole point. "Anyone at two"
    // means two o'clock is the thing she asked for.
    expect(instead!.at).toEqual(TWO);
  });

  /** …and when there genuinely is nobody, the ordinary refusal-plus-override
   *  IS the right answer, so this has to be able to say so. */
  it('is null when every qualified stylist is busy at that instant', async () => {
    for (const providerId of [dana, priya, marcus]) await book(providerId, TWO);

    expect(await whoElse()).toBeNull();
  });

  it('is null when the instant is not on offer at all — nobody was ever promised it', async () => {
    // 03:00, comfortably outside 09:00–17:00.
    expect(
      await anyProviderAt(prisma, {
        businessId,
        serviceIds: [cutId],
        at: at('2026-06-09T03:00:00-05:00'),
        now: NOW,
        audience: 'staff',
      }),
    ).toBeNull();
  });

  /** SVC-02's "all of it or none of it" survives: only Dana colours, so when
   *  Dana goes there is no second answer and the desk gets the honest one. */
  it('does not invent a substitute who cannot do the service', async () => {
    await book(dana, TWO, [colourId]);

    expect(await whoElse([colourId])).toBeNull();
  });
});
