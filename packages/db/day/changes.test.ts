/**
 * A-150 (C9, D-73) — "what changed on my column today", against the real
 * writers. OQ-24 (a): moves, pushes, reassignments onto the column and
 * bookings into it count; status taps do not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { staffActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from '../booking';
import { rescheduleAppointment, transitionAppointment } from '../appointments';
import { loadDayView } from './day-view';
import { lastPrintedByProvider, recordSheetPrint } from './changes';
import { findRunningLate, setRunningLate } from './running-late';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const SAM = staffActor('staff-1');
const JO = staffActor('staff-2');

const at = (iso: string) => toDate(instantFromIso(iso));
const DAY = '2026-06-09'; // Tuesday
// Every writer below stamps its event with the DATABASE clock, which is later
// than this — so everything written in a test counts as "today" unless a test
// says otherwise by writing its own `createdAt`.
const NOW = at('2026-06-08T08:00:00-05:00');

let businessId: string;
let danaId: string;
let priyaId: string;
let serviceId: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  businessId = (
    await prisma.business.create({
      data: { name: 'Shear Genius', timezone: 'America/Chicago', slotIntervalMinutes: 15, minimumLeadMinutes: 0, bookingHorizonDays: 365 },
    })
  ).id;
  danaId = (await prisma.provider.create({ data: { businessId, displayName: 'Dana', displayOrder: 0 } })).id;
  priyaId = (await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } })).id;
  serviceId = (
    await prisma.service.create({
      data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500, bufferAfterMinutes: 15 },
    })
  ).id;
  await prisma.serviceProvider.createMany({
    data: [
      { businessId, serviceId, providerId: danaId },
      { businessId, serviceId, providerId: priyaId },
    ],
  });
  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);
  for (const providerId of [danaId, priyaId]) {
    await createWeeklyWindow(prisma, { businessId, providerId, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false }, STAMP);
  }
});

const book = (startAt: Date, providerId = danaId) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [serviceId],
    clientId: null,
    startAt,
    now: NOW,
    actor: SAM,
    audience: 'staff',
  } as Parameters<typeof bookAppointment>[1]);

const load = (now = NOW) => loadDayView(prisma, { businessId, day: DAY, now });
const column = (view: Awaited<ReturnType<typeof load>>, providerId: string) =>
  view.columns.find((c) => c.providerId === providerId)!;

describe('which events count (OQ-24 (a))', () => {
  it('a booking counts, and a status tap after it does not replace it', async () => {
    const booked = await book(at('2026-06-09T10:00:00-05:00'));
    await transitionAppointment(prisma, { businessId, appointmentId: booked.id, to: 'confirmed', actor: JO, now: NOW });

    const [appt] = column(await load(), danaId).appointments;
    expect(appt!.changes.map((c) => [c.type, c.actorRef])).toEqual([['booked', 'staff-1']]);
  });

  it('a move says where from', async () => {
    const booked = await book(at('2026-06-09T10:00:00-05:00'));
    await rescheduleAppointment(prisma, { businessId, appointmentId: booked.id, startAt: at('2026-06-09T14:00:00-05:00'), now: NOW, actor: JO });

    const [latest] = column(await load(), danaId).appointments[0]!.changes;
    expect(latest).toMatchObject({ type: 'rescheduled', actorRef: 'staff-2', fromProviderId: null });
    expect(latest!.fromStartAt).toEqual(at('2026-06-09T10:00:00-05:00'));
  });

  it('a move onto another column is ONE change carrying both sides, not two', async () => {
    // D-31 writes a `provider_changed` (viaReschedule) AND a `rescheduled` in
    // one transaction. Two changes would count one move twice since print.
    const booked = await book(at('2026-06-09T10:00:00-05:00'));
    await rescheduleAppointment(prisma, {
      businessId,
      appointmentId: booked.id,
      startAt: at('2026-06-09T11:00:00-05:00'),
      toProviderId: priyaId,
      now: NOW,
      actor: JO,
    });

    const view = await load();
    expect(column(view, danaId).appointments).toEqual([]);
    const changes = column(view, priyaId).appointments[0]!.changes;
    expect(changes.map((c) => c.type)).toEqual(['rescheduled', 'booked']);
    expect(changes[0]).toMatchObject({ fromProviderId: danaId });
    expect(changes[0]!.fromStartAt).toEqual(at('2026-06-09T10:00:00-05:00'));
  });
});

describe('the window: today, or since the paper if that is earlier', () => {
  // Hand-written rows so `createdAt` is frozen. The log is append-only by
  // trigger, and INSERT is the one thing it permits.
  const eventAt = (appointmentId: string, createdAt: Date) =>
    prisma.appointmentEvent.create({
      data: { businessId, appointmentId, type: 'column_pushed', actor: 'staff', actorRef: 'staff-2', createdAt, payload: { from: '2026-06-09T14:40:00.000Z', to: '2026-06-09T15:00:00.000Z', minutes: 20 } },
    });

  it('a change made before the salon’s today is not today’s news', async () => {
    const booked = await book(at('2026-06-09T10:00:00-05:00'));
    // The booking was stamped by the database clock, so read from a `now`
    // whose "today" starts after every row in this test.
    await eventAt(booked.id, at('2026-06-08T20:00:00-05:00'));
    const later = at('2099-01-01T08:00:00-06:00');
    expect(column(await load(later), danaId).appointments[0]!.changes).toEqual([]);
  });

  it('is widened back to the last print, so a change made after last night’s print still counts', async () => {
    // A range predicate needs a fixture where the two ends differ (A-100):
    // the print is the day BEFORE "today", and the push sits between them.
    const booked = await book(at('2026-06-09T10:00:00-05:00'));
    const todayMorning = at('2026-06-09T07:00:00-05:00');
    await prisma.daySheetPrint.create({
      data: { businessId, day: DAY, providerId: null, actor: 'staff', actorRef: 'staff-1', printedAt: at('2026-06-08T18:00:00-05:00') },
    });
    await eventAt(booked.id, at('2026-06-08T19:00:00-05:00'));

    const dana = column(await loadDayView(prisma, { businessId, day: DAY, now: todayMorning }), danaId);
    expect(dana.printedAt).toEqual(at('2026-06-08T18:00:00-05:00'));
    // The DB-clock `booked` row is newest; the hand-written push is behind it.
    expect(dana.appointments[0]!.changes.map((c) => c.type)).toEqual(['booked', 'column_pushed']);
    expect(dana.todayStart).toEqual(at('2026-06-09T00:00:00-05:00'));
  });
});

describe('the paper', () => {
  it('a column’s print is the LATER of the whole-salon sheet and her own', async () => {
    const base = { businessId, day: DAY, actor: SAM };
    await recordSheetPrint(prisma, { ...base, providerId: null, now: at('2026-06-09T08:45:00-05:00') });
    await recordSheetPrint(prisma, { ...base, providerId: danaId, now: at('2026-06-09T09:30:00-05:00') });
    // A different day's paper is not this day's.
    await recordSheetPrint(prisma, { ...base, day: '2026-06-10', providerId: priyaId, now: at('2026-06-09T10:00:00-05:00') });

    const printed = await lastPrintedByProvider(prisma, { businessId, day: DAY, providerIds: [danaId, priyaId] });
    expect(printed.get(danaId)).toEqual(at('2026-06-09T09:30:00-05:00'));
    expect(printed.get(priyaId)).toEqual(at('2026-06-09T08:45:00-05:00'));
  });

  it('never printed is absent, not a zero', async () => {
    expect((await lastPrintedByProvider(prisma, { businessId, day: DAY, providerIds: [danaId] })).size).toBe(0);
    expect(column(await load(), danaId).printedAt).toBeNull();
  });

  it('refuses another business’s provider (SEC-08)', async () => {
    const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });
    await expect(
      recordSheetPrint(prisma, { businessId: other.id, day: DAY, providerId: danaId, actor: SAM, now: NOW }),
    ).rejects.toThrow('not on this book');
    expect(await prisma.daySheetPrint.count()).toBe(0);
  });
});

describe('the running-late claim keeps its own author (D-73)', () => {
  it('a push rewrites the minutes, never who made the claim or when', async () => {
    const claimed = at('2026-06-09T10:12:00-05:00');
    await setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes: 40, actor: SAM, now: claimed });
    // What a push does (D-43): a smaller number, no instant.
    await setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes: 20, actor: JO, now: null, pushedOff: 20 });

    const [late] = await findRunningLate(prisma, { businessId, day: DAY });
    expect(late).toMatchObject({ minutes: 20, actorRef: 'staff-1', claimedAt: claimed });

    // A desk RE-claim is a new claim, and takes the new author.
    await setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes: 30, actor: JO, now: at('2026-06-09T11:00:00-05:00') });
    expect((await findRunningLate(prisma, { businessId, day: DAY }))[0]).toMatchObject({ actorRef: 'staff-2' });
  });

  it('the day view carries the claim', async () => {
    const claimed = at('2026-06-09T10:12:00-05:00');
    await setRunningLate(prisma, { businessId, providerId: danaId, day: DAY, minutes: 40, actor: SAM, now: claimed });
    expect(column(await load(), danaId).runningLateClaim).toEqual({ actor: 'staff', actorRef: 'staff-1', claimedAt: claimed });
  });
});
