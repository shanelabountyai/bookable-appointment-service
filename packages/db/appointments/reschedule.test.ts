/**
 * A-014 — reschedule against a real database (APPT-05, D-6, spec §4.6).
 *
 * The assertions that matter are the ones that would still pass if this were
 * written as cancel-then-book: "the appointment moved" is true either way.
 * So the tests below pin the things only a same-row UPDATE gives you — the id
 * survives, the manage link survives, one row exists throughout, and a move
 * that overlaps its own old time is legal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromDate, instant, instantFromIso, toDate } from '../../core/time';
import { customerTokenActor, staffActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { SlotNotOffered, SlotTaken, bookAppointment } from '../booking';
import { issueManageToken, verifyManageToken } from './manage-token';
import { AppointmentAlreadyMoved, rescheduleAppointment } from './reschedule';

const prisma = new PrismaClient();
const STAFF_WINDOW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const STAFF = staffActor('staff-1');

const at = (iso: string) => toDate(instantFromIso(iso));
const after = (base: Date, ms: number) => toDate(instant(fromDate(base) + ms));

// Tuesday 9 June 2026, Chicago. The business opens 09:00–18:00, Dana 09:00–17:00.
const TEN_AM = at('2026-06-09T10:00:00-05:00');
const NOW = at('2026-06-08T08:00:00-05:00'); // the day before, so nothing is inside the cutoff

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
      // Two hours' notice, so "the day before" is outside and "an hour before"
      // is inside.
      cancellationCutoffMinutes: 120,
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  const priya = await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } });
  providerId = dana.id;
  otherProviderId = priya.id;

  const service = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500, bufferAfterMinutes: 15 },
  });
  serviceId = service.id;
  await prisma.serviceProvider.createMany({
    data: [
      { businessId, serviceId, providerId: dana.id },
      { businessId, serviceId, providerId: priya.id },
    ],
  });

  clientId = (
    await prisma.client.create({
      data: { businessId, name: 'Ada Chen', phone: '5125550101', email: 'ada@example.test' },
    })
  ).id;

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAFF_WINDOW);
  for (const p of [dana.id, priya.id]) {
    await createWeeklyWindow(prisma, { businessId, providerId: p, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false }, STAFF_WINDOW);
  }
});

const book = (over: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [serviceId],
    clientId,
    startAt: TEN_AM,
    now: NOW,
    actor: STAFF,
    audience: 'staff',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

const move = (id: string, to: Date, over: Partial<Parameters<typeof rescheduleAppointment>[1]> = {}) =>
  rescheduleAppointment(prisma, {
    appointmentId: id,
    startAt: to,
    now: NOW,
    actor: STAFF,
    audience: 'staff',
    ...over,
  });

describe('D-6 — the row survives the move', () => {
  it('updates the SAME row rather than creating another', async () => {
    const appointment = await book();
    const moved = await move(appointment.id, at('2026-06-09T14:00:00-05:00'));

    expect(moved.id).toBe(appointment.id);
    // One row throughout. Cancel-then-book would leave two, and every history
    // view, report and foreign key would have to know which one is real.
    expect(await prisma.appointment.count()).toBe(1);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.startAt.toISOString()).toBe(at('2026-06-09T14:00:00-05:00').toISOString());
    expect(row.status).toBe('booked');
  });

  /**
   * THE TEST THAT FAILS WITHOUT `excludeAppointmentId`, and the most common
   * reschedule there is: "can we push it half an hour?"
   *
   * The exclusion constraint compares the updated row against OTHER rows, so
   * it permits this (spec §4.6) — but the engine, re-run inside the same
   * transaction, sees the appointment sitting at its old time and would refuse
   * its own destination as `overlaps-booking`.
   */
  it('moves an appointment to a time overlapping its own old range', async () => {
    const appointment = await book(); // 10:00–11:00, +15 after
    const moved = await move(appointment.id, at('2026-06-09T10:30:00-05:00'));

    expect(moved.to.toISOString()).toBe(at('2026-06-09T10:30:00-05:00').toISOString());
    expect(moved.endAt.toISOString()).toBe(at('2026-06-09T11:30:00-05:00').toISOString());
  });

  it('lets the vacated time be booked immediately afterwards', async () => {
    const appointment = await book();
    await move(appointment.id, at('2026-06-09T14:00:00-05:00'));

    // Proof the busy set followed the move: the trigger recomputed the blocked
    // range, so 10:00 is genuinely free rather than merely renamed.
    const second = await book({ idempotencyKey: 'the-replacement' });
    expect(second.startAt.toISOString()).toBe(TEN_AM.toISOString());
    expect(await prisma.appointment.count()).toBe(2);
  });

  it('moves the blocked range with the appointment, buffers included', async () => {
    const appointment = await book();
    await move(appointment.id, at('2026-06-09T14:00:00-05:00'));

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.blockedStart.toISOString()).toBe(at('2026-06-09T14:00:00-05:00').toISOString());
    // 60 minutes of service + the 15-minute after-buffer.
    expect(row.blockedEnd.toISOString()).toBe(at('2026-06-09T15:15:00-05:00').toISOString());
  });

  it('rewrites the denormalized business-day labels', async () => {
    const appointment = await book();
    await move(appointment.id, at('2026-06-16T09:30:00-05:00')); // the following Tuesday

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.startDay).toBe('2026-06-16');
    expect(row.startWallTime).toBe('09:30');
  });

  it('keeps the duration it was BOOKED with, not the catalogue’s current one (D-18)', async () => {
    const appointment = await book();
    // The owner shortens the service after the booking is made.
    await prisma.service.update({ where: { id: serviceId }, data: { durationMinutes: 30 } });

    const moved = await move(appointment.id, at('2026-06-09T14:00:00-05:00'));

    // Still an hour: a reschedule moves an appointment, it does not re-sell it.
    expect(fromDate(moved.endAt) - fromDate(moved.to)).toBe(60 * 60_000);
  });
});

describe('APPT-07 — both sides are in the log', () => {
  it('records one rescheduled event carrying the old time and the new', async () => {
    const appointment = await book();
    await move(appointment.id, at('2026-06-09T14:00:00-05:00'), {
      actor: STAFF,
      reason: 'client asked for the afternoon',
    });

    const event = await prisma.appointmentEvent.findFirstOrThrow({ where: { type: 'rescheduled' } });
    const payload = event.payload as { from: string; to: string };
    // The old time exists NOWHERE else after the update — the log is the
    // history (D-6), which is why it is append-only.
    expect(payload.from).toBe(TEN_AM.toISOString());
    expect(payload.to).toBe(at('2026-06-09T14:00:00-05:00').toISOString());
    expect(event.actor).toBe('staff');
    expect(event.reason).toBe('client asked for the afternoon');
  });

  it('is not a status change — the appointment is still booked', async () => {
    const appointment = await book();
    await move(appointment.id, at('2026-06-09T14:00:00-05:00'));

    const statusEvents = await prisma.appointmentEvent.count({ where: { type: 'status_changed' } });
    expect(statusEvents).toBe(0);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).status).toBe('booked');
  });

  it('tells the client, keyed on the destination instant', async () => {
    const appointment = await book();
    await move(appointment.id, at('2026-06-09T14:00:00-05:00'));
    await move(appointment.id, at('2026-06-09T16:00:00-05:00'));

    const rows = await prisma.notificationOutbox.findMany({
      where: { appointmentId: appointment.id, template: 'appointment.rescheduled' },
    });
    // Two moves, two messages. Keyed on the appointment alone, the second move
    // would have been silent (P1-7's shape).
    expect(rows).toHaveLength(2);
  });
});

describe('TOKEN-02 — the manage link is re-pointed, never reissued', () => {
  it('keeps the customer’s existing link working after the move', async () => {
    const appointment = await book();
    const row = await prisma.notificationOutbox.findFirstOrThrow({
      where: { appointmentId: appointment.id, template: 'appointment.confirmed' },
    });
    const token = String((row.payload as { manageUrl: string }).manageUrl).replace('/manage/', '');

    await move(appointment.id, at('2026-06-16T09:30:00-05:00'));

    // The link she rescheduled FROM is the one she will open again to cancel.
    // A new row — or a reissued token — kills it at exactly that moment.
    const grant = await verifyManageToken(prisma, token, NOW);
    expect(grant?.appointmentId).toBe(appointment.id);
    expect(await prisma.manageToken.count({ where: { appointmentId: appointment.id } })).toBe(1);
  });

  it('moves the expiry to 24h after the NEW end', async () => {
    const appointment = await book();
    const newStart = at('2026-06-16T09:30:00-05:00');
    await move(appointment.id, newStart);

    const token = await prisma.manageToken.findFirstOrThrow({ where: { appointmentId: appointment.id } });
    const newEnd = after(newStart, 60 * 60_000);
    expect(token.expiresAt.toISOString()).toBe(after(newEnd, 24 * 60 * 60_000).toISOString());
  });

  it('does not revive a revoked link', async () => {
    const appointment = await book();
    const fresh = await issueManageToken(prisma, {
      businessId,
      appointmentId: appointment.id,
      endAt: at('2026-06-09T11:00:00-05:00'),
      now: NOW,
    });
    await prisma.manageToken.updateMany({ where: { appointmentId: appointment.id }, data: { revokedAt: NOW } });

    await move(appointment.id, at('2026-06-16T09:30:00-05:00'));

    expect(await verifyManageToken(prisma, fresh.token, NOW)).toBeNull();
  });
});

describe('APPT-05 — the cutoff applies to the token actor', () => {
  const CUSTOMER = customerTokenActor('token-1');
  // The appointment is at 10:00 with a 120-minute cutoff, so 09:30 is inside.
  const INSIDE = at('2026-06-09T09:30:00-05:00');

  it('refuses a customer inside the cutoff — a reschedule is a cancellation with extra steps', async () => {
    const appointment = await book();
    await expect(
      move(appointment.id, at('2026-06-09T14:00:00-05:00'), { actor: CUSTOMER, audience: 'public', now: INSIDE }),
    ).rejects.toMatchObject({ name: 'RescheduleRefused', refusal: 'inside-cancellation-cutoff' });

    // And nothing moved.
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.startAt.toISOString()).toBe(TEN_AM.toISOString());
  });

  it('allows the same customer OUTSIDE the cutoff', async () => {
    const appointment = await book();
    const moved = await move(appointment.id, at('2026-06-09T14:00:00-05:00'), {
      actor: CUSTOMER,
      audience: 'public',
      now: at('2026-06-09T07:00:00-05:00'),
    });
    expect(moved.to.toISOString()).toBe(at('2026-06-09T14:00:00-05:00').toISOString());
  });

  it('allows STAFF inside the cutoff — the front desk is not bound by it', async () => {
    const appointment = await book();
    const moved = await move(appointment.id, at('2026-06-09T14:00:00-05:00'), { actor: STAFF, now: INSIDE });
    expect(moved.to.toISOString()).toBe(at('2026-06-09T14:00:00-05:00').toISOString());
  });

  it('refuses to move a cancelled appointment at all', async () => {
    const appointment = await book();
    await prisma.appointment.update({ where: { id: appointment.id }, data: { status: 'cancelled' } });

    await expect(move(appointment.id, at('2026-06-09T14:00:00-05:00'))).rejects.toMatchObject({
      name: 'RescheduleRefused',
      refusal: 'not-permitted',
    });
  });

  it('refuses to move an appointment that is in progress', async () => {
    const appointment = await book();
    await prisma.appointment.update({ where: { id: appointment.id }, data: { status: 'in_progress' } });

    await expect(move(appointment.id, at('2026-06-09T14:00:00-05:00'))).rejects.toMatchObject({
      refusal: 'not-permitted',
    });
  });
});

describe('the engine is re-run inside the transaction', () => {
  it('refuses a destination another appointment already holds', async () => {
    const mine = await book();
    await book({ providerId, startAt: at('2026-06-09T14:00:00-05:00'), clientId: null, idempotencyKey: 'theirs' });

    await expect(move(mine.id, at('2026-06-09T14:00:00-05:00'))).rejects.toBeInstanceOf(SlotTaken);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: mine.id } })).startAt.toISOString()).toBe(
      TEN_AM.toISOString(),
    );
  });

  it('refuses a destination inside another appointment’s BUFFER', async () => {
    const mine = await book();
    // 14:00–15:00 with a 15-minute after-buffer, so 15:00 is blocked and
    // 15:15 is the first clean start.
    await book({ startAt: at('2026-06-09T14:00:00-05:00'), clientId: null, idempotencyKey: 'theirs' });

    await expect(move(mine.id, at('2026-06-09T15:00:00-05:00'))).rejects.toBeInstanceOf(SlotTaken);
  });

  it('refuses a destination outside working hours, and says why', async () => {
    const appointment = await book();
    await expect(move(appointment.id, at('2026-06-09T20:00:00-05:00'))).rejects.toMatchObject({
      name: 'SlotNotOffered',
    });
  });

  it('refuses a destination on a day the provider does not work', async () => {
    const appointment = await book();
    // Wednesday — no weekly window was created for it.
    await expect(move(appointment.id, at('2026-06-10T10:00:00-05:00'))).rejects.toBeInstanceOf(SlotNotOffered);
  });

  it('refuses a move to the time it already has', async () => {
    const appointment = await book();
    await expect(move(appointment.id, TEN_AM)).rejects.toMatchObject({
      name: 'SlotNotOffered',
      reasons: ['already-at-that-time'],
    });
    expect(await prisma.appointmentEvent.count({ where: { type: 'rescheduled' } })).toBe(0);
  });

  it('refuses a start that is not on a whole minute', async () => {
    const appointment = await book();
    const offGrid = after(at('2026-06-09T14:00:00-05:00'), 30_000);
    await expect(move(appointment.id, offGrid)).rejects.toBeInstanceOf(SlotNotOffered);
  });

  it('does not move an appointment onto another PROVIDER’s day (reassignment is A-019)', async () => {
    const appointment = await book();
    const moved = await move(appointment.id, at('2026-06-09T14:00:00-05:00'));
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: moved.id } });
    expect(row.providerId).toBe(providerId);
    expect(row.providerId).not.toBe(otherProviderId);
  });
});

describe('the write is conditional on the time it was decided against', () => {
  /**
   * Two front-desk taps moving the same appointment to two different times.
   * Both read `booked` at 10:00 and both pass their engine re-checks — the
   * destinations do not conflict with each other. Without the conditional
   * `WHERE startAt = ...`, both would write and the appointment would end up
   * at one time with two events claiming different ones.
   */
  it('refuses the second of two concurrent moves', async () => {
    const appointment = await book();

    const results = await Promise.allSettled([
      move(appointment.id, at('2026-06-09T14:00:00-05:00')),
      move(appointment.id, at('2026-06-09T16:00:00-05:00')),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')?.reason).toBeInstanceOf(AppointmentAlreadyMoved);

    // Exactly one move happened, and the log agrees with the row.
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    const events = await prisma.appointmentEvent.findMany({ where: { type: 'rescheduled' } });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { to: string }).to).toBe(row.startAt.toISOString());
  });
});
