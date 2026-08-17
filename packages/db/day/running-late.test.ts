/**
 * A-018 — running late and pushing the column (APPT-03, APPT-04, D-22).
 *
 * The two halves are deliberately different mechanisms and the tests say so:
 * the DELTA never touches `startAt`, and the PUSH is the only thing that does.
 * A test that could not tell them apart would let one become the other.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromDate, instant, instantFromIso, toDate, toLabel, zoneId } from '../../core/time';
import { staffActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from '../booking';
import { computeDaySlots } from '../scheduling';
import { PushRefused, previewPush, pushColumn } from './push-column';
import { clearRunningLate, findRunningLate, setRunningLate } from './running-late';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');

const at = (iso: string) => toDate(instantFromIso(iso));
const hhmm = (d: Date) => toLabel(fromDate(d), zoneId('America/Chicago')).time;
const after = (base: Date, ms: number) => toDate(instant(fromDate(base) + ms));
const DAY = '2026-06-09'; // Tuesday

let businessId: string;
let danaId: string;
let clientId: string;
let cutId: string;

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

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  danaId = dana.id;

  const cut = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 },
  });
  cutId = cut.id;
  await prisma.serviceProvider.create({ data: { businessId, serviceId: cutId, providerId: danaId } });

  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);
  await createWeeklyWindow(prisma, { businessId, providerId: danaId, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false }, STAMP);
});

const book = (startIso: string, over: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId: danaId,
    serviceIds: [cutId],
    clientId,
    startAt: at(startIso),
    now: at('2026-06-09T08:00:00-05:00'),
    actor: ACTOR,
    audience: 'staff',
    idempotencyKey: startIso,
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

describe('D-22 — the running-late delta', () => {
  const setLate = (minutes: number) =>
    setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes, actor: ACTOR });

  it('stores who said so and when', async () => {
    const late = await setLate(40);
    expect(late?.minutes).toBe(40);
    expect(late?.setByActor).toBe('staff');
    expect(late?.actorRef).toBe('staff-1');
  });

  it('is one value per provider per day, updated rather than accumulated', async () => {
    await setLate(40);
    await setLate(25);
    const rows = await findRunningLate(prisma, { businessId, day: DAY });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.minutes).toBe(25);
  });

  it('clears in one tap, and clearing means the row is gone', async () => {
    await setLate(40);
    await clearRunningLate(prisma, { providerId: danaId, day: DAY });
    expect(await findRunningLate(prisma, { businessId, day: DAY })).toEqual([]);
  });

  /** "On time" is the absence of a claim. A stored zero would render as
   *  "+0 min", which reads as a system that thinks this is interesting. */
  it('treats zero and negative as clearing', async () => {
    await setLate(40);
    expect(await setLate(0)).toBeNull();
    expect(await findRunningLate(prisma, { businessId, day: DAY })).toEqual([]);
  });

  /** THE HEADLINE (operator R-1): at 11:05 with Dana 40 behind, the website
   *  must stop selling her 11:15 while that client sits in the waiting area. */
  it('takes the next N minutes of slots off the board', async () => {
    const now = at('2026-06-09T11:05:00-05:00');
    const before = await computeDaySlots(prisma, { businessId, providerId: danaId, serviceIds: [cutId], day: DAY, now, audience: 'staff' });
    expect(before.slots.map((s) => hhmm(toDate(s.start)))).toContain('11:15');

    await setLate(40);

    const after = await computeDaySlots(prisma, { businessId, providerId: danaId, serviceIds: [cutId], day: DAY, now, audience: 'staff' });
    expect(after.slots.map((s) => hhmm(toDate(s.start)))).not.toContain('11:15');
    // ...and the reason is HER, not a phantom absence.
    const excluded = after.excluded.find((e) => hhmm(toDate(e.candidateStart)) === '11:15');
    expect(excluded?.reasons).toEqual(['provider-running-late']);
  });

  it('stops applying once the overrun has been worked off', async () => {
    await setLate(40);
    // An hour later the delta covers 12:05–12:45; 11:15 is free again.
    const now = at('2026-06-09T12:05:00-05:00');
    const result = await computeDaySlots(prisma, { businessId, providerId: danaId, serviceIds: [cutId], day: DAY, now, audience: 'staff' });
    expect(result.slots.map((s) => hhmm(toDate(s.start)))).toContain('13:00');
  });

  it('does not leak to another day', async () => {
    await setLate(40);
    const now = at('2026-06-16T11:05:00-05:00');
    const result = await computeDaySlots(prisma, { businessId, providerId: danaId, serviceIds: [cutId], day: '2026-06-16', now, audience: 'staff' });
    expect(result.slots.map((s) => hhmm(toDate(s.start)))).toContain('11:15');
  });

  /** It is a DELTA, not a rewrite. The confirmation the client is holding
   *  still says 11:15, and the record still says what she was booked for. */
  it('never touches an appointment’s startAt', async () => {
    const appointment = await book('2026-06-09T11:00:00-05:00');
    await setLate(40);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.startAt.toISOString()).toBe(at('2026-06-09T11:00:00-05:00').toISOString());
  });

  it('refuses a fractional number of minutes', async () => {
    await expect(setLate(12.5)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('APPT-04 — pushing the column', () => {
  const push = (minutes: number, fromIso = '2026-06-09T14:00:00-05:00') =>
    pushColumn(prisma, {
      businessId,
      providerId: danaId,
      day: DAY,
      fromAt: at(fromIso),
      minutes,
      actor: ACTOR,
      reason: 'Dana is an hour behind',
    });

  it('moves everything from the chosen time onwards, and nothing before it', async () => {
    const morning = await book('2026-06-09T10:00:00-05:00');
    const afternoon = await book('2026-06-09T14:00:00-05:00');

    const result = await push(30);
    expect(result.moved).toBe(1);

    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: morning.id } });
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: afternoon.id } });
    expect(hhmm(before.startAt)).toBe('10:00');
    expect(hhmm(after.startAt)).toBe('14:30');
  });

  /**
   * THE REASON THE CONSTRAINT IS DEFERRED. Shifting back-to-back appointments
   * moves the first onto the second's old range mid-transaction. With an
   * immediate check this fails whatever order the statements run in; deferred
   * to COMMIT, the intermediate state is allowed and the final one is still
   * absolutely enforced.
   */
  it('shifts a back-to-back run that would collide mid-transaction', async () => {
    // Deliberately ending well before the 17:00 close: a run whose last
    // appointment would fall past closing is refused as a whole (below), and
    // this test is about the intermediate collision, not that rule.
    await book('2026-06-09T13:00:00-05:00');
    await book('2026-06-09T14:00:00-05:00');
    await book('2026-06-09T15:00:00-05:00');

    const result = await push(30, '2026-06-09T13:00:00-05:00');
    expect(result.moved).toBe(3);

    const rows = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
    expect(rows.map((r) => hhmm(r.startAt))).toEqual(['13:30', '14:30', '15:30']);
  });

  it('still refuses a genuine overlap at COMMIT', async () => {
    // Deferring must not weaken the invariant: two rows landing on the same
    // range still fail, just later in the transaction.
    const overlapping = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
      SELECT count(*)::bigint AS count FROM "Appointment" a JOIN "Appointment" b
        ON a."providerId" = b."providerId" AND a.id < b.id
       AND a.status NOT IN ('cancelled','cancelled_late')
       AND b.status NOT IN ('cancelled','cancelled_late')
       AND tstzrange(a."blockedStart", a."blockedEnd", '[)')
        && tstzrange(b."blockedStart", b."blockedEnd", '[)')
    `);
    expect(Number(overlapping[0]!.count)).toBe(0);
  });

  /** APPT-04: "refuses silently-lossy shifts". A column that half-moved is
   *  worse than one that did not. */
  it('refuses the whole push when one appointment would fall past closing', async () => {
    await book('2026-06-09T14:00:00-05:00');
    await book('2026-06-09T16:00:00-05:00'); // ends 17:00, the close

    await expect(push(60)).rejects.toBeInstanceOf(PushRefused);

    const rows = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
    expect(rows.map((r) => hhmm(r.startAt))).toEqual(['14:00', '16:00']);
  });

  it('names the appointment that cannot move, in the preview', async () => {
    await book('2026-06-09T16:00:00-05:00');
    const preview = await previewPush(prisma, {
      businessId,
      providerId: danaId,
      day: DAY,
      fromAt: at('2026-06-09T14:00:00-05:00'),
      minutes: 60,
    });

    expect(preview.canPush).toBe(false);
    expect(preview.candidates[0]?.problem).toBe('past-closing');
    expect(preview.candidates[0]?.clientName).toBe('Ada Chen');
  });

  it('previews without moving anything', async () => {
    const appointment = await book('2026-06-09T14:00:00-05:00');
    await previewPush(prisma, { businessId, providerId: danaId, day: DAY, fromAt: at('2026-06-09T14:00:00-05:00'), minutes: 30 });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(hhmm(row.startAt)).toBe('14:00');
  });

  it('records the move on each appointment, with the reason', async () => {
    const appointment = await book('2026-06-09T14:00:00-05:00');
    await push(30);

    const event = await prisma.appointmentEvent.findFirstOrThrow({
      where: { appointmentId: appointment.id, type: 'column_pushed' },
    });
    expect(event.reason).toBe('Dana is an hour behind');
    expect((event.payload as { minutes: number }).minutes).toBe(30);
  });

  /** APPT-04's "running ~30 min behind" notice. A column that moved without
   *  anybody being told is the silent change Goal 2 forbids. */
  it('tells every client whose time changed', async () => {
    await book('2026-06-09T14:00:00-05:00');
    await book('2026-06-09T15:00:00-05:00');

    const result = await push(30);
    expect(result.notified).toBe(2);
    expect(await prisma.notificationOutbox.count({ where: { template: 'appointment.running_late' } })).toBe(2);
  });

  it('keeps the customer’s manage link working, re-pointed to the new time', async () => {
    const appointment = await book('2026-06-09T14:00:00-05:00');
    await push(30);

    const token = await prisma.manageToken.findFirstOrThrow({ where: { appointmentId: appointment.id } });
    const newEnd = at('2026-06-09T15:30:00-05:00');
    expect(token.expiresAt.toISOString()).toBe(after(newEnd, 24 * 60 * 60_000).toISOString());
    expect(token.revokedAt).toBeNull();
  });

  it('leaves a cancelled appointment where it is', async () => {
    const cancelled = await book('2026-06-09T14:00:00-05:00');
    await prisma.appointment.update({ where: { id: cancelled.id }, data: { status: 'cancelled' } });
    await book('2026-06-09T15:00:00-05:00');

    const result = await push(30);
    expect(result.moved).toBe(1);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: cancelled.id } });
    expect(hhmm(row.startAt)).toBe('14:00');
  });

  it('refuses a zero-minute push rather than writing a no-op event', async () => {
    await expect(push(0)).rejects.toBeInstanceOf(RangeError);
  });
});
