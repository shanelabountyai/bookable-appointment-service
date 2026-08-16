/**
 * A-012 — transitions against the real database.
 *
 * The pure table is exhaustively tested in
 * `packages/core/scheduling/transitions.test.ts`; nothing here re-tests which
 * cells are legal. These assert the things only a database can be wrong
 * about: the busy set actually changing, the cutoff being resolved from real
 * service rows, the event log being written and append-only, actual timestamps
 * landing where D-7 says, and two front-desk taps not producing two events.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { customerTokenActor, staffActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from '../booking';
import { computeDaySlots } from '../scheduling';
import { AppointmentMovedFirst, TransitionRefused, transitionAppointment } from './transition';

const prisma = new PrismaClient();
const STAFF_ROW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const STAFF = staffActor('staff-1');
const CUSTOMER = customerTokenActor('token-1');

const at = (iso: string) => toDate(instantFromIso(iso));
const DAY = '2026-06-09'; // Tuesday
const TEN_AM = at('2026-06-09T10:00:00-05:00');
const BEFORE = at('2026-06-09T08:00:00-05:00');
/** After the appointment's scheduled end (10:00 + 60 min). */
const AFTER_END = at('2026-06-09T11:30:00-05:00');

let businessId: string;
let providerId: string;
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
      cancellationCutoffMinutes: 120,
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  providerId = dana.id;

  const service = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500, bufferAfterMinutes: 15 },
  });
  serviceId = service.id;
  await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId } });

  const client = await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } });
  clientId = client.id;

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAFF_ROW);
  await createWeeklyWindow(prisma, { businessId, providerId, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false }, STAFF_ROW);
});

const book = (over: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [serviceId],
    clientId,
    startAt: TEN_AM,
    now: BEFORE,
    actor: STAFF,
    audience: 'staff',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

const tenAmOffered = async () =>
  (await computeDaySlots(prisma, { businessId, providerId, serviceIds: [serviceId], day: DAY, now: BEFORE, audience: 'staff' })).slots.some(
    (s) => s.start === TEN_AM.getTime(),
  );

describe('D-7 — which statuses free the slot', () => {
  it('keeps the time occupied while the appointment is live', async () => {
    await book();
    expect(await tenAmOffered()).toBe(false);
  });

  it.each(['cancelled', 'cancelled_late'] as const)('frees the time on %s', async (to) => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to, actor: STAFF, now: BEFORE });
    expect(await tenAmOffered()).toBe(true);
  });

  /**
   * THE D-7 TRAP. `completed` and `no_show` are terminal but still OCCUPY.
   * Getting this wrong puts a gap in the day view where a client was actually
   * sitting, and lets the engine sell a slot that was already worked.
   */
  it('keeps the time occupied on completed', async () => {
    const appointment = await book();
    // §7 has no booked -> completed edge: a visit that was never checked in
    // cannot have finished. Routing through the real path is the point.
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: TEN_AM });
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'completed', actor: STAFF, now: AFTER_END });
    expect(await tenAmOffered()).toBe(false);
  });

  it('keeps the time occupied on no_show', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'no_show', actor: STAFF, now: AFTER_END });
    expect(await tenAmOffered()).toBe(false);
  });

  it('lets a freed slot be booked by somebody else', async () => {
    const first = await book();
    await transitionAppointment(prisma, { appointmentId: first.id, to: 'cancelled', actor: STAFF, now: BEFORE });
    const second = await book({ idempotencyKey: 'second' });
    expect(second.id).not.toBe(first.id);
    expect(second.startAt.toISOString()).toBe(TEN_AM.toISOString());
  });
});

describe('APPT-07 — the event log', () => {
  it('appends one event per transition, with actor and both sides', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'confirmed', actor: CUSTOMER, now: BEFORE });
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: BEFORE });

    const events = await prisma.appointmentEvent.findMany({
      where: { appointmentId: appointment.id },
      orderBy: { createdAt: 'asc' },
    });
    // The booking itself wrote the first one (A-009).
    expect(events.map((e) => e.type)).toEqual(['booked', 'status_changed', 'status_changed']);
    expect(events[1]!.actor).toBe('customer_token');
    expect(events[1]!.actorRef).toBe('token-1');
    expect(events[1]!.payload).toMatchObject({ from: 'booked', to: 'confirmed' });
    expect(events[2]!.actor).toBe('staff');
    expect(events[2]!.payload).toMatchObject({ from: 'confirmed', to: 'checked_in' });
  });

  it('records a terminal correction as a correction, not an ordinary change', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'no_show', actor: STAFF, now: AFTER_END });
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      actor: STAFF,
      now: AFTER_END,
      reason: 'she was here, I tapped the wrong row',
    });

    const last = await prisma.appointmentEvent.findFirstOrThrow({
      where: { appointmentId: appointment.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(last.type).toBe('status_corrected');
    expect(last.reason).toBe('she was here, I tapped the wrong row');
  });

  it('cannot be rewritten afterwards — the log is append-only by trigger', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'cancelled', actor: STAFF, now: BEFORE });
    const event = await prisma.appointmentEvent.findFirstOrThrow({ where: { appointmentId: appointment.id } });
    await expect(
      prisma.appointmentEvent.update({ where: { id: event.id }, data: { reason: 'rewritten' } }),
    ).rejects.toThrow();
  });

  it('writes no event when the transition is refused', async () => {
    const appointment = await book();
    const before = await prisma.appointmentEvent.count({ where: { appointmentId: appointment.id } });
    await expect(
      transitionAppointment(prisma, { appointmentId: appointment.id, to: 'completed', actor: STAFF, now: BEFORE }),
    ).rejects.toBeInstanceOf(TransitionRefused);
    expect(await prisma.appointmentEvent.count({ where: { appointmentId: appointment.id } })).toBe(before);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.status).toBe('booked');
  });
});

describe('D-7 — actual timestamps, not scheduled ones', () => {
  it('stamps each arrival step with when it really happened', async () => {
    const appointment = await book();
    const late = at('2026-06-09T10:12:00-05:00');
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: late });
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'in_progress',
      actor: STAFF,
      now: at('2026-06-09T10:20:00-05:00'),
    });
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'completed', actor: STAFF, now: AFTER_END });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    // Scheduled times are untouched — "she was twelve minutes late" is the
    // difference between the two, and needs both.
    expect(row.startAt.toISOString()).toBe(TEN_AM.toISOString());
    expect(row.checkedInAt?.toISOString()).toBe(late.toISOString());
    expect(row.startedAt?.toISOString()).toBe(at('2026-06-09T10:20:00-05:00').toISOString());
    expect(row.endedAt?.toISOString()).toBe(AFTER_END.toISOString());
  });

  it('clears the arrival timestamps when a completed visit is corrected to a no-show', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: TEN_AM });
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'completed', actor: STAFF, now: AFTER_END });
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'no_show',
      actor: STAFF,
      now: AFTER_END,
      reason: 'wrong row',
    });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    // A client who never arrived cannot have a check-in time.
    expect(row.checkedInAt).toBeNull();
    expect(row.endedAt).toBeNull();
    // ...and the log still knows they existed.
    const event = await prisma.appointmentEvent.findFirstOrThrow({
      where: { appointmentId: appointment.id, type: 'status_corrected' },
    });
    expect(event.payload).toMatchObject({ clearedCheckedInAt: TEN_AM.toISOString() });
  });

  /** Correcting a no-show to completed must NOT invent an end time: the
   *  correction happens days later, and `now` would be a fabricated
   *  measurement that a utilization report would then average in. */
  it('invents no end time when a no-show is corrected to completed', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'no_show', actor: STAFF, now: AFTER_END });
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      actor: STAFF,
      now: at('2026-06-14T09:00:00-05:00'),
      reason: 'she was here',
    });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.status).toBe('completed');
    expect(row.endedAt).toBeNull();
  });
});

describe('D-19 — the cutoff comes from the rows, most restrictive first', () => {
  it('uses the service cutoff when it demands more notice than the business', async () => {
    // Business says 120 minutes; this service says a full day.
    await prisma.service.update({ where: { id: serviceId }, data: { cancellationCutoffMinutes: 24 * 60 } });
    const appointment = await book();

    // Three hours before: outside the business cutoff, INSIDE the service's.
    const threeHoursBefore = at('2026-06-09T07:00:00-05:00');
    await expect(
      transitionAppointment(prisma, {
        appointmentId: appointment.id,
        to: 'cancelled',
        actor: CUSTOMER,
        now: threeHoursBefore,
      }),
    ).rejects.toMatchObject({ refusal: 'inside-cancellation-cutoff' });

    // The same moment is a legitimate LATE cancellation.
    const result = await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled_late',
      actor: CUSTOMER,
      now: threeHoursBefore,
    });
    expect(result.to).toBe('cancelled_late');
  });

  it('falls back to the business cutoff when the service defers', async () => {
    const appointment = await book();
    // 121 minutes before start: outside the business's 120.
    const outside = at('2026-06-09T07:59:00-05:00');
    const result = await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      actor: CUSTOMER,
      now: outside,
    });
    expect(result.to).toBe('cancelled');
  });

  it('lets staff cancel inside the cutoff when the customer cannot', async () => {
    const appointment = await book();
    const inside = at('2026-06-09T09:30:00-05:00');
    await expect(
      transitionAppointment(prisma, { appointmentId: appointment.id, to: 'cancelled', actor: CUSTOMER, now: inside }),
    ).rejects.toMatchObject({ refusal: 'inside-cancellation-cutoff' });
    const result = await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      actor: STAFF,
      now: inside,
    });
    expect(result.to).toBe('cancelled');
  });
});

describe('two people at the front desk', () => {
  it('lets exactly one of two simultaneous check-ins win, and writes one event', async () => {
    const appointment = await book();
    const attempt = () =>
      transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: TEN_AM });

    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(AppointmentMovedFirst);

    // One status, ONE event. Two events for one real-world act is what makes
    // the detail panel read like a lie.
    expect(
      await prisma.appointmentEvent.count({ where: { appointmentId: appointment.id, type: 'status_changed' } }),
    ).toBe(1);
  });

  it('reports what the appointment actually became when the caller guessed wrong', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'cancelled', actor: STAFF, now: BEFORE });

    await expect(
      transitionAppointment(prisma, {
        appointmentId: appointment.id,
        to: 'checked_in',
        actor: STAFF,
        now: TEN_AM,
        expectedFrom: 'booked',
      }),
    ).rejects.toMatchObject({ name: 'AppointmentMovedFirst', expected: 'booked', actual: 'cancelled' });
  });
});
