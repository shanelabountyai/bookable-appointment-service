/**
 * A-057 — "End this series here" against the real database (D-39).
 *
 * The assertions that matter are the ones D-35's six-taps-by-hand would ALSO
 * pass, so these pin what only the bulk action can get wrong: which
 * occurrences are in the window, which status each one lands in, and that the
 * evidence per occurrence (one event, one message, the freed time) is the same
 * as if the desk had done them one at a time.
 *
 * `Zero silent losses` is the through-line: every occurrence the action does
 * not cancel is asserted to be NAMED, never merely absent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { staffActor } from '../../core/auth';
import { instantFromIso, toDate } from '../../core/time';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from './book';
import { createSeries } from './series';
import { endSeriesHere, previewEndSeries } from './end-series';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');
const at = (iso: string) => toDate(instantFromIso(iso));
/** Frozen, and long before every occurrence — the cutoff tests below move it
 *  deliberately, and a test that read the clock could not. */
const NOW = at('2026-02-01T08:00:00-06:00');

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
      bookingHorizonDays: 365,
      cancellationCutoffMinutes: 24 * 60,
    },
  });
  businessId = business.id;

  serviceId = (
    await prisma.service.create({
      data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 },
    })
  ).id;
  clientId = (
    await prisma.client.create({ data: { businessId, name: 'Mrs Kerr', phone: '5125550101' } })
  ).id;

  for (let weekday = 0; weekday <= 6; weekday++) {
    await createWeeklyWindow(
      prisma,
      { businessId, providerId: null, weekday, open: '00:00', close: '23:59', endsNextDay: false },
      STAMP,
    );
  }
  const provider = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  providerId = provider.id;
  await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId } });
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createWeeklyWindow(
      prisma,
      { businessId, providerId, weekday, open: '00:00', close: '23:59', endsNextDay: false },
      STAMP,
    );
  }
});

/** Six four-weekly Tuesdays at 2pm — Mrs Kerr's standing appointment. */
const sixTuesdays = () =>
  createSeries(prisma, {
    businessId,
    providerId,
    clientId,
    serviceIds: [serviceId],
    anchorDay: '2026-03-03',
    time: '14:00',
    intervalWeeks: 4,
    count: 6,
    now: NOW,
    actor: ACTOR,
  });

const statuses = async (seriesId: string) =>
  (
    await prisma.appointment.findMany({
      where: { seriesId },
      orderBy: { startAt: 'asc' },
      select: { status: true },
    })
  ).map((a) => a.status);

describe('end this series HERE', () => {
  it('cancels this occurrence and every one after it, and leaves the earlier ones alone', async () => {
    const created = await sixTuesdays();
    expect(created.booked).toBe(6);
    const occurrences = await prisma.appointment.findMany({
      where: { seriesId: created.seriesId },
      orderBy: { startAt: 'asc' },
      select: { id: true },
    });

    const result = await endSeriesHere(prisma, {
      businessId,
      appointmentId: occurrences[2]!.id,
      reason: 'She is moving away',
      actor: ACTOR,
      now: NOW,
    });

    // Four: the third and the three after it. INCLUSIVE of the one being
    // viewed — "end it here" leaves the two she has already had.
    expect(result?.ended).toBe(4);
    expect(await statuses(created.seriesId)).toEqual([
      'booked',
      'booked',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
  });

  it('leaves the series row and every seriesId in place — the link is provenance (D-34)', async () => {
    const created = await sixTuesdays();
    const first = await prisma.appointment.findFirstOrThrow({
      where: { seriesId: created.seriesId },
      orderBy: { startAt: 'asc' },
      select: { id: true },
    });

    await endSeriesHere(prisma, {
      businessId,
      appointmentId: first.id,
      reason: 'She is moving away',
      actor: ACTOR,
      now: NOW,
    });

    expect(await prisma.appointmentSeries.findUnique({ where: { id: created.seriesId } })).not.toBeNull();
    // "She had a standing Tuesday and ended it in March" is the fact the desk
    // is looking for six months later.
    expect(await prisma.appointment.count({ where: { seriesId: created.seriesId } })).toBe(6);
  });

  it('does not touch an occurrence that was already cancelled — no second event, no second message', async () => {
    const created = await sixTuesdays();
    const occurrences = await prisma.appointment.findMany({
      where: { seriesId: created.seriesId },
      orderBy: { startAt: 'asc' },
      select: { id: true },
    });

    // She cancelled the fifth one herself, weeks ago.
    await prisma.appointment.update({ where: { id: occurrences[4]!.id }, data: { status: 'cancelled' } });

    const result = await endSeriesHere(prisma, {
      businessId,
      appointmentId: occurrences[3]!.id,
      reason: 'She is moving away',
      actor: ACTOR,
      now: NOW,
    });

    expect(result?.rows.map((r) => r.appointmentId)).toEqual([occurrences[3]!.id, occurrences[5]!.id]);
    expect(result?.ended).toBe(2);
    // Its only event is still the one that booked it: nothing here wrote a
    // second cancellation over a cancellation.
    expect(
      await prisma.appointmentEvent.count({
        where: { appointmentId: occurrences[4]!.id, type: 'status_changed' },
      }),
    ).toBe(0);
  });

  it('frees the time it cancelled — the same slot books again', async () => {
    const created = await sixTuesdays();
    const last = await prisma.appointment.findFirstOrThrow({
      where: { seriesId: created.seriesId },
      orderBy: { startAt: 'desc' },
      select: { id: true, startAt: true },
    });

    await endSeriesHere(prisma, {
      businessId,
      appointmentId: last.id,
      reason: 'She is moving away',
      actor: ACTOR,
      now: NOW,
    });

    // The exclusion constraint really let go: a cancellation that only changed
    // a label would refuse this with 23P01.
    const rebooked = await bookAppointment(prisma, {
      businessId,
      providerId,
      serviceIds: [serviceId],
      clientId: null,
      startAt: last.startAt,
      now: NOW,
      actor: ACTOR,
      audience: 'staff',
    });
    expect(rebooked.id).toBeTruthy();
  });
});

describe('the preview, which is the whole reason D-35 thought this was impossible', () => {
  it('says which occurrences fall inside the cutoff, and the write agrees with it', async () => {
    const created = await sixTuesdays();
    const occurrences = await prisma.appointment.findMany({
      where: { seriesId: created.seriesId },
      orderBy: { startAt: 'asc' },
      select: { id: true },
    });

    // She rings the afternoon before the third Tuesday (28 April): that
    // occurrence is inside the 24-hour cutoff and the three after it are not. The row-by-row split is
    // exactly the objection D-35 raised, answered by showing it.
    const ringing = at('2026-04-27T15:00:00-05:00');
    const plan = await previewEndSeries(prisma, {
      businessId,
      appointmentId: occurrences[2]!.id,
      now: ringing,
    });
    expect(plan?.rows.map((r) => r.insideCutoff)).toEqual([true, false, false, false]);

    const result = await endSeriesHere(prisma, {
      businessId,
      appointmentId: occurrences[2]!.id,
      reason: 'She is moving away',
      actor: ACTOR,
      now: ringing,
    });
    expect(result?.ended).toBe(4);
    // The status written IS the one the preview showed.
    expect(await statuses(created.seriesId)).toEqual([
      'booked',
      'booked',
      'cancelled_late',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
  });

  /**
   * CHECKPOINT 5, FINDING 1 — the seam between this item and A-060.
   *
   * A-057 shipped before A-060 and classified from the clock alone, with a
   * comment saying "§7 lets staff write either unconditionally, so nothing
   * downstream re-decides this". A-060 is the item that stopped that being
   * true: it made one cancel button derive the status AND gave the desk an
   * escape for the cancellations the SALON causes, precisely so those never
   * land on an innocent client's rolling count.
   *
   * Ending a standing booking is the cancellation the salon causes most often
   * — the stylist is leaving — and it is also how this product MOVES a
   * standing appointment ("end here, rebook from here"). Both stamped a late
   * cancellation on a client who did nothing, for twelve months.
   */
  it('does not count a salon-caused series end against the client', async () => {
    const created = await sixTuesdays();
    const occurrences = await prisma.appointment.findMany({
      where: { seriesId: created.seriesId },
      orderBy: { startAt: 'asc' },
      select: { id: true },
    });
    const ringing = at('2026-04-27T15:00:00-05:00');

    const result = await endSeriesHere(prisma, {
      businessId,
      appointmentId: occurrences[2]!.id,
      reason: 'Dana is leaving us — we are ending the standing Tuesday',
      onUs: true,
      actor: ACTOR,
      now: ringing,
    });
    expect(result?.ended).toBe(4);

    // The one inside the window would have been `cancelled_late` and is not.
    expect(await statuses(created.seriesId)).toEqual([
      'booked',
      'booked',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);

    // ...and the overrule is RECORDED, so A-060's drill-down can still ask how
    // many were overruled and by whom. Writing an honest status is not the
    // same as writing no evidence.
    const events = await prisma.appointmentEvent.findMany({
      where: { appointmentId: occurrences[2]!.id },
      orderBy: { createdAt: 'asc' },
    });
    const overruled = events.filter((e) => (e.payload as { overruled?: string })?.overruled);
    expect(overruled).toHaveLength(1);
    expect((overruled[0]!.payload as { overruled?: string }).overruled).toBe('cancelled_late');
  });

  it('still counts an ordinary series end against her, escape untouched', async () => {
    const created = await sixTuesdays();
    const occurrences = await prisma.appointment.findMany({
      where: { seriesId: created.seriesId },
      orderBy: { startAt: 'asc' },
      select: { id: true },
    });

    // Deliberately NOT passing `onUs`: she rang an hour before, and that is a
    // late cancellation. The escape must not have quietly become the default.
    await endSeriesHere(prisma, {
      businessId,
      appointmentId: occurrences[2]!.id,
      reason: 'She is moving away',
      actor: ACTOR,
      now: at('2026-04-27T15:00:00-05:00'),
    });
    expect((await statuses(created.seriesId))[2]).toBe('cancelled_late');
  });

  it('NAMES the occurrence it will not cancel rather than silently skipping it', async () => {
    const created = await sixTuesdays();
    const occurrences = await prisma.appointment.findMany({
      where: { seriesId: created.seriesId },
      orderBy: { startAt: 'asc' },
      select: { id: true },
    });

    // She is in the chair for the fourth one right now.
    await prisma.appointment.update({ where: { id: occurrences[3]!.id }, data: { status: 'in_progress' } });

    const result = await endSeriesHere(prisma, {
      businessId,
      appointmentId: occurrences[2]!.id,
      reason: 'She is moving away',
      actor: ACTOR,
      now: NOW,
    });

    // The REASON, not merely an absence: a bulk cancellation that texted a
    // client sitting in front of the person who sent it is the A-055 sin.
    expect(result?.rows.find((r) => r.appointmentId === occurrences[3]!.id)?.problem).toBe('in-the-chair');
    expect(result?.ended).toBe(3);
    expect((await statuses(created.seriesId))[3]).toBe('in_progress');
  });

  it('returns null for an appointment that is not part of a series', async () => {
    const lone = await bookAppointment(prisma, {
      businessId,
      providerId,
      serviceIds: [serviceId],
      clientId,
      startAt: at('2026-03-04T14:00:00-06:00'),
      now: NOW,
      actor: ACTOR,
      audience: 'staff',
    });
    expect(await previewEndSeries(prisma, { businessId, appointmentId: lone.id, now: NOW })).toBeNull();
  });
});

describe('what the client is told (D-32)', () => {
  it('sends one cancellation per occurrence, carrying the one typed reason', async () => {
    const created = await sixTuesdays();
    const occurrences = await prisma.appointment.findMany({
      where: { seriesId: created.seriesId },
      orderBy: { startAt: 'asc' },
      select: { id: true },
    });

    const result = await endSeriesHere(prisma, {
      businessId,
      appointmentId: occurrences[4]!.id,
      reason: 'She is moving away',
      actor: ACTOR,
      now: NOW,
    });

    const sent = await prisma.notificationOutbox.findMany({
      where: { template: 'appointment.cancelled' },
      select: { appointmentId: true, payload: true },
    });
    expect(sent).toHaveLength(2);
    expect(result?.notified).toBe(2);
    expect(new Set(sent.map((s) => s.appointmentId))).toEqual(
      new Set([occurrences[4]!.id, occurrences[5]!.id]),
    );
    // The reason typed once reaches every message — it is what the desk reads
    // back on the phone.
    for (const row of sent) {
      expect((row.payload as { reason?: string }).reason).toBe('She is moving away');
    }
  });

  it('sends nothing when the desk has already rung her, and says so', async () => {
    const created = await sixTuesdays();
    const occurrences = await prisma.appointment.findMany({
      where: { seriesId: created.seriesId },
      orderBy: { startAt: 'asc' },
      select: { id: true },
    });

    const result = await endSeriesHere(prisma, {
      businessId,
      appointmentId: occurrences[4]!.id,
      reason: 'Rang her this morning',
      actor: ACTOR,
      now: NOW,
      notify: false,
    });

    expect(result?.ended).toBe(2);
    expect(result?.notified).toBe(0);
    expect(await prisma.notificationOutbox.count({ where: { template: 'appointment.cancelled' } })).toBe(0);
    // Silenced, never unrecorded: the event log still has both.
    expect(
      await prisma.appointmentEvent.count({
        where: { appointmentId: { in: [occurrences[4]!.id, occurrences[5]!.id] }, type: 'status_changed' },
      }),
    ).toBe(2);
  });
});
