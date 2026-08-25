/**
 * A-058 — some services must never be sold to a stranger from a phone
 * (BOOK-01), against a real database.
 *
 * The defect: `Service` had no way to say "the desk books this, self-serve
 * does not", so a first-time client could self-book a colour correction or a
 * full-head bleach with no consultation and no patch test — three hours of a
 * Saturday committed by somebody nobody has met.
 *
 * What these tests pin is the SHAPE of the rule and not just its existence:
 * public refused / staff unaffected / the visit is refused when ANY line in it
 * is desk-only / and — the one that is easy to get wrong — an existing
 * appointment for a desk-only service stays reschedulable through the manage
 * link, which also runs as `audience: 'public'`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { customerTokenActor, staffActor, systemActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { computeDaySlots, daysWithAvailability } from '../scheduling';
import { rescheduleAppointment } from '../appointments';
import { bookAppointment } from './book';
import { NotBookableOnline } from './errors';

const prisma = new PrismaClient();
const STAFF_WINDOW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const STAFF = staffActor('staff-1');

const at = (iso: string) => toDate(instantFromIso(iso));

// Tuesday 9 June 2026, Chicago.
const DAY = '2026-06-09';
const NOW = at('2026-06-08T08:00:00-05:00');

let businessId: string;
let dana: string;
let cutId: string;
let correctionId: string;
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
      slotIntervalMinutes: 30,
      minimumLeadMinutes: 0,
      cancellationCutoffMinutes: 120,
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;
  dana = (await prisma.provider.create({ data: { businessId, displayName: 'Dana', displayOrder: 0 } })).id;

  cutId = (
    await prisma.service.create({ data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 } })
  ).id;
  // The service this whole item is about. Note it is ACTIVE — the salon sells
  // it every week; what it is not is self-serve.
  correctionId = (
    await prisma.service.create({
      data: {
        businessId,
        name: 'Colour correction',
        durationMinutes: 60,
        priceCents: 32000,
        bookableOnline: false,
      },
    })
  ).id;

  await prisma.serviceProvider.createMany({
    data: [
      { businessId, serviceId: cutId, providerId: dana },
      { businessId, serviceId: correctionId, providerId: dana },
    ],
  });
  await createWeeklyWindow(
    prisma,
    { businessId, providerId: null, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
    STAFF_WINDOW,
  );
  await createWeeklyWindow(
    prisma,
    { businessId, providerId: dana, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
    STAFF_WINDOW,
  );

  clientId = (await prisma.client.create({ data: { businessId, name: 'Ana Reyes', phone: '+13125550101' } })).id;
});

const book = (serviceIds: string[], audience: 'public' | 'staff', startAt = at('2026-06-09T10:00:00-05:00')) =>
  bookAppointment(prisma, {
    businessId,
    providerId: dana,
    serviceIds,
    clientId,
    startAt,
    now: NOW,
    actor: audience === 'staff' ? STAFF : systemActor,
    audience,
  });

describe('the column that decides who may start it', () => {
  it('defaults to TRUE, so every service that existed before this is unchanged', async () => {
    const cut = await prisma.service.findUniqueOrThrow({ where: { id: cutId } });
    expect(cut.bookableOnline).toBe(true);
    await expect(book([cutId], 'public')).resolves.toMatchObject({ status: 'booked' });
  });

  it('refuses a desk-only service to the PUBLIC, naming it', async () => {
    const error = await book([correctionId], 'public').catch((e) => e);
    expect(error).toBeInstanceOf(NotBookableOnline);
    // The name travels, because a refused two-service visit without it leaves
    // her removing services at random to find the one at fault.
    expect((error as NotBookableOnline).serviceName).toBe('Colour correction');
    expect(await prisma.appointment.count()).toBe(0);
  });

  it('books the SAME service happily for staff — desk-only is not deactivated', async () => {
    const booked = await book([correctionId], 'staff');
    expect(booked.status).toBe('booked');
  });

  it('refuses a visit when ANY line is desk-only, even with a bookable one beside it', async () => {
    // VISIT-01 is all-or-nothing, and this is the direction that matters: a
    // cut smuggling a colour correction through with it must not book, or the
    // flag is bypassed by adding a haircut.
    const error = await book([cutId, correctionId], 'public').catch((e) => e);
    expect(error).toBeInstanceOf(NotBookableOnline);
    expect((error as NotBookableOnline).serviceName).toBe('Colour correction');
    expect(await prisma.appointment.count()).toBe(0);
  });

  it('refuses BEFORE anything is written, whatever the time would have been', async () => {
    // Not a fact about the time, so a different one is no answer: every start
    // in the day is refused identically. This is why it is its own error and
    // not a `SlotNotOffered` carrying alternatives.
    for (const hour of ['09:00', '11:00', '15:00']) {
      await expect(book([correctionId], 'public', at(`2026-06-09T${hour}:00-05:00`))).rejects.toBeInstanceOf(
        NotBookableOnline,
      );
    }
    expect(await prisma.appointment.count()).toBe(0);
  });
});

describe('what the flag deliberately does NOT touch', () => {
  /**
   * The reason the guard is in `bookAppointment` and not in `buildSlotQuery`.
   *
   * The manage link runs as `audience: 'public'` too, so putting the rule in
   * the engine layer would have made a colour correction — booked properly
   * through the desk, consultation done — unmovable by the client who has it.
   * That is a worse product than the one this item is fixing, and it is the
   * kind of thing only a test that names it keeps out.
   */
  it('leaves an EXISTING desk-only appointment reschedulable by the client', async () => {
    const booked = await book([correctionId], 'staff');

    const moved = await rescheduleAppointment(prisma, {
      appointmentId: booked.id,
      startAt: at('2026-06-09T14:00:00-05:00'),
      now: NOW,
      // The manage link's own actor, so this is the real path and not a
      // staff-shaped stand-in for it.
      actor: customerTokenActor('token-1'),
      audience: 'public',
    });

    expect(moved.to.getTime()).toBe(at('2026-06-09T14:00:00-05:00').getTime());
    // Same row (D-6) — a reschedule is an UPDATE, never a cancel-and-rebook,
    // and a rebook would have gone through the guard above and failed.
    expect(moved.id).toBe(booked.id);
  });

  it('still OFFERS the engine times for it — the refusal is at the write, not in the grid', async () => {
    // The public surface never asks (`anyDeskOnly` short-circuits in
    // `public-actions.ts`), but the engine itself stays a pure availability
    // question. If this ever starts returning nothing, the rule has leaked
    // into the layer the reschedule above depends on.
    const { slots } = await computeDaySlots(prisma, {
      businessId,
      providerId: dana,
      serviceIds: [correctionId],
      day: DAY,
      now: NOW,
      audience: 'public',
    });
    expect(slots.length).toBeGreaterThan(0);

    const days = await daysWithAvailability(prisma, {
      businessId,
      providerId: dana,
      serviceIds: [correctionId],
      now: NOW,
      audience: 'public',
      fromDay: DAY,
      toDay: DAY,
    });
    expect(days).toEqual([DAY]);
  });
});
