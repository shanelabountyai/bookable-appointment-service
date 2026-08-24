/**
 * A-049 — standing appointments against the real database.
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
import { InvalidSeries } from '../../core/scheduling';
import { instantFromIso, toDate, toLabel, zoneId } from '../../core/time';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from './book';
import { createSeries, listSeriesOccurrences } from './series';

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

describe('createSeries — the ordinary case', () => {
  it('books every occurrence as a real appointment, in order, linked to the rule', async () => {
    const result = await series();
    expect(result.booked).toBe(3);

    const occurrences = await listSeriesOccurrences(prisma, result.seriesId);
    expect(occurrences).toHaveLength(3);
    expect(occurrences.map((o) => o.seriesOrdinal)).toEqual([0, 1, 2]);
    // Real rows, not a computed view — which is what lets the exclusion
    // constraint defend them at all.
    expect(occurrences.every((o) => o.status === 'booked')).toBe(true);

    const days = occurrences.map((o) => toLabel(instantFromIso(o.startAt.toISOString()), CHICAGO).day);
    expect(days).toEqual(['2026-06-09', '2026-07-07', '2026-08-04']);
  });

  it('stores the RULE on the calendar axis, not an instant and a duration', async () => {
    const result = await series();
    const rule = await prisma.appointmentSeries.findUniqueOrThrow({ where: { id: result.seriesId } });
    // CHAR(10)/CHAR(5) — the ban on `@db.Date` is the reason this survives.
    expect(rule.anchorDay.trim()).toBe('2026-06-09');
    expect(rule.wallTime.trim()).toBe('14:00');
    expect(rule.intervalWeeks).toBe(4);
    expect(rule.requested).toBe(3);
    expect(rule.actorRef).toBe('staff-1');
  });

  it('refuses a nonsense rule WITHOUT leaving a series row behind', async () => {
    await expect(series({ count: 0 })).rejects.toBeInstanceOf(InvalidSeries);
    expect(await prisma.appointmentSeries.count()).toBe(0);
    expect(await prisma.appointment.count()).toBe(0);
  });
});

describe('createSeries is PARTIAL, and names what it did not book (D-26 shape)', () => {
  it('skips the one week somebody else already has, and books the rest', async () => {
    // Take the middle occurrence's slot with an ordinary booking first.
    await bookAppointment(prisma, {
      businessId,
      providerId,
      serviceIds: [serviceId],
      clientId: null,
      startAt: at('2026-07-07T14:00:00-05:00'),
      now: NOW,
      actor: ACTOR,
      audience: 'staff',
    });

    const result = await series();
    expect(result.booked).toBe(2);

    const skipped = result.occurrences.filter((o) => o.skipped);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.day).toBe('2026-07-07');
    // The REASON, not merely that it failed — the desk rings that client.
    expect(skipped[0]!.skipped).toEqual({ kind: 'taken' });

    // Nothing silently lost: the other two are really in the book.
    expect(await listSeriesOccurrences(prisma, result.seriesId)).toHaveLength(2);
  });

  it('keeps the series row even when nothing at all could be booked', async () => {
    for (const iso of ['2026-06-09T14:00:00-05:00', '2026-07-07T14:00:00-05:00', '2026-08-04T14:00:00-05:00']) {
      await bookAppointment(prisma, {
        businessId,
        providerId,
        serviceIds: [serviceId],
        clientId: null,
        startAt: at(iso),
        now: NOW,
        actor: ACTOR,
        audience: 'staff',
      });
    }

    const result = await series();
    expect(result.booked).toBe(0);
    // "We tried to set up Ada's Tuesdays and every one was taken" is a fact
    // worth keeping; a silent nothing is not.
    expect(await prisma.appointmentSeries.findUnique({ where: { id: result.seriesId } })).not.toBeNull();
    expect(result.occurrences.every((o) => o.skipped?.kind === 'taken')).toBe(true);
  });
});

/**
 * THE WEEKS A STANDING APPOINTMENT EVENTUALLY MEETS.
 *
 * `series.test.ts` in packages/core proves the arithmetic; these prove the
 * write path does the right thing with each answer.
 */
describe('the clock changes underneath a series', () => {
  it('keeps the WALL time across spring-forward — the client is not moved an hour', async () => {
    const result = await series({ anchorDay: '2026-03-03', time: '14:00', intervalWeeks: 1, count: 2 });
    expect(result.booked).toBe(2);

    const occurrences = await listSeriesOccurrences(prisma, result.seriesId);
    const times = occurrences.map((o) => toLabel(instantFromIso(o.startAt.toISOString()), CHICAGO).time);
    expect(times).toEqual(['14:00', '14:00']);
    // 167 hours, not 168 — the week containing the transition is an hour
    // shorter, and an instant-plus-a-week rule would say 15:00.
    expect(occurrences[1]!.startAt.getTime() - occurrences[0]!.startAt.getTime()).toBe(
      (7 * 24 - 1) * 60 * 60 * 1000,
    );
  });

  it('refuses to invent a time on the week it does not exist, and says so', async () => {
    // 02:30 does not exist on 2026-03-08.
    const result = await series({ anchorDay: '2026-03-01', time: '02:30', intervalWeeks: 1, count: 2 });
    expect(result.booked).toBe(1);

    const skipped = result.occurrences.find((o) => o.skipped)!;
    expect(skipped.day).toBe('2026-03-08');
    expect(skipped.skipped).toEqual({ kind: 'no-such-time' });
    // NOT coerced to 01:30 or 03:30 (spec DST-8): nothing was written for it.
    expect(await listSeriesOccurrences(prisma, result.seriesId)).toHaveLength(1);
  });

  it('books the earlier hour on the week the time happens twice, and flags it', async () => {
    // 01:30 happens twice on 2026-11-01.
    const result = await series({ anchorDay: '2026-10-25', time: '01:30', intervalWeeks: 1, count: 2 });
    expect(result.booked).toBe(2);

    const doubled = result.occurrences.find((o) => o.doubledHour);
    expect(doubled?.day).toBe('2026-11-01');

    const occurrences = await listSeriesOccurrences(prisma, result.seriesId);
    const booked = occurrences[1]!.startAt;
    // The EARLIER of the two 01:30s — CDT, not CST.
    expect(booked).toEqual(at('2026-11-01T01:30:00-05:00'));
    expect(booked).not.toEqual(at('2026-11-01T01:30:00-06:00'));
  });
});

describe('D-34 — an occurrence detaches; the series does not follow it', () => {
  it('cancelling one leaves every other occurrence booked, and keeps its provenance', async () => {
    const result = await series();
    const occurrences = await listSeriesOccurrences(prisma, result.seriesId);
    const middle = occurrences[1]!;

    await prisma.appointment.update({ where: { id: middle.id }, data: { status: 'cancelled' } });

    const after = await listSeriesOccurrences(prisma, result.seriesId);
    expect(after.filter((o) => o.status === 'booked')).toHaveLength(2);
    // The link SURVIVES the cancellation: "this was the 2nd of Ada's series
    // and somebody cancelled it" is a question the desk asks.
    const cancelled = await prisma.appointment.findUniqueOrThrow({ where: { id: middle.id } });
    expect(cancelled.seriesId).toBe(result.seriesId);
    expect(cancelled.seriesOrdinal).toBe(1);
  });

  it('the freed week can be rebooked by somebody else — it is an ordinary slot again', async () => {
    const result = await series();
    const occurrences = await listSeriesOccurrences(prisma, result.seriesId);
    await prisma.appointment.update({ where: { id: occurrences[1]!.id }, data: { status: 'cancelled' } });

    await expect(
      bookAppointment(prisma, {
        businessId,
        providerId,
        serviceIds: [serviceId],
        clientId: null,
        startAt: at('2026-07-07T14:00:00-05:00'),
        now: NOW,
        actor: ACTOR,
        audience: 'staff',
      }),
    ).resolves.toBeDefined();
  });

  it('deleting the RULE never deletes a booked appointment', async () => {
    const result = await series();
    await prisma.appointmentSeries.delete({ where: { id: result.seriesId } });

    // SET NULL, not RESTRICT or CASCADE: the appointments survive as ordinary
    // ones. A rule that could take three booked clients with it is the silent
    // cancellation this product forbids.
    const orphans = await prisma.appointment.findMany({ where: { businessId } });
    expect(orphans).toHaveLength(3);
    expect(orphans.every((o) => o.seriesId === null)).toBe(true);
    expect(orphans.every((o) => o.status === 'booked')).toBe(true);
  });
});

describe('the constraint still defends every occurrence', () => {
  it('a second series over the same weeks collides on each one', async () => {
    const first = await series();
    expect(first.booked).toBe(3);

    // Same provider, same times, a different client.
    const second = await series();
    expect(second.booked).toBe(0);
    expect(second.occurrences.every((o) => o.skipped?.kind === 'taken')).toBe(true);
  });

  it('the same times with ANOTHER provider are free', async () => {
    await series();
    const second = await series({ providerId: otherProviderId });
    expect(second.booked).toBe(3);
  });
});
