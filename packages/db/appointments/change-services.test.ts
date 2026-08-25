/**
 * A-055 — changing what an appointment is FOR, against a real database
 * (VISIT-01, D-6, D-18, D-23).
 *
 * The operator's sentence is the specification: *"the one thing a booked
 * appointment cannot do in this system is become a different appointment."*
 *
 * The assertions that matter are the ones that would still pass if this were
 * written as cancel-and-rebook — "she is now booked for a cut and a colour" is
 * true either way. So the tests below pin what only a same-row UPDATE gives:
 * the id survives, the manage link survives, one row exists throughout, the
 * history is continuous, and **nothing anywhere is ever `cancelled_late`.**
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromDate, instant, instantFromIso, toDate } from '../../core/time';
import { staffActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { NoResourceFree, SlotNotOffered, SlotTaken, bookAppointment } from '../booking';
import { issueManageToken, verifyManageToken } from './manage-token';
import { transitionAppointment } from './transition';
import { VisitNotEditable, changeVisitServices } from './change-services';

const prisma = new PrismaClient();
const STAFF_WINDOW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const STAFF = staffActor('staff-1');

const at = (iso: string) => toDate(instantFromIso(iso));
const after = (base: Date, ms: number) => toDate(instant(fromDate(base) + ms));

// Tuesday 9 June 2026, Chicago. Business 09:00–18:00, Dana 09:00–17:00.
const TEN_AM = at('2026-06-09T10:00:00-05:00');
const NOW = at('2026-06-08T08:00:00-05:00');

let businessId: string;
let providerId: string;
let cutId: string;
let colourId: string;
let trimId: string;
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

  // UNEQUAL BUFFERS on purpose (CLAUDE.md): equal ones hide whose-buffer bugs,
  // and this item's whole arithmetic is "the first line's before, the last
  // line's after".
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
  trimId = (
    await prisma.service.create({
      data: {
        businessId,
        name: 'Fringe trim',
        durationMinutes: 15,
        priceCents: 1500,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 5,
      },
    })
  ).id;
  await prisma.serviceProvider.createMany({
    data: [cutId, colourId, trimId].map((serviceId) => ({ businessId, serviceId, providerId })),
  });

  clientId = (
    await prisma.client.create({
      data: { businessId, name: 'Ada Chen', phone: '5125550101', email: 'ada@example.test' },
    })
  ).id;

  await createWeeklyWindow(
    prisma,
    { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
    STAFF_WINDOW,
  );
  await createWeeklyWindow(
    prisma,
    { businessId, providerId, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
    STAFF_WINDOW,
  );
});

const book = (serviceIds: string[] = [cutId], over: Record<string, unknown> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds,
    clientId,
    startAt: TEN_AM,
    now: NOW,
    actor: STAFF,
    audience: 'staff',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

const change = (id: string, serviceIds: string[], over: Record<string, unknown> = {}) =>
  changeVisitServices(prisma, {
    appointmentId: id,
    serviceIds,
    now: NOW,
    actor: STAFF,
    audience: 'staff',
    ...over,
  } as Parameters<typeof changeVisitServices>[1]);

const linesOf = (id: string) =>
  prisma.appointmentServiceLine.findMany({ where: { appointmentId: id }, orderBy: { ordinal: 'asc' } });

describe('the add-on at the chair (VISIT-01)', () => {
  it('adds a service to a booked appointment, keeping the same row', async () => {
    const appointment = await book();
    const changed = await change(appointment.id, [cutId, colourId]);

    expect(changed.id).toBe(appointment.id);
    expect(changed.added).toEqual(['Colour']);
    expect(changed.removed).toEqual([]);
    // 60 + 90.
    expect(changed.durationMinutes).toBe(150);
    expect(changed.totalPriceCents).toBe(17500);
    expect(await prisma.appointment.count()).toBe(1);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.startAt.getTime()).toBe(TEN_AM.getTime());
    expect(row.endAt.getTime()).toBe(after(TEN_AM, 150 * 60_000).getTime());
    // VISIT-01: the FIRST line's before and the LAST line's after — never
    // summed, never the max.
    expect(row.bufferBeforeMinutes).toBe(5);
    expect(row.bufferAfterMinutes).toBe(20);
  });

  /** THE WHOLE POINT OF THE ITEM. Every workaround the desk had wrote one of
   *  these, on a client who did nothing wrong. */
  it('never writes a cancellation of any kind', async () => {
    const appointment = await book();
    await change(appointment.id, [cutId, colourId]);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.status).toBe('booked');
    expect(await prisma.appointment.count({ where: { status: { in: ['cancelled', 'cancelled_late'] } } })).toBe(0);
    const templates = (await prisma.notificationOutbox.findMany({ select: { template: true } })).map((r) => r.template);
    expect(templates).not.toContain('appointment.cancelled');
    expect(templates).toContain('appointment.services_changed');
  });

  /** She is already in the chair — the reason `SERVICE_EDITABLE_STATUSES` is
   *  its own list rather than `canReschedule`'s, which refuses this. */
  it('works on an appointment that is already in progress', async () => {
    const appointment = await book();
    for (const to of ['confirmed', 'checked_in', 'in_progress'] as const) {
      await transitionAppointment(prisma, { appointmentId: appointment.id, to, actor: STAFF, now: NOW });
    }

    const changed = await change(appointment.id, [cutId, colourId]);
    expect(changed.durationMinutes).toBe(150);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).status).toBe('in_progress');
  });

  it('refuses to change a finished or cancelled visit', async () => {
    const done = await book();
    for (const to of ['confirmed', 'checked_in', 'in_progress', 'completed'] as const) {
      await transitionAppointment(prisma, { appointmentId: done.id, to, actor: STAFF, now: NOW });
    }
    await expect(change(done.id, [cutId, colourId])).rejects.toBeInstanceOf(VisitNotEditable);
  });

  it('is refused when the stylist cannot do the added service', async () => {
    const appointment = await book();
    await prisma.serviceProvider.deleteMany({ where: { providerId, serviceId: colourId } });
    await expect(change(appointment.id, [cutId, colourId])).rejects.toThrow(/not qualified/);
  });

  it('refuses a change that changes nothing', async () => {
    const appointment = await book();
    await expect(change(appointment.id, [cutId])).rejects.toThrow(/already booked for/);
  });

  it('refuses an empty visit', async () => {
    const appointment = await book();
    await expect(change(appointment.id, [])).rejects.toThrow(/at least one service/);
  });
});

describe('D-18 — a line already agreed keeps its price', () => {
  /** Re-pricing the cut she booked in January because she added a colour in
   *  August is D-18's defect arriving through a door D-18 never imagined. */
  it('keeps the ORIGINAL price of a kept line and takes today for the new one', async () => {
    const appointment = await book();
    await prisma.service.update({ where: { id: cutId }, data: { priceCents: 9900, durationMinutes: 75 } });

    const changed = await change(appointment.id, [cutId, colourId]);

    const lines = await linesOf(appointment.id);
    expect(lines[0]!.serviceId).toBe(cutId);
    expect(lines[0]!.priceCents).toBe(5500); // what she agreed to
    expect(lines[0]!.durationMinutes).toBe(60); // ditto
    expect(lines[1]!.priceCents).toBe(12000); // today's colour
    expect(changed.durationMinutes).toBe(150);
  });

  it('takes today for a service re-added after being dropped', async () => {
    const appointment = await book([cutId, colourId]);
    await change(appointment.id, [cutId]); // she drops the colour
    await prisma.service.update({ where: { id: colourId }, data: { priceCents: 13500 } });

    await change(appointment.id, [cutId, colourId]); // ...and changes her mind

    const lines = await linesOf(appointment.id);
    expect(lines.find((l) => l.serviceId === colourId)!.priceCents).toBe(13500);
    expect(lines.find((l) => l.serviceId === cutId)!.priceCents).toBe(5500);
  });
});

describe('shortening a visit', () => {
  it('releases the tail and reports the minutes freed', async () => {
    const appointment = await book([cutId, colourId]);
    const changed = await change(appointment.id, [cutId]);

    expect(changed.removed).toEqual(['Colour']);
    expect(changed.durationMinutes).toBe(60);
    expect(changed.freedMinutes).toBe(90);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.endAt.getTime()).toBe(after(TEN_AM, 60 * 60_000).getTime());
    // The envelope shrank with it — the constraint ranges over this, so a
    // stale one would keep refusing bookings into time nobody is using.
    expect(row.blockedEnd.getTime()).toBe(after(TEN_AM, 75 * 60_000).getTime());
  });

  /** A shortened visit must not be re-checked against the engine at all: it
   *  releases time, and refusing it because the day's hours changed underneath
   *  the booking is A-047's problem, not this one's. */
  it('is allowed even when the engine would no longer offer the start', async () => {
    const appointment = await book([cutId, colourId]);
    await prisma.weeklyWindow.deleteMany({ where: { providerId } });

    const changed = await change(appointment.id, [cutId]);
    expect(changed.durationMinutes).toBe(60);
  });
});

describe('the engine and the constraint still decide', () => {
  it('refuses a lengthened visit that runs into the next client', async () => {
    const appointment = await book(); // 10:00–11:00, buffer to 11:15
    await bookAppointment(prisma, {
      businessId,
      providerId,
      serviceIds: [trimId],
      clientId: null,
      startAt: at('2026-06-09T11:30:00-05:00'),
      now: NOW,
      actor: STAFF,
      audience: 'staff',
    });

    // Cut + colour would run to 12:30 and straight through her.
    await expect(change(appointment.id, [cutId, colourId])).rejects.toBeInstanceOf(SlotTaken);

    // And she still has exactly what she had.
    const lines = await linesOf(appointment.id);
    expect(lines).toHaveLength(1);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).endAt.getTime()).toBe(
      after(TEN_AM, 60 * 60_000).getTime(),
    );
  });

  it('refuses a lengthened visit that would run past closing', async () => {
    const late = await book([cutId], { startAt: at('2026-06-09T15:30:00-05:00') });
    // 15:30 + 150 minutes = 18:00, past Dana's 17:00.
    await expect(change(late.id, [cutId, colourId])).rejects.toBeInstanceOf(SlotNotOffered);
  });

  /** BOOK-05's door: the desk decides to stay late, knowingly. */
  it('lets an override lengthen past closing', async () => {
    const late = await book([cutId], { startAt: at('2026-06-09T15:30:00-05:00') });
    const changed = await change(late.id, [cutId, colourId], {
      isOverride: true,
      overrideReason: 'Wedding party, agreed with Dana',
    });
    expect(changed.durationMinutes).toBe(150);
  });

  /**
   * The ROOM axis, isolated from the provider axis — which needs a SECOND
   * stylist holding the only chair, or the collision would be Dana's own
   * column and the error would be `SlotTaken` for the wrong reason.
   */
  it('refuses when the room has no chair for the longer envelope', async () => {
    const type = await prisma.resourceType.create({ data: { businessId, name: 'Chair' } });
    await prisma.resource.create({ data: { businessId, resourceTypeId: type.id, name: 'Chair 1' } });
    await prisma.service.updateMany({ where: { businessId }, data: { requiredResourceTypeId: type.id } });

    const priya = await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } });
    await prisma.serviceProvider.create({ data: { businessId, serviceId: trimId, providerId: priya.id } });
    await createWeeklyWindow(
      prisma,
      { businessId, providerId: priya.id, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
      STAFF_WINDOW,
    );

    const appointment = await book(); // Dana 10:00–11:00, holding the only chair to 11:15

    // Priya takes the only chair at 11:30 — the hold is trigger-written, so
    // this books it the way the salon would rather than fabricating a row.
    await bookAppointment(prisma, {
      businessId,
      providerId: priya.id,
      serviceIds: [trimId],
      clientId: null,
      startAt: at('2026-06-09T11:30:00-05:00'),
      now: NOW,
      actor: STAFF,
      audience: 'staff',
    });

    // Dana is free until 15:00 — it is the ROOM that cannot take a 150-minute
    // visit running to 12:50.
    await expect(change(appointment.id, [cutId, colourId])).rejects.toBeInstanceOf(NoResourceFree);
    expect(await linesOf(appointment.id)).toHaveLength(1);
  });
});

describe('what the change leaves behind', () => {
  it('keeps her manage link working, re-pointed to the new end', async () => {
    const appointment = await book();
    const { token } = await issueManageToken(prisma, {
      businessId,
      appointmentId: appointment.id,
      endAt: appointment.endAt,
      now: NOW,
    });

    await change(appointment.id, [cutId, colourId]);

    // The link she is holding still opens her appointment — TOKEN-02's
    // re-point, never a reissue.
    expect(await verifyManageToken(prisma, token, NOW)).toMatchObject({ appointmentId: appointment.id });
  });

  it('writes one continuous history rather than a new appointment', async () => {
    const appointment = await book();
    await change(appointment.id, [cutId, colourId]);

    const events = await prisma.appointmentEvent.findMany({
      where: { appointmentId: appointment.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual(['booked', 'services_changed']);

    const payload = events[1]!.payload as { added: string[]; removed: string[]; toEndAt: string };
    expect(payload.added).toEqual(['Colour']);
    expect(payload.removed).toEqual([]);
    expect(payload.toEndAt).toBe(after(TEN_AM, 150 * 60_000).toISOString());
    expect(events[1]!.actorRef).toBe('staff-1');
  });

  it('tells her once per resulting end time, not once per attempt', async () => {
    const appointment = await book();
    await change(appointment.id, [cutId, colourId]);
    await change(appointment.id, [cutId]);
    await change(appointment.id, [cutId, colourId]);

    const rows = await prisma.notificationOutbox.findMany({
      where: { template: 'appointment.services_changed' },
      select: { dedupeKey: true },
    });
    // Two distinct end times across three changes: the third returns to the
    // first's end and reuses its key (P1-7's shape).
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(2);
  });
});

describe('reordering', () => {
  /** Order is the appointment (VISIT-01): the buffers come from the ends, so
   *  "cut then colour" is a different appointment from "colour then cut". */
  it('recomposes the buffers when only the order changes', async () => {
    const appointment = await book([cutId, colourId]);
    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(before.bufferBeforeMinutes).toBe(5); // cut's before
    expect(before.bufferAfterMinutes).toBe(20); // colour's after

    await change(appointment.id, [colourId, cutId]);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.bufferBeforeMinutes).toBe(10); // colour's before
    expect(row.bufferAfterMinutes).toBe(15); // cut's after
    // Same length, same end — only the padding moved.
    expect(row.endAt.getTime()).toBe(before.endAt.getTime());

    const lines = await linesOf(appointment.id);
    expect(lines.map((l) => l.serviceId)).toEqual([colourId, cutId]);
    expect(lines.map((l) => l.ordinal)).toEqual([0, 1]);
  });
});
