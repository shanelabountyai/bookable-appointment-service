/**
 * A-032 — the engine stops offering a time the room cannot seat (RES-03).
 *
 * A-031 made the database refuse the fifth client in a four-chair room. That
 * refusal arrived at SUBMIT, on a time the screen had just offered: the
 * offered-then-refused defect this repo has already caught twice (the gap-vs-
 * grid seam at demo checkpoint 2, the day-view clipping bug). This is the
 * other half — the room's occupancy reaches the engine as ordinary busy
 * intervals, so the time is never offered in the first place.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { staffActor } from '../../core/auth';
import { instant, instantFromIso, toDate } from '../../core/time';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from '../booking';
import { computeDaySlots } from './slot-query';
import { fullSpans } from './resource-load';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');
const at = (iso: string) => toDate(instantFromIso(iso));

/** Tuesday 2026-06-09, America/Chicago (CDT, -05:00 all day). */
const DAY = '2026-06-09';
const NOW = at('2026-06-09T08:00:00-05:00');

/** Epoch millis, branded. The spans are instants; this suite never needs a
 *  wall clock, which is why the numbers below are bare offsets. */
const t = (ms: number) => instant(ms);

/** A hold, on a named chair. Every existing case below puts each hold on its
 *  OWN chair, which is what "count the holds" used to mean — so they read the
 *  same and still say which chair, which is the distinction A-063 introduced
 *  and checkpoint 5 found this function had never learned. */
const h = (start: number, end: number, resourceId: string) => ({
  start: t(start),
  end: t(end),
  resourceId,
});

describe('fullSpans — the cardinality question, collapsed into intervals', () => {
  it('is empty while a chair remains', () => {
    expect(fullSpans([h(0, 100, 'c1')], 2)).toEqual([]);
  });

  it('opens when the last chair goes and closes when one comes back', () => {
    expect(fullSpans([h(0, 100, 'c1'), h(40, 60, 'c2')], 2)).toEqual([{ start: t(40), end: t(60) }]);
  });

  it('does NOT stack a hold ending at t with one starting at t — half-open, or the salon loses a seating', () => {
    // With '[]' semantics these two would read as two concurrent holds at
    // t=50 and the room would look full for an instant every hour.
    expect(fullSpans([h(0, 50, 'c1'), h(50, 100, 'c2')], 1)).toEqual([
      { start: t(0), end: t(50) },
      { start: t(50), end: t(100) },
    ]);
  });

  it('merges a run of overlapping holds into one full span rather than one per hold', () => {
    expect(fullSpans([h(0, 60, 'c1'), h(30, 90, 'c2')], 1)).toEqual([{ start: t(0), end: t(90) }]);
  });

  it('reports nothing for a capacity of zero — that case is the caller’s, and means ALWAYS full', () => {
    expect(fullSpans([], 0)).toEqual([]);
  });

  /**
   * CHECKPOINT 5, FINDING 3 — the sharpest of the three, and the one that
   * reached a client.
   *
   * A-063 made one woman's cut and colour share ONE chair through the buffers
   * between them. From that moment "how many holds overlap" and "how many
   * chairs are taken" stopped being the same number, and this function was
   * still counting holds. So the room declared itself full with a chair
   * standing empty and the booking flow stopped OFFERING the time — which is
   * word for word the harm A-063's row set out to remove, surviving on the one
   * surface that decides whether a client is ever shown the slot.
   *
   * A-063's own tests could not see it: they asked `findFreeResource` (the
   * chooser) and the constraint. Nothing asked the thing that decides what is
   * on the screen.
   */
  it('counts CHAIRS, not holds — one client on one chair does not fill a two-chair room', () => {
    // Her cut and her colour, overlapping buffers, the same chair.
    expect(fullSpans([h(0, 60, 'c1'), h(50, 120, 'c1')], 2)).toEqual([]);
  });

  it('a shared chair still fills a ONE-chair room, because it is genuinely taken', () => {
    expect(fullSpans([h(0, 60, 'c1'), h(50, 120, 'c1')], 1)).toEqual([{ start: t(0), end: t(120) }]);
  });

  it('two clients on two chairs fill a two-chair room exactly as before', () => {
    expect(fullSpans([h(0, 60, 'c1'), h(50, 120, 'c2')], 2)).toEqual([{ start: t(50), end: t(60) }]);
  });
});

describe('the room in the busy set (RES-03)', () => {
  let businessId: string;
  let chairTypeId: string;
  let serviceId: string;
  let providerIds: string[] = [];

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
        bookingHorizonDays: 90,
      },
    });
    businessId = business.id;

    const chairType = await prisma.resourceType.create({ data: { businessId, name: 'Chair' } });
    chairTypeId = chairType.id;
    // TWO chairs and THREE stylists, so the room binds without needing the
    // full sample salon — the same shape A-031's suite uses.
    for (const name of ['Chair 1', 'Chair 2']) {
      await prisma.resource.create({ data: { businessId, resourceTypeId: chairTypeId, name } });
    }

    const service = await prisma.service.create({
      data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500, requiredResourceTypeId: chairTypeId },
    });
    serviceId = service.id;

    providerIds = [];
    await createWeeklyWindow(
      prisma,
      { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
      STAMP,
    );
    for (const displayName of ['Dana', 'Priya', 'Marcus']) {
      const provider = await prisma.provider.create({ data: { businessId, displayName } });
      providerIds.push(provider.id);
      await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId: provider.id } });
      await createWeeklyWindow(
        prisma,
        { businessId, providerId: provider.id, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
        STAMP,
      );
    }
  });

  const book = (over: Record<string, unknown> = {}) =>
    bookAppointment(prisma, {
      businessId,
      providerId: providerIds[0]!,
      serviceIds: [serviceId],
      clientId: null,
      startAt: at('2026-06-09T10:00:00-05:00'),
      now: NOW,
      actor: ACTOR,
      audience: 'staff',
      ...over,
    } as Parameters<typeof bookAppointment>[1]);

  const slotsFor = async (providerId: string, over: Record<string, unknown> = {}) =>
    computeDaySlots(prisma, {
      businessId,
      providerId,
      serviceIds: [serviceId],
      day: DAY,
      now: NOW,
      audience: 'public',
      ...over,
    });

  const fillTheRoom = async () => {
    await book();
    await book({ providerId: providerIds[1]! });
  };

  it('stops offering the hour to an idle stylist once both chairs are held', async () => {
    await fillTheRoom();
    const { slots } = await slotsFor(providerIds[2]!);
    const labels = slots.map((s) => s.label.time);
    expect(labels).not.toContain('10:00');
    // ...and the times either side are untouched: this removes an hour, not a day.
    expect(labels).toContain('12:00');
  });

  it('names the RIGHT reason for staff — she is free, the room is not', async () => {
    await fillTheRoom();
    const { excluded } = await slotsFor(providerIds[2]!, { audience: 'staff' });
    const reasonsAt = (time: string) => excluded.find((e) => e.label.time === time)?.reasons ?? [];
    // Not `overlaps-booking`: Marcus has no client at all, and telling the desk
    // he does is the wrong-explanation failure every other kind has its own
    // reason to avoid.
    expect(reasonsAt('10:00')).toEqual(['no-resource-free']);
  });

  it('offers the hour again the moment a chair frees', async () => {
    await fillTheRoom();
    const [first] = await prisma.appointment.findMany({ orderBy: { createdAt: 'asc' }, take: 1 });
    await prisma.appointment.update({ where: { id: first!.id }, data: { status: 'cancelled' } });

    const { slots } = await slotsFor(providerIds[2]!);
    expect(slots.map((s) => s.label.time)).toContain('10:00');
  });

  it('does not count the appointment being MOVED against its own destination', async () => {
    await fillTheRoom();
    const moving = await prisma.appointment.findFirstOrThrow({
      where: { providerId: providerIds[1]! },
    });

    // Without the exclusion, a full room makes every reschedule inside the
    // hour impossible — the appointment's own chair blocks its own move.
    const { slots } = await slotsFor(providerIds[1]!, {
      audience: 'staff',
      excludeAppointmentId: moving.id,
    });
    expect(slots.map((s) => s.label.time)).toContain('10:15');
  });

  it('leaves a service that needs no chair alone', async () => {
    await fillTheRoom();
    const consult = await prisma.service.create({
      data: { businessId, name: 'Phone consult', durationMinutes: 30, priceCents: 0 },
    });
    await prisma.serviceProvider.create({
      data: { businessId, serviceId: consult.id, providerId: providerIds[2]! },
    });

    const { slots } = await slotsFor(providerIds[2]!, { serviceIds: [consult.id] });
    expect(slots.map((s) => s.label.time)).toContain('10:00');
  });
});
