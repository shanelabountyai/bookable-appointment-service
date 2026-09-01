/**
 * A-067 — time freed by something OTHER than a cancellation, against a real
 * database.
 *
 * A-055's own backlog row claimed a shortened visit's tail reached
 * `/staff/opened` "for free, because it derives". It did not: the list asked
 * the STATUS column what had been freed, and a shortened visit is still
 * `booked`. Same for a move off the day and a hand-over to another stylist.
 * So Mrs Hall drops her colour, ninety minutes of a Saturday afternoon stops
 * being occupied, and nothing anywhere says so.
 *
 * These tests go through the REAL mutators rather than writing events by hand,
 * because the thing under test is the seam between them and the list — a
 * hand-written payload would pass while `changeVisitServices` wrote a
 * different one, which is exactly the drift the item is about. The two bound
 * tests at the bottom are the exception: a backdated `createdAt` cannot be
 * produced by calling anything (the event log is append-only by trigger), so
 * those two write the row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '../../core/auth';
import { instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { reassignAppointment } from '../availability/reassign';
import { bookAppointment } from '../booking';
import { changeVisitServices } from './change-services';
import { listOpenedSlots } from './opened';
import { rescheduleAppointment } from './reschedule';
import { transitionAppointment } from './transition';

const prisma = new PrismaClient();
const STAFF = staffActor('staff-1');
const STAFF_WINDOW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };

const at = (iso: string) => toDate(instantFromIso(iso));

/** Frozen, and every fixture is relative to it (CLAUDE.md). Monday; the book
 *  below is Tuesday 9 June 2026, Chicago. */
const NOW = at('2026-06-08T08:00:00-05:00');
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
      minimumLeadMinutes: 0,
      cancellationCutoffMinutes: 120,
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;

  danaId = (await prisma.provider.create({ data: { businessId, displayName: 'Dana' } })).id;
  priyaId = (await prisma.provider.create({ data: { businessId, displayName: 'Priya' } })).id;

  // UNEQUAL BUFFERS on purpose (CLAUDE.md): equal ones hide whose-buffer bugs,
  // and every span in this file is a buffer edge.
  cutId = (
    await prisma.service.create({
      data: {
        businessId,
        name: 'Cut',
        durationMinutes: 60,
        priceCents: 5500,
        bufferBeforeMinutes: 5,
        bufferAfterMinutes: 15,
      },
    })
  ).id;
  colourId = (
    await prisma.service.create({
      data: {
        businessId,
        name: 'Colour',
        durationMinutes: 90,
        priceCents: 12000,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 20,
      },
    })
  ).id;
  await prisma.serviceProvider.createMany({
    data: [danaId, priyaId].flatMap((providerId) =>
      [cutId, colourId].map((serviceId) => ({ businessId, serviceId, providerId })),
    ),
  });

  clientId = (
    await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })
  ).id;

  await createWeeklyWindow(
    prisma,
    { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
    STAFF_WINDOW,
  );
  for (const providerId of [danaId, priyaId]) {
    await createWeeklyWindow(
      prisma,
      { businessId, providerId, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
      STAFF_WINDOW,
    );
  }
});

const book = (over: Record<string, unknown> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId: danaId,
    serviceIds: [cutId],
    clientId,
    startAt: TEN_AM,
    now: NOW,
    actor: STAFF,
    audience: 'staff',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

const list = () => listOpenedSlots(prisma, { businessId, now: NOW });

/**
 * THE ITEM'S OWN TEST. Two hours becomes one, and the ninety minutes has to
 * turn up on the list that exists to sell it.
 *
 * Cut + Colour from 10:00 is 150 minutes of body with a 5-minute before and a
 * 20-minute after, so the visit HELD 09:55–12:50. Dropping the colour leaves a
 * cut: 09:55–11:15. What it let go of is 11:15–12:50 — ninety-five minutes,
 * the ninety she dropped plus the twenty-minute buffer the colour was carrying
 * minus the fifteen the cut still carries.
 */
describe('a visit shortened at the chair (A-055)', () => {
  it('puts the tail on the list, with the DROPPED service as the one to ring about', async () => {
    const appointment = await book({ serviceIds: [cutId, colourId] });
    await changeVisitServices(prisma, {
      appointmentId: appointment.id,
      serviceIds: [cutId],
      now: NOW,
      actor: STAFF,
      audience: 'staff',
    });

    const slots = await list();

    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      appointmentId: appointment.id,
      providerName: 'Dana',
      clientName: 'Ada Chen',
      clientPhone: '5125550101',
      freedMinutes: 95,
      // `matchFreedSlot` filters the waitlist on ONE serviceId, and it is the
      // colour she dropped that somebody else wants — not the cut she kept.
      primaryServiceId: colourId,
      serviceNames: ['Colour'],
      status: 'booked',
      freedBy: { kind: 'shortened', droppedServiceNames: ['Colour'] },
    });
    expect(slots[0]!.startAt).toEqual(at('2026-06-09T11:15:00-05:00'));
    expect(slots[0]!.blockedEnd).toEqual(at('2026-06-09T12:50:00-05:00'));
  });

  /** The other half, and the reason nothing stored is right: selling the tail
   *  retires the row, and no code anywhere had to remember to clear it. */
  it('drops off again the moment somebody books over it, with no clearing code', async () => {
    const appointment = await book({ serviceIds: [cutId, colourId] });
    await changeVisitServices(prisma, {
      appointmentId: appointment.id,
      serviceIds: [cutId],
      now: NOW,
      actor: STAFF,
      audience: 'staff',
    });
    expect(await list()).toHaveLength(1);

    // 11:30 is on the 15-minute grid and its before-buffer starts at 11:25 —
    // clear of the shortened cut, which lets go at 11:15.
    await book({ startAt: at('2026-06-09T11:30:00-05:00') });

    expect(await list()).toHaveLength(0);
  });

  it('reports nothing for a visit that got LONGER — an add-on freed no time', async () => {
    const appointment = await book();
    await changeVisitServices(prisma, {
      appointmentId: appointment.id,
      serviceIds: [cutId, colourId],
      now: NOW,
      actor: STAFF,
      audience: 'staff',
    });

    expect(await list()).toHaveLength(0);
  });

  /** Shortened and then cancelled outright is ONE gap, so it is one phone
   *  call. The cancellation row wins because it is the bigger truth ("she is
   *  not coming"); its known ceiling is that the row then understates the span
   *  by the tail she had already dropped. */
  it('reports a shortened-then-cancelled visit once, as the cancellation', async () => {
    const appointment = await book({ serviceIds: [cutId, colourId] });
    await changeVisitServices(prisma, {
      appointmentId: appointment.id,
      serviceIds: [cutId],
      now: NOW,
      actor: STAFF,
      audience: 'staff',
    });
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      now: NOW,
      actor: STAFF,
    });

    const slots = await list();

    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ status: 'cancelled', freedBy: { kind: 'cancelled' } });
  });
});

describe('a visit moved off its time (D-6)', () => {
  it('reports the range it vacated, saying where it went', async () => {
    const appointment = await book();
    await rescheduleAppointment(prisma, {
      appointmentId: appointment.id,
      startAt: at('2026-06-09T14:00:00-05:00'),
      now: NOW,
      actor: STAFF,
      audience: 'staff',
    } as Parameters<typeof rescheduleAppointment>[1]);

    const slots = await list();

    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      providerName: 'Dana',
      // 09:55–11:15, buffers and all.
      freedMinutes: 80,
      freedBy: { kind: 'rescheduled', movedToStartAt: at('2026-06-09T14:00:00-05:00') },
    });
    expect(slots[0]!.startAt).toEqual(at('2026-06-09T09:55:00-05:00'));
  });

  /**
   * A cross-provider move writes TWO events in one transaction (D-31) and
   * vacates ONE span. Reporting both would tell the desk that Priya's two
   * o'clock is free — the chair the appointment is now sitting in.
   */
  it('reports ONE span for a move that also changed stylist, on the stylist it LEFT', async () => {
    const appointment = await book();
    await rescheduleAppointment(prisma, {
      appointmentId: appointment.id,
      startAt: at('2026-06-09T14:00:00-05:00'),
      toProviderId: priyaId,
      now: NOW,
      actor: STAFF,
      audience: 'staff',
    } as Parameters<typeof rescheduleAppointment>[1]);

    const slots = await list();

    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ providerId: danaId, providerName: 'Dana', freedMinutes: 80 });
    expect(slots[0]!.startAt).toEqual(at('2026-06-09T09:55:00-05:00'));
  });
});

describe('a visit handed to another stylist (A-038/A-042)', () => {
  it('reports the chair it left, naming who took it', async () => {
    const appointment = await book();
    await reassignAppointment(prisma, {
      businessId,
      appointmentId: appointment.id,
      toProviderId: priyaId,
      actor: STAFF,
    });

    const slots = await list();

    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      providerId: danaId,
      providerName: 'Dana',
      freedMinutes: 80,
      freedBy: { kind: 'reassigned', movedToProviderName: 'Priya' },
    });
  });

  it('drops it once the stylist who vacated it has left (A-041)', async () => {
    const appointment = await book();
    await reassignAppointment(prisma, {
      businessId,
      appointmentId: appointment.id,
      toProviderId: priyaId,
      actor: STAFF,
    });
    await prisma.provider.update({ where: { id: danaId }, data: { active: false } });

    expect(await list()).toHaveLength(0);
  });
});

/**
 * The bounds, on the event-sourced half. Written by hand because the log is
 * append-only by trigger, so a backdated `createdAt` cannot be produced by
 * calling `changeVisitServices` — and the whole point of BOUND 2 is a date no
 * mutator will ever produce during a test run.
 */
describe('the bounds, on a freed tail', () => {
  /** A cut at 10:00 that used to be a cut + colour: blocked 09:55–11:15 now,
   *  09:55–12:50 before. */
  async function shortenedByHand(options: { changedAt: Date; day?: string; legacyPayload?: boolean }) {
    const day = options.day ?? '2026-06-09';
    const appointment = await prisma.appointment.create({
      data: {
        businessId,
        providerId: danaId,
        clientId,
        status: 'booked',
        startAt: at(`${day}T10:00:00-05:00`),
        endAt: at(`${day}T11:00:00-05:00`),
        blockedStart: at(`${day}T09:55:00-05:00`),
        blockedEnd: at(`${day}T11:15:00-05:00`),
        startDay: day,
        startWallTime: '10:00',
        // The A-003 trigger RECOMPUTES the blocked range from these on every
        // write, so hand-writing `blockedStart`/`blockedEnd` without them
        // silently gets you the body back — 5 and 15 are the cut's.
        bufferBeforeMinutes: 5,
        bufferAfterMinutes: 15,
        lines: { create: { businessId, serviceId: cutId, ordinal: 0, priceCents: 5500, durationMinutes: 60 } },
      },
    });
    await prisma.appointmentEvent.create({
      data: {
        businessId,
        appointmentId: appointment.id,
        type: 'services_changed',
        actor: 'staff',
        actorRef: 'staff-1',
        createdAt: options.changedAt,
        payload: {
          added: [],
          removed: ['Colour'],
          fromEndAt: at(`${day}T12:30:00-05:00`).toISOString(),
          toEndAt: at(`${day}T11:00:00-05:00`).toISOString(),
          // A-067's two additions. Omitted for the legacy case, which is every
          // event already in the log when this shipped.
          ...(options.legacyPayload === true
            ? {}
            : { removedServiceIds: [colourId], fromBlockedEnd: at(`${day}T12:50:00-05:00`).toISOString() }),
        },
      },
    });
    return appointment;
  }

  it('drops a tail that has already passed — yesterday cannot be sold', async () => {
    await shortenedByHand({ changedAt: at('2026-06-06T09:00:00-05:00'), day: '2026-06-02' });

    expect(await list()).toHaveLength(0);
  });

  it('drops a change older than the lookback, however open the tail still is', async () => {
    await shortenedByHand({ changedAt: at('2026-04-01T09:00:00-05:00') });

    expect(await list()).toHaveLength(0);
    // …and it is the lookback doing it, not the June date.
    expect(await listOpenedSlots(prisma, { businessId, now: NOW, lookbackDays: 365 })).toHaveLength(1);
  });

  it('drops a tail the stylist is now off for — that is the conflicts screen', async () => {
    await shortenedByHand({ changedAt: at('2026-06-07T09:00:00-05:00') });
    await prisma.timeOff.create({
      data: {
        businessId,
        providerId: danaId,
        startAt: at('2026-06-09T11:00:00-05:00'),
        endAt: at('2026-06-09T18:00:00-05:00'),
        reason: 'sick',
      },
    });

    expect(await list()).toHaveLength(0);
  });

  it('falls back to the body end for an event written before A-067 recorded the blocked one', async () => {
    await shortenedByHand({ changedAt: at('2026-06-07T09:00:00-05:00'), legacyPayload: true });

    const slots = await list();

    // 11:15 → 12:30 rather than 12:50: one buffer short, which is the safe
    // direction. It never names time the visit still holds.
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ freedMinutes: 75, primaryServiceId: cutId });
  });
});
