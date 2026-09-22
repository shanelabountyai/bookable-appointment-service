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
import { previewPush, pushColumn } from './push-column';
import {
  clearRunningLate,
  findRunningLate,
  markToldAbout,
  setRunningLate,
  unmarkToldAbout,
} from './running-late';
import { loadDayView } from './day-view';
import { transitionAppointment } from '../appointments/transition';

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
    setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes, actor: ACTOR, now: at(`${DAY}T08:00:00-05:00`) });

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

  /**
   * D-26, decided at demo checkpoint 2: the push MOVES WHAT IT CAN and names
   * what it left. All-or-nothing capped the seeded Saturday's push at five
   * minutes while the stylist was 38 behind — one client at the end of the
   * day vetoing the whole operation.
   */
  it('moves what fits and leaves the one that would fall past closing', async () => {
    await book('2026-06-09T10:00:00-05:00');
    await book('2026-06-09T16:00:00-05:00'); // 16:00–17:00, ending at the close

    const result = await push(30, '2026-06-09T10:00:00-05:00');

    expect(result.moved).toBe(1);
    expect(result.leftBehind).toHaveLength(1);
    expect(result.leftBehind[0]?.problem).toBe('past-closing');

    const rows = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
    // The 10:00 moved; the 16:00 stayed exactly where its client expects it.
    expect(rows.map((r) => hhmm(r.startAt))).toEqual(['10:30', '16:00']);
  });

  /**
   * THE CASCADE. An appointment left behind still occupies its old time, so
   * anything that would shift onto it cannot move either. Without this the
   * partial push would hand the database a real overlap and the whole
   * transaction would fail at COMMIT — a worse outcome than moving less,
   * because the desk would see a total failure naming no pair.
   */
  it('leaves behind anything that would land on top of one that stays', async () => {
    await book('2026-06-09T15:00:00-05:00');
    await book('2026-06-09T16:00:00-05:00'); // cannot move: ends at the close

    const result = await push(30, '2026-06-09T15:00:00-05:00');

    expect(result.moved).toBe(0);
    expect(result.leftBehind.map((c) => c.problem).sort()).toEqual(['blocked-by-one-that-stays', 'past-closing']);

    const rows = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
    expect(rows.map((r) => hhmm(r.startAt))).toEqual(['15:00', '16:00']);
    // And the invariant still holds — nothing was written at all.
    expect(await prisma.appointmentEvent.count({ where: { type: 'column_pushed' } })).toBe(0);
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

    // Nothing left that CAN move, so there is no push to make — but the
    // client who is in the way is named either way.
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

/**
 * A-059 (APPT-03) — THE RING-ROUND THE DELTA IMPLIES.
 *
 * The delta tells nobody. Every one of these tests is about the list a human
 * then has to work down, and about the mark that stops the second person at
 * the desk ringing the first six again.
 */
describe('A-059 — who still has to be rung', () => {
  const setLate = (minutes: number) =>
    setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes, actor: ACTOR, now: at(`${DAY}T08:00:00-05:00`) });

  const callsAt = async (nowIso: string) => {
    const view = await loadDayView(prisma, { businessId, day: DAY, now: at(nowIso) });
    return view.columns.find((c) => c.providerId === danaId)!.lateCalls;
  };

  it('is empty while the column is on time — a list with no claim behind it is noise', async () => {
    await book('2026-06-09T14:00:00-05:00');
    expect(await callsAt('2026-06-09T13:00:00-05:00')).toEqual([]);
  });

  /** The whole item: the client is on her way to a time that is no longer
   *  true, and the projected start is what the desk says on the phone. */
  it('projects the delta onto the scheduled time without moving anything', async () => {
    await book('2026-06-09T14:00:00-05:00');
    await setLate(30);

    const [call] = await callsAt('2026-06-09T13:00:00-05:00');
    expect(hhmm(call!.scheduled)).toBe('14:00');
    expect(hhmm(call!.projected)).toBe('14:30');
    expect(call!.clientName).toBe('Ada Chen');
    expect(call!.clientPhone).toBe('+15125550101');

    // D-22 unchanged: the confirmation she is holding still says 14:00.
    const row = await prisma.appointment.findFirstOrThrow();
    expect(row.startWallTime.trim()).toBe('14:00');
  });

  /**
   * THE FILTER THAT MATTERS. Ringing a client who is sitting in the waiting
   * area to tell her the salon is running late is the salon announcing it does
   * not know who is in it — and she is the one person who can already see it.
   */
  it('leaves out everybody who is already in the building', async () => {
    const arriving = await book('2026-06-09T14:00:00-05:00');
    const here = await book('2026-06-09T15:00:00-05:00');
    await prisma.appointment.update({ where: { id: here.id }, data: { status: 'checked_in' } });
    await setLate(30);

    const calls = await callsAt('2026-06-09T13:00:00-05:00');
    expect(calls.map((c) => c.appointmentId)).toEqual([arriving.id]);
  });

  it('leaves out the cancelled, who have nothing to be told', async () => {
    await book('2026-06-09T14:00:00-05:00');
    const gone = await book('2026-06-09T15:00:00-05:00');
    await prisma.appointment.update({ where: { id: gone.id }, data: { status: 'cancelled' } });
    await setLate(30);

    expect((await callsAt('2026-06-09T13:00:00-05:00')).map((c) => hhmm(c.scheduled))).toEqual(['14:00']);
  });

  /** Three hours, not the rest of the day: by five o'clock the delta has been
   *  worked off or the column has been pushed, and a list of forty is a list
   *  of none. */
  it('stops at the horizon, and starts at now', async () => {
    await book('2026-06-09T10:00:00-05:00'); // already gone by
    await book('2026-06-09T14:00:00-05:00'); // inside
    await book('2026-06-09T16:00:00-05:00'); // exactly three hours out, so outside
    await setLate(30);

    expect((await callsAt('2026-06-09T13:00:00-05:00')).map((c) => hhmm(c.scheduled))).toEqual(['14:00']);
  });

  it('is ordered by the time they will arrive, because that is the order they get rung', async () => {
    await book('2026-06-09T15:00:00-05:00');
    await book('2026-06-09T13:00:00-05:00');
    await book('2026-06-09T14:00:00-05:00');
    await setLate(20);

    expect((await callsAt('2026-06-09T12:30:00-05:00')).map((c) => hhmm(c.scheduled))).toEqual([
      '13:00',
      '14:00',
      '15:00',
    ]);
  });
});

describe('A-059 — "I have already rung her"', () => {
  const setLate = (minutes: number) =>
    setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes, actor: ACTOR, now: at(`${DAY}T08:00:00-05:00`) });
  const mark = (appointmentId: string) =>
    markToldAbout(prisma, { businessId, providerId: danaId, day: DAY, appointmentId, actor: ACTOR });
  const callsAt = async (nowIso: string) => {
    const view = await loadDayView(prisma, { businessId, day: DAY, now: at(nowIso) });
    return view.columns.find((c) => c.providerId === danaId)!.lateCalls;
  };

  it('stamps who made the call and what they told her', async () => {
    const booked = await book('2026-06-09T14:00:00-05:00');
    await setLate(40);

    const told = await mark(booked.id);
    expect(told?.toldByActor).toBe('staff');
    expect(told?.actorRef).toBe('staff-1');
    // The NUMBER she was given, not the number now — this is what makes the
    // mark auditable rather than merely present.
    expect(told?.minutesToldAbout).toBe(40);

    const [call] = await callsAt('2026-06-09T13:00:00-05:00');
    expect(call!.told?.minutesToldAbout).toBe(40);
    expect(call!.stale).toBe(false);
  });

  /** SENDS NOTHING, and that is the decision. A queued message beside a
   *  client's name is read by staff as "no need to call her" (A-044). */
  it('queues no message and writes no outbox row', async () => {
    const booked = await book('2026-06-09T14:00:00-05:00');
    const before = await prisma.notificationOutbox.count();
    await setLate(40);
    await mark(booked.id);
    expect(await prisma.notificationOutbox.count()).toBe(before);
  });

  /** Two people at the desk, one client, the same second. */
  it('is one mark per client per delta however many times it is tapped', async () => {
    const booked = await book('2026-06-09T14:00:00-05:00');
    await setLate(40);
    await mark(booked.id);
    await mark(booked.id);
    expect(await prisma.runningLateTold.count()).toBe(1);
  });

  it('unticks, because a shared screen gets mis-tapped', async () => {
    const booked = await book('2026-06-09T14:00:00-05:00');
    await setLate(40);
    await mark(booked.id);
    await unmarkToldAbout(prisma, { businessId, providerId: danaId, day: DAY, appointmentId: booked.id });

    const [call] = await callsAt('2026-06-09T13:00:00-05:00');
    expect(call!.told).toBeNull();
  });

  /**
   * THE CASCADE IS THE FEATURE. "Cleared when the delta clears" is a foreign
   * key, not a cleanup job — so "back on time" cannot leave this morning's
   * ticks sitting under this afternoon's claim.
   */
  it('is deleted with the delta, so a new claim starts with nobody told', async () => {
    const booked = await book('2026-06-09T14:00:00-05:00');
    await setLate(40);
    await mark(booked.id);
    expect(await prisma.runningLateTold.count()).toBe(1);

    await clearRunningLate(prisma, { providerId: danaId, day: DAY });
    expect(await prisma.runningLateTold.count()).toBe(0);

    await setLate(25);
    const [call] = await callsAt('2026-06-09T13:00:00-05:00');
    expect(call!.told).toBeNull();
  });

  /**
   * She was told "about twenty" and Dana is now fifty behind. The tick stays —
   * somebody did ring her — but a screen that showed it plainly would be
   * telling the desk that a client who was promised twenty knows about fifty.
   */
  it('marks the call stale when the delta has moved on from what she was told', async () => {
    const booked = await book('2026-06-09T14:00:00-05:00');
    await setLate(20);
    await mark(booked.id);

    await setLate(50);
    const [call] = await callsAt('2026-06-09T13:00:00-05:00');
    expect(call!.told?.minutesToldAbout).toBe(20);
    expect(call!.stale).toBe(true);

    // Ringing her back re-stamps it: the useful fact is the most recent call.
    await mark(booked.id);
    const [again] = await callsAt('2026-06-09T13:00:00-05:00');
    expect(again!.told?.minutesToldAbout).toBe(50);
    expect(again!.stale).toBe(false);
  });

  /** A drift smaller than one slot interval is the salon fussing, not news. */
  it('does not call a five-minute revision stale', async () => {
    const booked = await book('2026-06-09T14:00:00-05:00');
    await setLate(20);
    await mark(booked.id);
    await setLate(25);

    expect((await callsAt('2026-06-09T13:00:00-05:00'))[0]!.stale).toBe(false);
  });

  it('refuses to mark against a column that is back on time', async () => {
    const booked = await book('2026-06-09T14:00:00-05:00');
    expect(await mark(booked.id)).toBeNull();
    expect(await prisma.runningLateTold.count()).toBe(0);
  });
});

/**
 * A-059's fold-in: the push has always accepted a NEGATIVE delta and nothing
 * ever said so. "She's caught up, pull it back twenty" is an instruction the
 * desk gives out loud, and it was a hidden feature with two sharp edges.
 */
describe('A-059 — pulling the column earlier', () => {
  it('moves the column back, and the whole column moves', async () => {
    await book('2026-06-09T14:00:00-05:00');
    await book('2026-06-09T15:00:00-05:00');

    const result = await pushColumn(prisma, {
      businessId,
      providerId: danaId,
      day: DAY,
      fromAt: at('2026-06-09T14:00:00-05:00'),
      minutes: -20,
      actor: ACTOR,
    });

    expect(result.moved).toBe(2);
    const rows = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
    expect(rows.map((r) => r.startWallTime.trim())).toEqual(['13:40', '14:40']);
  });

  /**
   * THE EDGE THE POSITIVE CASE NEVER HAD. The only bound checked was the
   * closing time a pull-forward moves AWAY from, so nothing stopped a -180
   * seating a client at 07:00 in a salon that opens at nine — and no database
   * constraint would have refused it, because nothing in the schema knows a
   * working window.
   */
  it('leaves behind the one that would start before she opens, and names it', async () => {
    await book('2026-06-09T09:30:00-05:00');
    await book('2026-06-09T14:00:00-05:00');

    const preview = await previewPush(prisma, {
      businessId,
      providerId: danaId,
      day: DAY,
      fromAt: at('2026-06-09T09:30:00-05:00'),
      minutes: -60,
    });

    // NAMED, not refused outright (D-26): the 14:00 still comes forward.
    expect(preview.candidates.map((c) => [hhmm(c.from), c.problem])).toEqual([
      ['09:30', 'before-opening'],
      ['14:00', undefined],
    ]);
    expect(preview.canPush).toBe(true);

    const result = await pushColumn(prisma, {
      businessId,
      providerId: danaId,
      day: DAY,
      fromAt: at('2026-06-09T09:30:00-05:00'),
      minutes: -60,
      actor: ACTOR,
    });
    expect(result.moved).toBe(1);
    const rows = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
    expect(rows.map((r) => r.startWallTime.trim())).toEqual(['09:30', '13:00']);
  });

  /**
   * "Running behind" on a message telling her to come in twenty minutes
   * EARLIER is the product lying to the client about what just happened to
   * her — and it is the sentence she reads.
   */
  it('sends a brought-forward message, not a running-behind one', async () => {
    await book('2026-06-09T14:00:00-05:00');
    await pushColumn(prisma, {
      businessId,
      providerId: danaId,
      day: DAY,
      fromAt: at('2026-06-09T14:00:00-05:00'),
      minutes: -20,
      actor: ACTOR,
    });

    const message = await prisma.notificationOutbox.findFirstOrThrow({
      where: { template: { startsWith: 'appointment.moved' } },
    });
    expect(message.template).toBe('appointment.moved_earlier');
    expect((message.payload as { minutesShifted: number }).minutesShifted).toBe(-20);
    expect(await prisma.notificationOutbox.count({ where: { template: 'appointment.running_late' } })).toBe(0);
  });

  it('still refuses zero, which is the one number that means nothing', async () => {
    await book('2026-06-09T14:00:00-05:00');
    await expect(
      pushColumn(prisma, {
        businessId,
        providerId: danaId,
        day: DAY,
        fromAt: at('2026-06-09T14:00:00-05:00'),
        minutes: 0,
        actor: ACTOR,
      }),
    ).rejects.toThrow(RangeError);
  });
});

/**
 * A-066 / D-43 — THE PUSH WORKS THE DELTA OFF.
 *
 * The seam between A-018's two halves, which were built in one item as
 * deliberately different mechanisms and never introduced to each other. The
 * defect these cover is not that either half is wrong on its own: it is that a
 * pushed column left "+40 min" standing, so every projected chip double-counted
 * a delay already applied to the time it was projecting from, the ring-round
 * listed clients to phone about it, and the engine kept refusing to sell a gap
 * that genuinely existed.
 */
describe('D-43 — a push and the delta it was called to work off', () => {
  const setLate = (minutes: number) =>
    setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes, actor: ACTOR, now: at(`${DAY}T08:00:00-05:00`) });
  const push = (minutes: number, fromIso = '2026-06-09T14:00:00-05:00') =>
    pushColumn(prisma, { businessId, providerId: danaId, day: DAY, fromAt: at(fromIso), minutes, actor: ACTOR });
  const deltaNow = async () => (await findRunningLate(prisma, { businessId, day: DAY }))[0]?.minutes ?? 0;

  /**
   * THE REGRESSION, in the operator's own scene: set +40, push +40, and nothing
   * anywhere may still be adding forty minutes to a column that has just been
   * made honest. `runningLateMinutes` is what the day chip's projection and
   * `lateCallList` are both gated on, so asserting it null is asserting both.
   */
  it('a clean push of the full delta leaves the column on time, and nothing projecting', async () => {
    const appointment = await book('2026-06-09T14:00:00-05:00');
    await setLate(40);

    const result = await push(40);
    expect(result.moved).toBe(1);
    expect(result.runningLateMinutes).toBe(40);
    expect(result.runningLateAfter).toBe(0);

    // The claim is GONE, not stored as a zero — "on time" is its absence.
    expect(await findRunningLate(prisma, { businessId, day: DAY })).toEqual([]);

    const view = await loadDayView(prisma, {
      businessId,
      day: DAY,
      now: at('2026-06-09T12:30:00-05:00'),
    });
    const column = view.columns.find((c) => c.providerId === danaId)!;
    expect(column.runningLateMinutes).toBeNull();
    expect(column.lateCalls).toEqual([]);
    // And the chip it would have projected from has actually moved.
    const moved = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(hhmm(moved.startAt)).toBe('14:40');
  });

  /** A push of 20 against a delta of 40 works off half the overrun. Clearing
   *  would be the system deciding the rest of the day is fixed. */
  it('a smaller push reduces rather than clears', async () => {
    await book('2026-06-09T14:00:00-05:00');
    await setLate(40);

    expect((await push(20)).runningLateAfter).toBe(20);
    expect(await deltaNow()).toBe(20);
  });

  /** Floored at zero, never negative: the row means "behind by", and a stored
   *  -20 would render as "+-20 min". */
  it('a push bigger than the delta floors at zero rather than going negative', async () => {
    await book('2026-06-09T14:00:00-05:00');
    await setLate(20);

    expect((await push(60)).runningLateAfter).toBe(0);
    expect(await findRunningLate(prisma, { businessId, day: DAY })).toEqual([]);
  });

  /**
   * THE PARTIAL ARM (D-43, amending nothing about D-26). The cascade propagates
   * BACKWARDS in time, so "some moved" does not mean "the front of the column
   * moved" — reducing here would strip the delta from the clients it is most
   * true of.
   */
  it('a partial push changes the delta by nothing, and says so', async () => {
    await book('2026-06-09T14:00:00-05:00');
    // Dana closes at 17:00, so a 16:00 hour-long cut cannot take a +30.
    await book('2026-06-09T16:00:00-05:00');
    await setLate(40);

    const result = await push(30);
    expect(result.moved).toBe(1);
    expect(result.leftBehind.map((c) => c.problem)).toEqual(['past-closing']);
    expect(result.runningLateMinutes).toBe(40);
    expect(result.runningLateAfter).toBe(40);
    expect(await deltaNow()).toBe(40);
  });

  /**
   * A-059's pull-forward. Reducing by a negative would RAISE a lateness claim
   * because the salon got ahead; clearing would be guessing "she has caught up
   * entirely" from a -20 nudge. The delta is somebody's claim (D-22).
   */
  it('a pull-forward never touches the delta', async () => {
    await book('2026-06-09T14:00:00-05:00');
    await setLate(40);

    const result = await push(-20);
    expect(result.moved).toBe(1);
    expect(result.runningLateAfter).toBe(40);
    expect(await deltaNow()).toBe(40);
  });

  /** A push that could move nothing at all changes nothing at all. */
  it('leaves the delta alone when nothing could move', async () => {
    await book('2026-06-09T16:00:00-05:00');
    await setLate(40);

    const result = await push(30, '2026-06-09T16:00:00-05:00');
    expect(result.moved).toBe(0);
    // The REPORTED number too, not only the stored one: the early return when
    // nothing can move would otherwise let a wrong rule through unnoticed.
    expect(result.runningLateAfter).toBe(40);
    expect(await deltaNow()).toBe(40);
  });

  /**
   * D-41's marks are never deleted by a reduction — the desk DID make those
   * calls. They go stale by A-059's existing rule, for free, because staleness
   * is derived from the delta rather than stored.
   */
  it('keeps the "told her" marks through a reduction, and lets them go stale', async () => {
    const appointment = await book('2026-06-09T15:00:00-05:00');
    await setLate(40);
    await markToldAbout(prisma, { businessId, providerId: danaId, day: DAY, appointmentId: appointment.id, actor: ACTOR });

    await push(20);

    const view = await loadDayView(prisma, { businessId, day: DAY, now: at('2026-06-09T14:00:00-05:00') });
    const call = view.columns.find((c) => c.providerId === danaId)!.lateCalls[0]!;
    expect(call.told?.minutesToldAbout).toBe(40);
    // She was told 40; the column now claims 20. The tick stays and is flagged.
    expect(call.stale).toBe(true);
  });

  /** The preview states the outcome, from the same function the push runs —
   *  "moves 1, Dana then shows 0 behind", before anybody commits. */
  it('the preview says what the delta will be, on both arms', async () => {
    await book('2026-06-09T14:00:00-05:00');
    await setLate(40);

    const clean = await previewPush(prisma, { businessId, providerId: danaId, day: DAY, fromAt: at('2026-06-09T14:00:00-05:00'), minutes: 15 });
    expect(clean.runningLateMinutes).toBe(40);
    expect(clean.runningLateAfter).toBe(25);

    // The same delta, the same column — and a 16:00 hour-long cut against a
    // 17:00 close turns any positive push into a partial one.
    await book('2026-06-09T16:00:00-05:00');
    const partial = await previewPush(prisma, { businessId, providerId: danaId, day: DAY, fromAt: at('2026-06-09T14:00:00-05:00'), minutes: 30 });
    expect(partial.runningLateAfter).toBe(40);
  });
});

/**
 * A-130 / D-62 — EACH CLIENT'S OWN DELAY, NOT THE COLUMN'S.
 *
 * Every fixture above is back to back, and a back-to-back column cannot tell
 * a flat projection from a cascade. These put a HOLE in the column.
 */
describe('D-62 — a cancellation in a late column absorbs the delay', () => {
  const NOW = '2026-06-09T13:31:00-05:00';
  const setLate = (minutes: number) =>
    setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes, actor: ACTOR, now: at(`${DAY}T13:30:00-05:00`) });
  const mark = (appointmentId: string, minutes?: number) =>
    markToldAbout(prisma, { businessId, providerId: danaId, day: DAY, appointmentId, actor: ACTOR, ...(minutes === undefined ? {} : { minutes }) });
  const callsAt = async () => {
    const view = await loadDayView(prisma, { businessId, day: DAY, now: at(NOW) });
    return view.columns.find((c) => c.providerId === danaId)!.lateCalls;
  };
  const setStatus = (id: string, status: 'in_progress' | 'cancelled') =>
    prisma.appointment.update({ where: { id }, data: { status } });

  /** 13:00 in the chair, then 14:00, 15:00, 16:00 — hour-long cuts. */
  const column = async () => {
    const chair = await book('2026-06-09T13:00:00-05:00');
    const two = await book('2026-06-09T14:00:00-05:00');
    const three = await book('2026-06-09T15:00:00-05:00');
    const four = await book('2026-06-09T16:00:00-05:00');
    await setStatus(chair.id, 'in_progress');
    return { two, three, four };
  };

  it('the backlog measurement: the 14:00 cancels, the 15:00 and 16:00 are on time and ring back', async () => {
    const { two, three, four } = await column();
    await setLate(40);
    await mark(three.id);
    await mark(four.id);
    await setStatus(two.id, 'cancelled');

    const calls = await callsAt();
    // Out of the chair at 14:40; the 15:00 is seen on time, and so is the 16:00.
    expect(calls.map((c) => [hhmm(c.scheduled), hhmm(c.projected), c.lateMinutes, c.onTime, c.stale])).toEqual([
      ['15:00', '15:00', 0, true, true],
      ['16:00', '16:00', 0, true, true],
    ]);
  });

  it('an on-time client nobody rang is not on the ring-round at all', async () => {
    const { two } = await column();
    await setLate(40);
    await setStatus(two.id, 'cancelled');
    expect(await callsAt()).toEqual([]);
  });

  it('a hole shorter than the delay absorbs PART of it — the next two are late by the rest', async () => {
    const { two } = await column();
    await setLate(90);
    await setStatus(two.id, 'cancelled');

    // Chair out at 15:30: the 15:00 is 30 late, not 90, and pushes the 16:00 by the same.
    const calls = await callsAt();
    expect(calls.map((c) => [hhmm(c.scheduled), hhmm(c.projected), c.lateMinutes])).toEqual([
      ['15:00', '15:30', 30],
      ['16:00', '16:30', 30],
    ]);
  });

  it('a hole AFTER the next client leaves her fully late, and absorbs only behind it', async () => {
    const { two, three } = await column();
    await setLate(40);
    await setStatus(three.id, 'cancelled');

    const calls = await callsAt();
    expect(calls.map((c) => [hhmm(c.scheduled), hhmm(c.projected), c.lateMinutes])).toEqual([
      ['14:00', '14:40', 40],
    ]);
    expect(calls[0]!.appointmentId).toBe(two.id);
  });

  it('records HER delay when she is rung, so a partly-absorbed call is not stale on arrival', async () => {
    const { two, three } = await column();
    await setLate(90);
    await setStatus(two.id, 'cancelled');

    // The row read 30; the desk said 30.
    expect((await mark(three.id, 30))?.minutesToldAbout).toBe(30);
    expect((await callsAt())[0]!.stale).toBe(false);
    // Clamped to the claim: a form cannot record a bigger delay than anybody set.
    expect((await mark(three.id, 500))?.minutesToldAbout).toBe(90);
  });
});

/**
 * A-132 / D-63(1) — THE HEAD IS THE CLIENT IN THE CHAIR.
 *
 * Every D-62 fixture above freezes `now` at 13:31, before the chair's booked
 * end, and so passes against the bug: the chain dropped the client in the
 * chair the minute her BOOKED envelope ended, and the next member inherited
 * the whole delta back. These evaluate the same column at several instants.
 */
describe('D-63 — the cascade keeps its head until the chair is empty', () => {
  const t = (hhmmLocal: string) => at(`${DAY}T${hhmmLocal}:00-05:00`);
  const setLate = (minutes: number, claimed: string) =>
    setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes, actor: ACTOR, now: t(claimed) });
  const setStatus = (id: string, status: 'in_progress' | 'checked_in' | 'cancelled' | 'no_show') =>
    prisma.appointment.update({ where: { id }, data: { status } });
  /** Every live appointment's own delay, by booked start, at `now`. */
  const delaysAt = async (now: string) => {
    const view = await loadDayView(prisma, { businessId, day: DAY, now: t(now) });
    const column = view.columns.find((c) => c.providerId === danaId)!;
    return Object.fromEntries(
      column.appointments.filter((a) => a.status === 'booked').map((a) => [hhmm(a.startAt), a.lateMinutes]),
    );
  };

  /** 13:00 in the chair, then 14:00, 15:00, 16:00 — hour-long cuts. */
  const column = async () => {
    const chair = await book(`${DAY}T13:00:00-05:00`);
    const two = await book(`${DAY}T14:00:00-05:00`);
    await book(`${DAY}T15:00:00-05:00`);
    await book(`${DAY}T16:00:00-05:00`);
    await setStatus(chair.id, 'in_progress');
    return { chair, two };
  };

  it('the backlog measurement: nobody moves between 13:31, past the chair’s booked end, and after checkout', async () => {
    const { chair, two } = await column();
    await setLate(40, '13:30');
    await setStatus(two.id, 'cancelled');

    const expected = { '15:00': 0, '16:00': 0 };
    expect(await delaysAt('13:31')).toEqual(expected);
    // Her booked envelope ended at 14:00 and she is still in the chair.
    expect(await delaysAt('14:05')).toEqual(expected);
    expect(await delaysAt('14:30')).toEqual(expected);

    // Checked out at 14:36 by the real path, which stamps `endedAt`.
    await transitionAppointment(prisma, { appointmentId: chair.id, to: 'completed', actor: ACTOR, now: t('14:36') });
    expect(await delaysAt('14:36')).toEqual(expected);
    expect(await delaysAt('14:50')).toEqual(expected);
  });

  it('the calls list agrees with the chips after the chair’s booked end', async () => {
    const { two } = await column();
    await setLate(40, '13:30');
    await setStatus(two.id, 'cancelled');
    const view = await loadDayView(prisma, { businessId, day: DAY, now: t('14:05') });
    expect(view.columns.find((c) => c.providerId === danaId)!.lateCalls).toEqual([]);
  });

  it('with no hole, the next client is still fully late after the chair’s booked end', async () => {
    await column();
    await setLate(40, '13:30');
    expect(await delaysAt('14:05')).toEqual({ '14:00': 40, '15:00': 40, '16:00': 40 });
  });

  it('a checked-in client past her start heads the chain the same as one in progress', async () => {
    const { chair, two } = await column();
    await setStatus(chair.id, 'checked_in');
    await setLate(40, '13:30');
    await setStatus(two.id, 'cancelled');
    expect(await delaysAt('14:05')).toEqual({ '15:00': 0, '16:00': 0 });
  });

  it('a no-show marked after her start is a hole the delay drains into — released or not', async () => {
    const { two } = await column();
    await setLate(40, '13:30');
    await setStatus(two.id, 'no_show');
    // Chair out at 14:40; the 15:00 is seen on time.
    expect(await delaysAt('14:10')).toEqual({ '15:00': 0, '16:00': 0 });

    await prisma.appointment.update({ where: { id: two.id }, data: { releasedAt: t('14:10') } });
    expect(await delaysAt('14:10')).toEqual({ '15:00': 0, '16:00': 0 });
  });

  it('a claim made with an EMPTY chair still lands whole on the next client', async () => {
    const { chair } = await column();
    // Checked out at 13:50, and THEN the desk says Dana is 30 behind.
    await transitionAppointment(prisma, { appointmentId: chair.id, to: 'completed', actor: ACTOR, now: t('13:50') });
    await setLate(30, '13:55');
    expect(await delaysAt('13:56')).toEqual({ '14:00': 30, '15:00': 30, '16:00': 30 });
  });

  it('a checkout AFTER the claim frees the chair from that moment — an early one included', async () => {
    const { chair } = await column();
    await setLate(40, '13:30');
    await transitionAppointment(prisma, { appointmentId: chair.id, to: 'completed', actor: ACTOR, now: t('13:50') });
    // Out ten minutes early: the 14:00 is on time, and so is everybody after.
    expect(await delaysAt('13:51')).toEqual({ '14:00': 0, '15:00': 0, '16:00': 0 });
  });

  it('a checkout after the claim but past the next start leaves her late by exactly the overrun', async () => {
    const { chair } = await column();
    await setLate(40, '13:30');
    await transitionAppointment(prisma, { appointmentId: chair.id, to: 'completed', actor: ACTOR, now: t('14:25') });
    // The 14:00 starts at 14:25, which pushes the 15:00 by 25 as well.
    expect(await delaysAt('14:25')).toEqual({ '14:00': 25, '15:00': 25, '16:00': 25 });
  });

  it('a forgotten un-started 11:00 does not seed the chain', async () => {
    await book(`${DAY}T11:00:00-05:00`);
    await column();
    await setLate(40, '13:30');
    expect(await delaysAt('14:05')).toEqual({ '11:00': 0, '14:00': 40, '15:00': 40, '16:00': 40 });
  });

  it('a forgotten IN-PROGRESS 11:00 does not head the chain — the latest client in the chair does', async () => {
    const forgotten = await book(`${DAY}T11:00:00-05:00`);
    await setStatus(forgotten.id, 'in_progress');
    await column();
    await setLate(40, '13:30');
    // Were the 11:00 the head it would end at 12:40, the 13:00 would read on
    // time behind it, and the whole afternoon would read on time with it.
    expect(await delaysAt('14:05')).toEqual({ '14:00': 40, '15:00': 40, '16:00': 40 });
  });
});

/**
 * A-133 / D-63(2) — A PARTIAL PUSH LEAVES THE CHAIR AS LATE AS IT WAS.
 *
 * D-43 takes the pushed minutes off the delta and the push never moves the
 * client in the chair. Every push fixture above is a full push or pre-dates
 * the cascade, and both pass against the head carrying the REDUCED delta.
 */
describe('D-63(2) — the head carries the minutes a push took off', () => {
  const t = (hhmmLocal: string) => at(`${DAY}T${hhmmLocal}:00-05:00`);
  const setLate = (minutes: number) =>
    setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes, actor: ACTOR, now: t('13:30') });
  const push = (minutes: number) =>
    pushColumn(prisma, { businessId, providerId: danaId, day: DAY, fromAt: t('14:00'), minutes, actor: ACTOR, reason: 'Dana is behind' });
  const viewAt = async (now: string) =>
    (await loadDayView(prisma, { businessId, day: DAY, now: t(now) })).columns.find((c) => c.providerId === danaId)!;
  /** Every booked appointment's own delay, by its (post-push) start. */
  const delaysAt = async (now: string) =>
    Object.fromEntries(
      (await viewAt(now)).appointments.filter((a) => a.status === 'booked').map((a) => [hhmm(a.startAt), a.lateMinutes]),
    );
  /** 13:00 in the chair, then the given hour-long cuts. */
  const column = async (...starts: string[]) => {
    const chair = await book(`${DAY}T13:00:00-05:00`);
    for (const s of starts) await book(`${DAY}T${s}:00-05:00`);
    await prisma.appointment.update({ where: { id: chair.id }, data: { status: 'in_progress' } });
  };

  it('+20 of 45 with holes: the chair is still out at 14:45, so both pushed clients are 10 late', async () => {
    await column('14:15', '15:15');
    await setLate(45);
    await push(20);

    const [row] = await findRunningLate(prisma, { businessId, day: DAY });
    expect([row!.minutes, row!.pushedOffMinutes]).toEqual([25, 20]);
    // Chair out at 14:45. Carrying 25 it would be out at 14:25 and both read 0.
    expect(await delaysAt('13:31')).toEqual({ '14:35': 10, '15:35': 10 });
    expect((await viewAt('13:31')).lateCalls.map((c) => [hhmm(c.scheduled), hhmm(c.projected), c.lateMinutes, c.onTime])).toEqual([
      ['14:35', '14:45', 10, false],
      ['15:35', '15:45', 10, false],
    ]);
  });

  it('the default +15 of 40, back to back: pushed clients are late by the whole reduced delta', async () => {
    await column('14:00', '15:00');
    await setLate(40);
    await push(15);
    // Chair out at 14:40: the 14:15 starts 25 late and carries it on.
    expect(await delaysAt('13:31')).toEqual({ '14:15': 25, '15:15': 25 });
  });

  it('two pushes add up, and a desk re-claim keeps the count', async () => {
    await column('14:00', '15:00');
    await setLate(40);
    await push(10);
    await push(10);
    expect((await findRunningLate(prisma, { businessId, day: DAY }))[0]!.pushedOffMinutes).toBe(20);
    expect(await delaysAt('13:31')).toEqual({ '14:20': 20, '15:20': 20 });

    await setLate(30);
    expect((await findRunningLate(prisma, { businessId, day: DAY }))[0]!.pushedOffMinutes).toBe(20);
  });

  it('a full push clears the claim and projects nothing', async () => {
    await column('14:00', '15:00');
    await setLate(40);
    await push(40);
    expect(await findRunningLate(prisma, { businessId, day: DAY })).toEqual([]);
    expect(await delaysAt('13:31')).toEqual({ '14:40': 0, '15:40': 0 });
    expect((await viewAt('13:31')).lateCalls).toEqual([]);
  });

  it('clearing and re-claiming starts the count again', async () => {
    await column('14:00', '15:00');
    await setLate(40);
    await push(20);
    await clearRunningLate(prisma, { providerId: danaId, day: DAY });
    await setLate(10);
    expect((await findRunningLate(prisma, { businessId, day: DAY }))[0]!.pushedOffMinutes).toBe(0);
  });
});

/**
 * A-134 — A CLIENT IN A COLOUR'S PROCESSING GAP WAITS ON THE APPLICATION ONLY.
 *
 * The backlog measurement: Colour 13:15 in the chair (worked 13:05–14:00 and
 * 14:40–15:35), a trim at 14:15 in its gap, a Cut at 15:45. The chain was
 * envelopes, so the colour was one solid block and the trim inherited its
 * whole delay. Every non-segmented fixture above passes against that bug.
 */
describe('A-134 — the cascade chains worked blocks, not envelopes', () => {
  const t = (hhmmLocal: string) => at(`${DAY}T${hhmmLocal}:00-05:00`);
  const setLate = (minutes: number) =>
    setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes, actor: ACTOR, now: t('13:30') });
  const viewAt = async () =>
    (await loadDayView(prisma, { businessId, day: DAY, now: t('13:31') })).columns.find((c) => c.providerId === danaId)!;
  const delays = async () =>
    Object.fromEntries(
      (await viewAt()).appointments.filter((a) => a.status === 'booked').map((a) => [hhmm(a.startAt), a.lateMinutes]),
    );

  let colourId: string;
  beforeEach(async () => {
    const service = async (name: string, durationMinutes: number, buffers: [number, number]) => {
      const s = await prisma.service.create({
        data: { businessId, name, durationMinutes, bufferBeforeMinutes: buffers[0], bufferAfterMinutes: buffers[1], priceCents: 9000 },
      });
      await prisma.serviceProvider.create({ data: { businessId, serviceId: s.id, providerId: danaId } });
      return s.id;
    };
    colourId = await service('Colour', 130, [10, 10]);
    await prisma.serviceSegment.createMany({
      data: [45, 40, 45].map((durationMinutes, ordinal) => ({ businessId, serviceId: colourId, ordinal, durationMinutes, isGap: ordinal === 1 })),
    });
    const trimId = await service('Fringe trim', 20, [0, 0]);

    const colour = await book(`${DAY}T13:15:00-05:00`, { serviceIds: [colourId] });
    await prisma.appointment.update({ where: { id: colour.id }, data: { status: 'in_progress' } });
    await book(`${DAY}T14:15:00-05:00`, { serviceIds: [trimId] });
    await book(`${DAY}T15:45:00-05:00`);
  });

  it('is the fixture it claims to be — the trim sits in the colour’s processing gap', async () => {
    const colour = (await viewAt()).appointments.find((a) => hhmm(a.startAt) === '13:15')!;
    const blocks = await prisma.appointmentBlock.findMany({ where: { appointmentId: colour.id }, orderBy: { ordinal: 'asc' } });
    expect(blocks.map((b) => [hhmm(b.blockedStart), hhmm(b.blockedEnd)])).toEqual([
      ['13:05', '14:00'],
      ['14:40', '15:35'],
    ]);
  });

  it('a delta smaller than what is left of the application: the trim is on time and nobody rings her', async () => {
    await setLate(15);
    // Application out at 14:15; the rinse at 15:50 still holds up the Cut.
    expect(await delays()).toEqual({ '14:15': 0, '15:45': 5 });
    expect((await viewAt()).lateCalls.map((c) => [hhmm(c.scheduled), hhmm(c.projected), c.lateMinutes])).toEqual([
      ['15:45', '15:50', 5],
    ]);
  });

  it('a delta larger than that: the trim is late by the remainder only', async () => {
    await setLate(40);
    // Application out at 14:40, not the colour's +40 onto 14:55.
    expect(await delays()).toEqual({ '14:15': 25, '15:45': 30 });
    expect((await viewAt()).lateCalls.map((c) => [hhmm(c.scheduled), hhmm(c.projected), c.lateMinutes])).toEqual([
      ['14:15', '14:40', 25],
      ['15:45', '16:15', 30],
    ]);
  });
});
