/**
 * A-017 — staff booking and override (BOOK-04, BOOK-05, D-8, D-17, D-25).
 *
 * The write path itself was built staff-shaped in A-009 and has its own suite;
 * what is new here is the three override PATHS reaching it, the walk-in
 * search, and the two rules that only make sense from a staff surface: no lead
 * time (D-25) and the soft same-client note (D-17).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromDate, instantFromIso, toDate, toLabel, zoneId } from '../../core/time';
import { staffActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createTimeOff, createWeeklyWindow } from '../availability';
import { computeDaySlots } from '../scheduling';
import { bookAppointment } from './book';
import { SlotNotOffered, SlotTaken } from './errors';
import { clientAlreadyBookedAround, walkInOptions } from './walk-in';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');

const at = (iso: string) => toDate(instantFromIso(iso));
const hhmm = (d: Date) => toLabel(fromDate(d), zoneId('America/Chicago')).time;

const DAY = '2026-06-09'; // Tuesday
const TEN_AM = at('2026-06-09T10:00:00-05:00');

let businessId: string;
let danaId: string;
let priyaId: string;
let cutId: string;
let colourId: string;
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
      // The seeded policy: two hours' notice for CUSTOMERS (D-11). Every
      // staff booking below happens well inside it, which is the point.
      minimumLeadMinutes: 120,
      cancellationCutoffMinutes: 120,
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana', displayOrder: 0 } });
  const priya = await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } });
  danaId = dana.id;
  priyaId = priya.id;

  const cut = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500, bufferAfterMinutes: 15 },
  });
  const colour = await prisma.service.create({
    data: { businessId, name: 'Colour', durationMinutes: 90, priceCents: 12000, bufferAfterMinutes: 10 },
  });
  cutId = cut.id;
  colourId = colour.id;
  await prisma.serviceProvider.createMany({
    data: [
      { businessId, serviceId: cut.id, providerId: dana.id },
      { businessId, serviceId: colour.id, providerId: dana.id },
      // Priya does cuts only — so a cut+colour walk-in must not be offered her.
      { businessId, serviceId: cut.id, providerId: priya.id },
    ],
  });

  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);
  for (const p of [dana.id, priya.id]) {
    await createWeeklyWindow(prisma, { businessId, providerId: p, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false }, STAMP);
  }
});

const book = (over: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId: danaId,
    serviceIds: [cutId],
    clientId,
    startAt: TEN_AM,
    now: at('2026-06-09T09:00:00-05:00'),
    actor: ACTOR,
    audience: 'staff',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

describe('D-25 — the lead time is a self-serve rule', () => {
  /** With a 120-minute lead time and the clock at 09:55, a 10:00 booking is
   *  five minutes out. The front desk must be able to make it. */
  it('lets staff book inside the customer lead time', async () => {
    const appointment = await book({ now: at('2026-06-09T09:55:00-05:00') });
    expect(appointment.startAt.toISOString()).toBe(TEN_AM.toISOString());
    // And NOT as an override: routing every walk-in through BOOK-05 would
    // make the override marker meaningless.
    expect(appointment.isOverride).toBe(false);
  });

  it('still refuses a CUSTOMER inside the lead time', async () => {
    await expect(
      book({ now: at('2026-06-09T09:55:00-05:00'), audience: 'public' }),
    ).rejects.toBeInstanceOf(SlotNotOffered);
  });

  it('offers staff the imminent slots the public flow withholds', async () => {
    const now = at('2026-06-09T09:55:00-05:00');
    const forStaff = await computeDaySlots(prisma, { businessId, providerId: danaId, serviceIds: [cutId], day: DAY, now, audience: 'staff' });
    const forPublic = await computeDaySlots(prisma, { businessId, providerId: danaId, serviceIds: [cutId], day: DAY, now, audience: 'public' });

    expect(forStaff.slots.map((s) => hhmm(toDate(s.start)))).toContain('10:00');
    expect(forPublic.slots.map((s) => hhmm(toDate(s.start)))).not.toContain('10:00');
  });
});

describe('BOOK-05 — the three override paths', () => {
  /** (1) Outside hours: the salon closes at 17:00 and the wedding party is at
   *  18:00. Every platform the operator abandoned died of a flat refusal. */
  it('books outside working hours with a reason', async () => {
    const startAt = at('2026-06-09T18:00:00-05:00');
    await expect(book({ startAt })).rejects.toBeInstanceOf(SlotNotOffered);

    const appointment = await book({ startAt, isOverride: true, overrideReason: 'wedding party, agreed with Dana' });
    expect(appointment.isOverride).toBe(true);
  });

  /** (2) Into a buffer: the 10:00 cut blocks to 11:15, and 11:00 is inside
   *  that. A knowing squeeze is a decision, not an error. */
  it('books into another appointment’s buffer with a reason', async () => {
    await book({ idempotencyKey: 'first' });
    const startAt = at('2026-06-09T11:00:00-05:00');

    await expect(book({ startAt, idempotencyKey: 'squeeze' })).rejects.toBeInstanceOf(SlotTaken);
    const appointment = await book({
      startAt,
      isOverride: true,
      overrideReason: 'she only needs a trim',
      idempotencyKey: 'squeeze-override',
    });
    expect(appointment.isOverride).toBe(true);
  });

  /** (3) A knowing double-book, on top of an existing appointment. */
  it('double-books knowingly with a reason', async () => {
    await book({ idempotencyKey: 'first' });

    const appointment = await book({
      startAt: TEN_AM,
      isOverride: true,
      overrideReason: 'colour processing, she can take both',
      idempotencyKey: 'double',
    });
    expect(appointment.isOverride).toBe(true);
    expect(await prisma.appointment.count()).toBe(2);
  });

  /**
   * D-8's mechanics, asserted at the row: the constraint stays ABSOLUTE
   * because the override's blocked range is zero-width, and the true range
   * lives in `overriddenFromRange` so the day view can render the collision.
   */
  it('writes a zero-width blocked range and keeps the true one for display', async () => {
    await book({ idempotencyKey: 'first' });
    const appointment = await book({
      startAt: TEN_AM,
      isOverride: true,
      overrideReason: 'she can take both',
      idempotencyKey: 'double',
    });

    const rows = await prisma.$queryRawUnsafe<{ zero: boolean; lower: Date; upper: Date }[]>(
      `SELECT "blockedStart" = "blockedEnd" AS zero,
              lower("overriddenFromRange") AS lower,
              upper("overriddenFromRange") AS upper
         FROM "Appointment" WHERE id = $1`,
      appointment.id,
    );
    expect(rows[0]!.zero).toBe(true);
    expect(hhmm(rows[0]!.lower)).toBe('10:00');
    expect(hhmm(rows[0]!.upper)).toBe('11:15'); // body + buffer
  });

  it('records the override and its reason in the event log', async () => {
    const appointment = await book({
      startAt: at('2026-06-09T18:00:00-05:00'),
      isOverride: true,
      overrideReason: 'wedding party',
    });

    const event = await prisma.appointmentEvent.findFirstOrThrow({ where: { appointmentId: appointment.id } });
    expect(event.type).toBe('override_booked');
    expect(event.reason).toBe('wedding party');
    expect(event.actor).toBe('staff');
  });

  it('refuses an override with no reason', async () => {
    await expect(
      book({ startAt: at('2026-06-09T18:00:00-05:00'), isOverride: true, overrideReason: '  ' }),
    ).rejects.toMatchObject({ name: 'BookingRejected', field: 'overrideReason' });
  });

  /** D-8's hard edge: "customer self-serve can never create a conflict". */
  it('refuses an override from a customer, whatever the reason says', async () => {
    await expect(
      book({ audience: 'public', isOverride: true, overrideReason: 'please' }),
    ).rejects.toMatchObject({ name: 'BookingRejected', field: 'isOverride' });
  });
});

describe('BOOK-04 — the walk-in', () => {
  it('lists who could take her, soonest first', async () => {
    const options = await walkInOptions(prisma, {
      businessId,
      serviceIds: [cutId],
      day: DAY,
      now: at('2026-06-09T09:55:00-05:00'),
    });

    expect(options.map((o) => o.providerName)).toEqual(['Dana', 'Priya']);
    // 10:00, not 09:55: "starting now" means as soon as possible, on the
    // salon's own grid — an off-grid start leaves a sliver nobody can sell.
    expect(hhmm(options[0]!.startAt)).toBe('10:00');
  });

  it('skips a provider who is not free until later, and orders by time', async () => {
    await createTimeOff(
      prisma,
      { businessId, providerId: danaId, startAt: at('2026-06-09T09:00:00-05:00'), endAt: at('2026-06-09T13:00:00-05:00'), reason: 'dentist' },
      STAMP,
    );

    const options = await walkInOptions(prisma, { businessId, serviceIds: [cutId], day: DAY, now: at('2026-06-09T09:55:00-05:00') });
    expect(options[0]!.providerName).toBe('Priya');
    expect(hhmm(options.find((o) => o.providerName === 'Dana')!.startAt)).toBe('13:00');
  });

  /** VISIT-01: one provider does the WHOLE visit. Priya does cuts but not
   *  colour, so she cannot take a cut+colour walk-in at all. */
  it('only offers a provider qualified for every service in the visit', async () => {
    const options = await walkInOptions(prisma, {
      businessId,
      serviceIds: [cutId, colourId],
      day: DAY,
      now: at('2026-06-09T09:55:00-05:00'),
    });
    expect(options.map((o) => o.providerName)).toEqual(['Dana']);
  });

  it('returns nobody when the day is finished', async () => {
    const options = await walkInOptions(prisma, { businessId, serviceIds: [cutId], day: DAY, now: at('2026-06-09T20:00:00-05:00') });
    expect(options).toEqual([]);
  });

  it('books with no client record at all (“walk-in, no name”)', async () => {
    const appointment = await book({ clientId: null });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.clientId).toBeNull();
  });
});

describe('D-17 — the soft same-client note', () => {
  it('reports an overlapping appointment the same client already holds', async () => {
    await book();

    const clashes = await clientAlreadyBookedAround(prisma, {
      businessId,
      clientId,
      startAt: at('2026-06-09T10:30:00-05:00'),
      endAt: at('2026-06-09T11:30:00-05:00'),
    });
    expect(clashes).toHaveLength(1);
    expect(clashes[0]!.providerName).toBe('Dana');
  });

  it('says nothing when the times do not overlap', async () => {
    await book();
    const clashes = await clientAlreadyBookedAround(prisma, {
      businessId,
      clientId,
      startAt: at('2026-06-09T14:00:00-05:00'),
      endAt: at('2026-06-09T15:00:00-05:00'),
    });
    expect(clashes).toEqual([]);
  });

  it('ignores a cancelled appointment', async () => {
    const appointment = await book();
    await prisma.appointment.update({ where: { id: appointment.id }, data: { status: 'cancelled' } });

    const clashes = await clientAlreadyBookedAround(prisma, {
      businessId,
      clientId,
      startAt: TEN_AM,
      endAt: at('2026-06-09T11:00:00-05:00'),
    });
    expect(clashes).toEqual([]);
  });

  /**
   * It is a NOTE, not a refusal. Mum with Dana and daughter with Priya at 2pm
   * is one phone number and two people — and even the same client twice is
   * the salon's call to make (D-17: no client-axis constraint).
   */
  it('does not prevent the booking it warns about', async () => {
    await book();
    const second = await book({ providerId: priyaId, idempotencyKey: 'same-client-again' });
    expect(second.id).toBeDefined();
  });
});

describe('the segmentPattern snapshot (D-29, A-030)', () => {
  /** Splits the 90-minute Colour into 40 active / 25 developing / 25 active. */
  const splitColour = () =>
    prisma.serviceSegment.createMany({
      data: [
        { businessId, serviceId: colourId, ordinal: 0, durationMinutes: 40, isGap: false },
        { businessId, serviceId: colourId, ordinal: 1, durationMinutes: 25, isGap: true },
        { businessId, serviceId: colourId, ordinal: 2, durationMinutes: 25, isGap: false },
      ],
    });

  it('is EMPTY for an unsegmented service, so nothing changed for an ordinary booking', async () => {
    const appointment = await book();
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.segmentPattern).toEqual([]);
    expect(await prisma.appointmentBlock.count({ where: { appointmentId: row.id } })).toBe(1);
  });

  it('freezes the service segments onto the appointment, and the trigger cuts two blocks', async () => {
    await splitColour();
    const appointment = await book({ serviceIds: [colourId] });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.segmentPattern).toEqual([40, 25, 25]);

    const blocks = await prisma.appointmentBlock.findMany({
      where: { appointmentId: row.id },
      orderBy: { ordinal: 'asc' },
    });
    expect(blocks).toHaveLength(2);
    // 10:00 + 40 = 10:40, then the gap, then 11:05 to 11:30 plus the 10-minute
    // trailing buffer — buffers belong to the visit, not to each part.
    expect(blocks.map((b) => b.blockedStart.toISOString())).toEqual([
      '2026-06-09T15:00:00.000Z',
      '2026-06-09T16:05:00.000Z',
    ]);
    expect(blocks[1]!.blockedEnd.toISOString()).toBe('2026-06-09T16:40:00.000Z');
  });

  it('RE-SPLITTING THE SERVICE LATER does not re-cut an appointment already booked', async () => {
    await splitColour();
    const appointment = await book({ serviceIds: [colourId] });
    await prisma.serviceSegment.deleteMany({ where: { serviceId: colourId } });
    await prisma.serviceSegment.createMany({
      data: [
        { businessId, serviceId: colourId, ordinal: 0, durationMinutes: 10, isGap: false },
        { businessId, serviceId: colourId, ordinal: 1, durationMinutes: 70, isGap: true },
        { businessId, serviceId: colourId, ordinal: 2, durationMinutes: 10, isGap: false },
      ],
    });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    // Still the shape it was booked with. This is the gap A-029 left behind and
    // the reason D-29 snapshots rather than reading live: the alternative frees
    // 70 minutes of a client's appointment that nobody agreed to free.
    expect(row.segmentPattern).toEqual([40, 25, 25]);
  });

  it('merges the active runs of a multi-service visit into one pattern', async () => {
    await splitColour();
    // Cut (60, solid) then Colour (40/25gap/25): the cut and the colour's first
    // part are one 100-minute run of work.
    const appointment = await book({ serviceIds: [cutId, colourId] });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.segmentPattern).toEqual([100, 25, 25]);
  });
});
