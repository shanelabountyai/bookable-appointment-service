/**
 * A-152 (C11) — series that are about to run out, and extending them by the
 * same rule. Fixture copied from A-049's `series.test.ts`: every hour open,
 * so a skip can only be the reason the test arranged.
 *
 * The A-049 header it was copied from:
 *
 * The assertions that matter are the ones a cancel-then-rebook or a virtual
 * occurrence would also pass. So these pin the things only real materialised
 * rows give you: the exclusion constraint defends each occurrence, a collision
 * skips exactly one week and names it, and the wall time survives a clock
 * change because the days were generated on the calendar axis.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { staffActor } from '../../core/auth';
import { instantFromIso, toDate, toLabel, zoneId } from '../../core/time';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from './book';
import { endSeriesHere } from './end-series';
import { mergeClients } from '../clients';
import { reassignAppointment } from '../availability/reassign';
import { SeriesExtendRefused, createSeries, extendSeries, listSeriesEnding, listSeriesOccurrences } from './series';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');
const CHICAGO = zoneId('America/Chicago');
const at = (iso: string) => toDate(instantFromIso(iso));
/** Long before every fixture, so nothing is refused for being in the past. */
const NOW = at('2026-02-01T08:00:00-06:00');

let businessId: string;
let providerId: string;
let otherProviderId: string;
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
    data: {
      name: 'Shear Genius',
      timezone: 'America/Chicago',
      slotIntervalMinutes: 15,
      minimumLeadMinutes: 0,
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;

  const service = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 },
  });
  serviceId = service.id;
  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;

  // Open EVERY weekday, all hours — these tests are about the series rule, and
  // a roster that happened to be closed on one occurrence would make a skip
  // ambiguous about which mechanism produced it.
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createWeeklyWindow(
      prisma,
      { businessId, providerId: null, weekday, open: '00:00', close: '23:59', endsNextDay: false },
      STAMP,
    );
  }
  for (const displayName of ['Dana', 'Priya']) {
    const provider = await prisma.provider.create({ data: { businessId, displayName } });
    if (displayName === 'Dana') providerId = provider.id;
    else otherProviderId = provider.id;
    await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId: provider.id } });
    for (let weekday = 0; weekday <= 6; weekday++) {
      await createWeeklyWindow(
        prisma,
        { businessId, providerId: provider.id, weekday, open: '00:00', close: '23:59', endsNextDay: false },
        STAMP,
      );
    }
  }
});

const series = (over: Partial<Parameters<typeof createSeries>[1]> = {}) =>
  createSeries(prisma, {
    businessId,
    providerId,
    clientId,
    serviceIds: [serviceId],
    anchorDay: '2026-06-09', // Tuesday
    time: '14:00',
    intervalWeeks: 4,
    count: 3,
    now: NOW,
    actor: ACTOR,
    ...over,
  });

// The fixture series: Tuesdays 9 June, 7 July, 4 August 2026 at 14:00.
/** Between the second and the third: one occurrence is still ahead. */
const MID_JULY = at('2026-07-20T09:00:00-05:00');
const ending = (weeks: number, now = MID_JULY) => listSeriesEnding(prisma, { businessId, now, weeks });

describe('listSeriesEnding — which series are about to run out', () => {
  it('lists a series whose last booking is inside the window, and not one whose last booking is past it', async () => {
    const { seriesId } = await series();

    // 4 August is 15 days after MID_JULY: inside six weeks, outside one.
    const inside = await ending(6);
    expect(inside.map((row) => row.seriesId)).toEqual([seriesId]);
    expect(inside[0]).toMatchObject({
      clientId,
      name: 'Ada Chen',
      providerName: 'Dana',
      intervalWeeks: 4,
      wallTime: '14:00',
      requested: 3,
      serviceNames: ['Cut'],
    });
    expect(inside[0]!.lastAt).toEqual(at('2026-08-04T14:00:00-05:00'));

    expect(await ending(1)).toEqual([]);
  });

  it('drops a series that has already run out — nothing ahead is the lapsed report, not this one', async () => {
    await series();
    expect(await ending(6, at('2026-08-05T09:00:00-05:00'))).toEqual([]);
  });

  it('does not count a cancelled last week as ahead — she is not coming that week', async () => {
    const { seriesId } = await series();
    const occurrences = await listSeriesOccurrences(prisma, seriesId);
    await prisma.appointment.update({ where: { id: occurrences[2]!.id }, data: { status: 'cancelled' } });

    // Only 9 June and 7 July are kept, both behind MID_JULY: run out.
    expect(await ending(6)).toEqual([]);
    // And a cancelled week PAST the window does not hide one that ends inside
    // it: from 1 July, 7 July is the last kept and 4 August no longer holds.
    expect((await ending(1, at('2026-07-01T09:00:00-05:00'))).map((row) => row.seriesId)).toEqual([seriesId]);
  });

  it('skips a series ended on purpose (D-39) and marks it ended', async () => {
    const { seriesId } = await series();
    const occurrences = await listSeriesOccurrences(prisma, seriesId);

    await endSeriesHere(prisma, { businessId, appointmentId: occurrences[2]!.id, reason: 'Moving to 2:30', actor: ACTOR, now: MID_JULY });

    expect((await prisma.appointmentSeries.findUniqueOrThrow({ where: { id: seriesId } })).endedAt).toEqual(MID_JULY);
    // Still has 7 July behind and nothing ahead — but it was ENDED, and from
    // 1 July it would otherwise list (7 July inside a one-week window).
    expect(await ending(1, at('2026-07-01T09:00:00-05:00'))).toEqual([]);
  });

  it('follows a merge to the survivor, and never lists a tombstone', async () => {
    const { seriesId } = await series();
    const survivorId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen-Ross', phone: '5125550199' } }))
      .id;

    await mergeClients(prisma, { businessId, survivorId, losingId: clientId, actor: ACTOR });

    const rows = await ending(6);
    expect(rows.map((row) => [row.seriesId, row.clientId, row.name])).toEqual([[seriesId, survivorId, 'Ada Chen-Ross']]);

    // A series left on the tombstone (written before the merge re-pointed
    // series) is not a person to ring.
    await prisma.appointmentSeries.update({ where: { id: seriesId }, data: { clientId } });
    expect(await ending(6)).toEqual([]);
  });

  it('puts the series that runs out soonest first', async () => {
    const later = await series({ anchorDay: '2026-06-16' }); // last: 11 August
    const sooner = await series({ providerId: otherProviderId }); // last: 4 August

    expect((await ending(6)).map((row) => row.seriesId)).toEqual([sooner.seriesId, later.seriesId]);
  });
});

describe('extendSeries — the same rule, the next weeks', () => {
  it('books the next ordinals on the same calendar rule, on the same series row', async () => {
    const { seriesId } = await series();

    const result = await extendSeries(prisma, { businessId, seriesId, count: 2, expectedRequested: 3, now: MID_JULY, actor: ACTOR });

    expect(result.booked).toBe(2);
    expect(result.occurrences.map((o) => [o.ordinal, o.day])).toEqual([
      [3, '2026-09-01'],
      [4, '2026-09-29'],
    ]);
    const occurrences = await listSeriesOccurrences(prisma, seriesId);
    expect(occurrences.map((o) => o.seriesOrdinal)).toEqual([0, 1, 2, 3, 4]);
    // Wall time held: 14:00 in Chicago on both, read back through the zone.
    expect(occurrences.slice(3).map((o) => toLabel(instantFromIso(o.startAt.toISOString()), CHICAGO).time)).toEqual([
      '14:00',
      '14:00',
    ]);
    expect((await prisma.appointmentSeries.findUniqueOrThrow({ where: { id: seriesId } })).requested).toBe(5);

    // And it leaves the list: nothing ahead of it now ends inside six weeks.
    expect(await ending(6)).toEqual([]);
  });

  it('repeats the stylist she sees NOW — a reassign moves occurrences, never the rule (A-153)', async () => {
    const { seriesId } = await series();
    const occurrences = await listSeriesOccurrences(prisma, seriesId);
    // Dana left; the desk moved Ada's last booked week to Priya.
    await reassignAppointment(prisma, {
      businessId,
      appointmentId: occurrences[2]!.id,
      toProviderId: otherProviderId,
      actor: ACTOR,
      notify: false,
    });

    // The row offering "Extend" names the person the extend will book.
    expect((await ending(6)).map((row) => row.providerName)).toEqual(['Priya']);

    const result = await extendSeries(prisma, { businessId, seriesId, count: 2, expectedRequested: 3, now: MID_JULY, actor: ACTOR });

    expect(result.booked).toBe(2);
    const added = await prisma.appointment.findMany({
      where: { seriesId, seriesOrdinal: { gte: 3 } },
      select: { providerId: true },
    });
    expect(added.map((row) => row.providerId)).toEqual([otherProviderId, otherProviderId]);
  });

  it('books partially and names the week it could not', async () => {
    const { seriesId } = await series();
    await bookAppointment(prisma, {
      businessId,
      providerId,
      serviceIds: [serviceId],
      clientId: null,
      startAt: at('2026-09-01T14:00:00-05:00'),
      now: NOW,
      actor: ACTOR,
      audience: 'staff',
    });

    const result = await extendSeries(prisma, { businessId, seriesId, count: 2, expectedRequested: 3, now: MID_JULY, actor: ACTOR });

    expect(result.booked).toBe(1);
    expect(result.occurrences.map((o) => [o.ordinal, o.skipped ?? 'booked'])).toEqual([
      [3, { kind: 'taken' }],
      [4, 'booked'],
    ]);
  });

  it('refuses a second extend from the same screen — a double tap books nothing twice', async () => {
    const { seriesId } = await series();
    const args = { businessId, seriesId, count: 2, expectedRequested: 3, now: MID_JULY, actor: ACTOR };

    await extendSeries(prisma, args);
    await expect(extendSeries(prisma, args)).rejects.toBeInstanceOf(SeriesExtendRefused);

    expect(await listSeriesOccurrences(prisma, seriesId)).toHaveLength(5);
  });

  it('refuses to extend an ended series', async () => {
    const { seriesId } = await series();
    const occurrences = await listSeriesOccurrences(prisma, seriesId);
    await endSeriesHere(prisma, { businessId, appointmentId: occurrences[2]!.id, reason: 'Moving away', actor: ACTOR, now: MID_JULY });

    await expect(
      extendSeries(prisma, { businessId, seriesId, count: 2, expectedRequested: 3, now: MID_JULY, actor: ACTOR }),
    ).rejects.toBeInstanceOf(SeriesExtendRefused);
  });
});
