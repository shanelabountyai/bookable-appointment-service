/**
 * A-016 — the day view against a real database (BOOK-04's view half, Goal 3).
 *
 * The assertions worth having are the ones where the grid and the booking
 * engine could disagree: an override that occupies time the constraint has
 * been told to ignore, a cancelled appointment that should free its slot but
 * still be visible, and a booking that runs past midnight into a day it does
 * not start on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromDate, instantFromIso, toDate, toLabel, zoneId } from '../../core/time';
import { staffActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createAdHocBlock, createTimeOff, createWeeklyWindow, upsertDateOverride } from '../availability';
import { bookAppointment } from '../booking';
import { loadDayView } from './day-view';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');

const at = (iso: string) => toDate(instantFromIso(iso));
const DAY = '2026-06-09'; // Tuesday
const NOW = at('2026-06-08T08:00:00-05:00');
/** The wall clock of an instant IN UTC, through the one conversion module.
 *  The fixtures are written in America/Chicago offsets, so a UTC label is an
 *  unambiguous way to assert an instant without restating the offset — and it
 *  goes through `toLabel` rather than slicing an ISO string, which is the
 *  axis crossing this repo bans even in tests. */
const hhmm = (d: Date) => toLabel(fromDate(d), zoneId('UTC')).time;

let businessId: string;
let danaId: string;
let priyaId: string;
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
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana', displayOrder: 0 } });
  const priya = await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } });
  danaId = dana.id;
  priyaId = priya.id;

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
      data: { businessId, name: 'Ada Chen', phone: '5125550101', notes: 'Allergic to PPD.' },
    })
  ).id;

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);
  await createWeeklyWindow(
    prisma,
    { businessId, providerId: dana.id, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false, breaks: [{ open: '12:00', close: '13:00' }] },
    STAMP,
  );
  await createWeeklyWindow(prisma, { businessId, providerId: priya.id, weekday: 2, open: '10:00', close: '16:00', endsNextDay: false }, STAMP);
});

const load = (day = DAY) => loadDayView(prisma, { businessId, day, now: NOW });
const columnFor = async (providerId: string, day = DAY) =>
  (await load(day)).columns.find((c) => c.providerId === providerId)!;

const book = (over: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId: danaId,
    serviceIds: [serviceId],
    clientId,
    startAt: at('2026-06-09T10:00:00-05:00'),
    now: NOW,
    actor: ACTOR,
    audience: 'staff',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

describe('the columns', () => {
  it('is one column per ACTIVE provider, in display order', async () => {
    const view = await load();
    expect(view.columns.map((c) => c.providerName)).toEqual(['Dana', 'Priya']);
  });

  it('drops a deactivated provider', async () => {
    await prisma.provider.update({ where: { id: priyaId }, data: { active: false } });
    expect((await load()).columns.map((c) => c.providerName)).toEqual(['Dana']);
  });

  it('carries each provider’s own hours, intersected with the business’s', async () => {
    const dana = await columnFor(danaId);
    const priya = await columnFor(priyaId);

    expect(dana.windows).toHaveLength(1);
    expect(hhmm(dana.windows[0]!.start)).toBe('14:00'); // 09:00 CDT
    expect(hhmm(dana.windows[0]!.end)).toBe('22:00'); // 17:00 CDT
    expect(hhmm(priya.windows[0]!.start)).toBe('15:00'); // 10:00 CDT
  });

  it('says a day is CLOSED rather than merely empty', async () => {
    await upsertDateOverride(prisma, { businessId, providerId: danaId, day: DAY, isClosed: true, windows: [] }, STAMP);
    const dana = await columnFor(danaId);
    expect(dana.closed).toBe(true);
    expect(dana.windows).toEqual([]);
    // And a closed day offers nothing: it is not a day full of gaps.
    expect(dana.gaps).toEqual([]);
  });
});

describe('the appointments', () => {
  it('carries the client chip — name, phone and the pinned note', async () => {
    await book();
    const [appointment] = (await columnFor(danaId)).appointments;

    expect(appointment?.clientName).toBe('Ada Chen');
    expect(appointment?.clientPhone).toBe('5125550101');
    // CLIENT-03: an allergy belongs on the chip, not one click away.
    expect(appointment?.clientNotes).toBe('Allergic to PPD.');
    expect(appointment?.serviceNames).toEqual(['Cut']);
  });

  it('renders a walk-in with no client record (BOOK-04)', async () => {
    await book({ clientId: null });
    const [appointment] = (await columnFor(danaId)).appointments;
    expect(appointment?.clientName).toBeNull();
    expect(appointment?.clientPhone).toBeNull();
  });

  /**
   * D-7: `completed` and `no_show` still OCCUPY their time. A grid that freed
   * a no-show's slot would invite the front desk to book over the hour the
   * stylist actually spent waiting.
   */
  it.each(['completed', 'no_show'] as const)('keeps a %s appointment occupying its time', async (status) => {
    const appointment = await book();
    await prisma.appointment.update({ where: { id: appointment.id }, data: { status } });

    const dana = await columnFor(danaId);
    expect(dana.appointments).toHaveLength(1);
    expect(dana.gaps.some((g) => hhmm(g.start) === '15:00')).toBe(false);
  });

  /**
   * A cancellation frees the time AND stays visible. Both halves matter: the
   * slot must be sellable again, and "she cancelled" is what the front desk
   * needs when the client turns up anyway.
   */
  it.each(['cancelled', 'cancelled_late'] as const)('shows a %s appointment but frees its time', async (status) => {
    const appointment = await book();
    await prisma.appointment.update({ where: { id: appointment.id }, data: { status } });

    const dana = await columnFor(danaId);
    expect(dana.appointments.map((a) => a.status)).toEqual([status]);
    // 09:00–12:00 free again, in one piece.
    expect(dana.gaps.some((g) => hhmm(g.start) === '14:00' && hhmm(g.end) === '17:00')).toBe(true);
  });

  /**
   * D-8 + D-16, and the reason `overriddenFromRange` exists. An override's
   * blocked range is ZERO-WIDTH so the exclusion constraint stays absolute
   * without refusing it — but the column must show the true collision, or the
   * grid claims the stylist is free at a time she is double-booked.
   */
  it('shows an override occupying its TRUE range, not its zero-width one', async () => {
    await book({ startAt: at('2026-06-09T10:00:00-05:00'), idempotencyKey: 'first' });
    await book({
      startAt: at('2026-06-09T10:30:00-05:00'),
      isOverride: true,
      overrideReason: 'squeezing her in before the wedding',
      idempotencyKey: 'override',
      clientId: null,
    });

    const dana = await columnFor(danaId);
    const override = dana.appointments.find((a) => a.isOverride)!;
    expect(hhmm(override.occupiesStart)).toBe('15:30');
    expect(hhmm(override.occupiesEnd)).toBe('16:45'); // body + the 15-minute buffer
    expect(override.overrideReason).toBe('squeezing her in before the wedding');
  });

  /**
   * THE DEMO CHECKPOINT 2 REGRESSION.
   *
   * The queries behind a column deliberately span local midnight ±24h — the
   * busy set needs that width so a neighbouring day's buffers still subtract,
   * and an overnight window needs it to exist at all. The DISPLAYED
   * appointments were never clipped back, so Dana's Tuesday column showed 29
   * appointments running into Wednesday afternoon.
   *
   * Every A-016 test passed while that was true, because each one seeds a
   * single day: the defect needs a neighbouring day with rows in it, which is
   * what a seeded week has and a unit fixture does not. So this fixture books
   * BOTH days on purpose.
   */
  it('shows only this day’s appointments, not the neighbours’', async () => {
    await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 1, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);
    await createWeeklyWindow(prisma, { businessId, providerId: danaId, weekday: 1, open: '09:00', close: '17:00', endsNextDay: false }, STAMP);
    await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 3, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);
    await createWeeklyWindow(prisma, { businessId, providerId: danaId, weekday: 3, open: '09:00', close: '17:00', endsNextDay: false }, STAMP);

    await book({ startAt: at('2026-06-08T10:00:00-05:00'), idempotencyKey: 'monday' });
    const tuesday = await book({ startAt: at('2026-06-09T10:00:00-05:00'), idempotencyKey: 'tuesday' });
    await book({ startAt: at('2026-06-10T10:00:00-05:00'), idempotencyKey: 'wednesday' });

    const dana = await columnFor(danaId);
    expect(dana.appointments.map((a) => a.id)).toEqual([tuesday.id]);
  });

  /**
   * An instant-overlap predicate, never `WHERE date(startAt) = day`. The
   * booking that starts 23:30 belongs to BOTH days, and dropping it from the
   * second is how the grid shows a free 00:00 that is not free.
   */
  it('shows a booking that runs past midnight on the following day too', async () => {
    await createWeeklyWindow(
      prisma,
      { businessId, providerId: null, weekday: 2, open: '18:00', close: '02:00', endsNextDay: true },
      STAMP,
    );
    await createWeeklyWindow(
      prisma,
      { businessId, providerId: danaId, weekday: 2, open: '18:00', close: '02:00', endsNextDay: true },
      STAMP,
    );
    await book({ startAt: at('2026-06-09T23:30:00-05:00'), idempotencyKey: 'late' });

    const wednesday = await columnFor(danaId, '2026-06-10');
    expect(wednesday.appointments).toHaveLength(1);
  });
});

describe('the absences', () => {
  it('lists time off and ad-hoc blocks with their reasons', async () => {
    await createTimeOff(
      prisma,
      { businessId, providerId: danaId, startAt: at('2026-06-09T14:00:00-05:00'), endAt: at('2026-06-09T16:00:00-05:00'), reason: 'dentist' },
      STAMP,
    );
    await createAdHocBlock(
      prisma,
      { businessId, providerId: danaId, startAt: at('2026-06-09T16:30:00-05:00'), endAt: at('2026-06-09T17:00:00-05:00'), reason: 'stock delivery' },
      STAMP,
    );

    const dana = await columnFor(danaId);
    expect(dana.absences.map((a) => a.kind).sort()).toEqual(['ad_hoc_block', 'time_off']);
    // An ad-hoc block is NOT time off — telling the front desk a stylist is
    // away when she is standing there is how a screen stops being read.
    expect(dana.absences.find((a) => a.kind === 'time_off')?.reason).toBe('dentist');
  });
});

describe('the gaps', () => {
  it('is the whole working day when nothing is booked, minus the break', async () => {
    const dana = await columnFor(danaId);
    expect(dana.gaps.map((g) => [hhmm(g.start), hhmm(g.end), g.minutes])).toEqual([
      ['14:00', '17:00', 180], // 09:00–12:00
      ['18:00', '22:00', 240], // 13:00–17:00
    ]);
  });

  it('splits around an appointment, and counts the buffer as taken', async () => {
    await book(); // 10:00–11:00 + 15 minutes after

    const dana = await columnFor(danaId);
    const lengths = dana.gaps.map((g) => [hhmm(g.start), hhmm(g.end)]);
    expect(lengths).toContainEqual(['14:00', '15:00']); // 09:00–10:00
    // 11:15, not 11:00 — the buffer is the salon's time and is not free.
    expect(lengths).toContainEqual(['16:15', '17:00']);
  });

  it('does not offer lunch as a gap', async () => {
    const dana = await columnFor(danaId);
    expect(dana.gaps.some((g) => hhmm(g.start) === '17:00')).toBe(false);
  });

  it('takes time off out of the gaps', async () => {
    await createTimeOff(
      prisma,
      { businessId, providerId: danaId, startAt: at('2026-06-09T09:00:00-05:00'), endAt: at('2026-06-09T12:00:00-05:00'), reason: 'dentist' },
      STAMP,
    );
    const dana = await columnFor(danaId);
    expect(dana.gaps.map((g) => hhmm(g.start))).toEqual(['18:00']);
  });

  it('reports each gap’s length in minutes, which is what the front desk reads', async () => {
    await book({ startAt: at('2026-06-09T09:00:00-05:00'), idempotencyKey: 'nine' }); // 09:00–10:15 blocked
    await book({ startAt: at('2026-06-09T11:00:00-05:00'), idempotencyKey: 'eleven' }); // 11:00–12:15 blocked

    const dana = await columnFor(danaId);
    const between = dana.gaps.find((g) => hhmm(g.start) === '15:15');
    expect(between?.minutes).toBe(45);
  });
});

describe('the rendering bounds', () => {
  it('spans the working hours rather than the whole calendar day', async () => {
    const view = await load();
    expect(hhmm(view.from)).toBe('14:00'); // the earliest open, 09:00 CDT
    expect(hhmm(view.to)).toBe('22:00'); // the latest close, 17:00 CDT
  });

  it('stretches to include an appointment outside the working hours', async () => {
    // A staff override before opening — it has to be on screen, or the front
    // desk sees a column that disagrees with the book.
    await book({
      startAt: at('2026-06-09T08:00:00-05:00'),
      isOverride: true,
      overrideReason: 'early wedding party',
      idempotencyKey: 'early',
    });
    const view = await load();
    expect(hhmm(view.from)).toBe('13:00'); // 08:00 CDT
  });
});
