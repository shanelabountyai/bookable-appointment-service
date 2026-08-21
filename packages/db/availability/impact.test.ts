/**
 * A-019 — the impact workflow (AVAIL-05, operator R-7, operator S-2).
 *
 * The rule under test throughout: **nothing is silently cancelled, moved or
 * hidden**. So the assertions are mostly about what is still there — the
 * appointment survives the sick day, the conflict is still reported, and an
 * acknowledgment does not outlive the thing it acknowledged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { staffActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { bookAppointment } from '../booking';
import {
  createAdHocBlock,
  createTimeOff,
  createWeeklyWindow,
  deleteTimeOff,
  upsertDateOverride,
} from './availability';
import {
  acknowledgeConflict,
  appointmentsInRange,
  appointmentsOutsideHours,
  conflictsForDay,
  futureAppointments,
} from './impact';
import { enqueueNotification } from '../notifications';
import { reassignAppointment, reassignMany } from './reassign';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');

const at = (iso: string) => toDate(instantFromIso(iso));
const DAY = '2026-06-09'; // Tuesday
const NOW = at('2026-06-08T08:00:00-05:00');

let businessId: string;
let danaId: string;
let priyaId: string;
let marcusId: string;
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
    data: { name: 'Shear Genius', timezone: 'America/Chicago', minimumLeadMinutes: 0, bookingHorizonDays: 365 },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana', displayOrder: 0 } });
  const priya = await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } });
  const marcus = await prisma.provider.create({ data: { businessId, displayName: 'Marcus', displayOrder: 2 } });
  danaId = dana.id;
  priyaId = priya.id;
  marcusId = marcus.id;

  const cut = await prisma.service.create({ data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 } });
  const colour = await prisma.service.create({ data: { businessId, name: 'Colour', durationMinutes: 90, priceCents: 12000 } });
  cutId = cut.id;
  colourId = colour.id;
  await prisma.serviceProvider.createMany({
    data: [
      { businessId, serviceId: cut.id, providerId: dana.id },
      { businessId, serviceId: colour.id, providerId: dana.id },
      { businessId, serviceId: cut.id, providerId: priya.id },
      // Marcus does colour only — so a cut cannot be handed to him.
      { businessId, serviceId: colour.id, providerId: marcus.id },
    ],
  });

  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);
  for (const p of [dana.id, priya.id, marcus.id]) {
    await createWeeklyWindow(prisma, { businessId, providerId: p, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false }, STAMP);
  }
});

const book = (startIso: string, over: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId: danaId,
    serviceIds: [cutId],
    clientId,
    startAt: at(startIso),
    now: NOW,
    actor: ACTOR,
    audience: 'staff',
    idempotencyKey: `${startIso}-${JSON.stringify(over.providerId ?? '')}`,
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

describe('AVAIL-05 — the sick day', () => {
  /** Recording the absence must ALWAYS succeed. What happens to the nine
   *  clients is a decision for a person, not a refusal from a database. */
  it('accepts time off over booked appointments, and reports them', async () => {
    await book('2026-06-09T10:00:00-05:00');
    await book('2026-06-09T14:00:00-05:00');

    await createTimeOff(
      prisma,
      { businessId, providerId: danaId, startAt: at('2026-06-09T09:00:00-05:00'), endAt: at('2026-06-09T17:00:00-05:00'), reason: 'sick' },
      STAMP,
    );

    const conflicts = await appointmentsInRange(prisma, {
      businessId,
      providerId: danaId,
      startAt: at('2026-06-09T09:00:00-05:00'),
      endAt: at('2026-06-09T17:00:00-05:00'),
    });
    expect(conflicts).toHaveLength(2);
    // Nothing silently cancelled: they are all still booked.
    expect(conflicts.every((c) => c.status === 'booked')).toBe(true);
  });

  /** AVAIL-05 asks for names AND phones: the resolution is a phone call. */
  it('carries the client’s name and number on every conflict', async () => {
    await book('2026-06-09T10:00:00-05:00');
    const [conflict] = await appointmentsInRange(prisma, {
      businessId,
      providerId: danaId,
      startAt: at('2026-06-09T09:00:00-05:00'),
      endAt: at('2026-06-09T12:00:00-05:00'),
    });
    expect(conflict?.clientName).toBe('Ada Chen');
    expect(conflict?.clientPhone).toBe('5125550101');
    expect(conflict?.serviceNames).toEqual(['Cut']);
  });

  it('ignores a cancelled appointment — it cannot be stranded', async () => {
    const cancelled = await book('2026-06-09T10:00:00-05:00');
    await prisma.appointment.update({ where: { id: cancelled.id }, data: { status: 'cancelled' } });

    const conflicts = await appointmentsInRange(prisma, {
      businessId,
      providerId: danaId,
      startAt: at('2026-06-09T09:00:00-05:00'),
      endAt: at('2026-06-09T17:00:00-05:00'),
    });
    expect(conflicts).toEqual([]);
  });

  it('reports an ad-hoc block’s casualties too', async () => {
    await book('2026-06-09T10:00:00-05:00');
    await createAdHocBlock(
      prisma,
      { businessId, providerId: danaId, startAt: at('2026-06-09T10:30:00-05:00'), endAt: at('2026-06-09T11:00:00-05:00'), reason: 'delivery' },
      STAMP,
    );
    const conflicts = await conflictsForDay(prisma, { businessId, day: DAY });
    expect(conflicts).toHaveLength(1);
  });
});

describe('AVAIL-05 — an hours edit', () => {
  it('reports an appointment the new hours no longer cover', async () => {
    await book('2026-06-09T16:00:00-05:00'); // 16:00–17:00, inside 09:00–17:00

    // The owner brings Dana's Tuesday close forward to 15:00.
    await upsertDateOverride(
      prisma,
      { businessId, providerId: danaId, day: DAY, isClosed: false, windows: [{ open: '09:00', close: '15:00', endsNextDay: false }] },
      STAMP,
    );

    const stranded = await appointmentsOutsideHours(prisma, { businessId, providerId: danaId, day: DAY });
    expect(stranded).toHaveLength(1);
    expect(stranded[0]?.clientName).toBe('Ada Chen');
  });

  it('says nothing when every appointment still fits', async () => {
    await book('2026-06-09T10:00:00-05:00');
    const stranded = await appointmentsOutsideHours(prisma, { businessId, providerId: danaId, day: DAY });
    expect(stranded).toEqual([]);
  });

  /** Half-in is stranded: the salon shuts underneath her. */
  it('reports an appointment that would run past the new close', async () => {
    await book('2026-06-09T14:30:00-05:00'); // ends 15:30
    await upsertDateOverride(
      prisma,
      { businessId, providerId: danaId, day: DAY, isClosed: false, windows: [{ open: '09:00', close: '15:00', endsNextDay: false }] },
      STAMP,
    );
    expect(await appointmentsOutsideHours(prisma, { businessId, providerId: danaId, day: DAY })).toHaveLength(1);
  });

  it('reports everything when the day is closed outright', async () => {
    await book('2026-06-09T10:00:00-05:00');
    await upsertDateOverride(prisma, { businessId, providerId: danaId, day: DAY, isClosed: true, windows: [] }, STAMP);
    expect(await appointmentsOutsideHours(prisma, { businessId, providerId: danaId, day: DAY })).toHaveLength(1);
  });
});

describe('AVAIL-05 — deactivating a provider (operator S-2)', () => {
  it('lists everything still ahead of her', async () => {
    await book('2026-06-09T10:00:00-05:00');
    await book('2026-06-09T14:00:00-05:00');

    const stranded = await futureAppointments(prisma, { businessId, providerId: danaId, from: NOW });
    expect(stranded).toHaveLength(2);
  });

  it('leaves the past alone', async () => {
    await book('2026-06-09T10:00:00-05:00');
    const stranded = await futureAppointments(prisma, { businessId, providerId: danaId, from: at('2026-06-10T00:00:00-05:00') });
    expect(stranded).toEqual([]);
  });
});

describe('operator R-7 — the acknowledgment', () => {
  const absence = {
    startAt: at('2026-06-09T09:00:00-05:00'),
    endAt: at('2026-06-09T17:00:00-05:00'),
  };

  it('stores "we rang her, she is coming anyway" with a reason', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00');
    await acknowledgeConflict(prisma, {
      appointmentId: appointment.id,
      businessId,
      reason: 'called her, coming anyway',
      actor: ACTOR,
      now: NOW,
    });

    const [conflict] = await appointmentsInRange(prisma, { businessId, providerId: danaId, ...absence });
    expect(conflict?.acknowledgedAt).not.toBeNull();
    expect(conflict?.acknowledgedReason).toBe('called her, coming anyway');
  });

  it('records the acknowledgment in the event log', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00');
    await acknowledgeConflict(prisma, { appointmentId: appointment.id, businessId, reason: 'she knows', actor: ACTOR, now: NOW });

    const event = await prisma.appointmentEvent.findFirstOrThrow({ where: { type: 'conflict_acknowledged' } });
    expect(event.reason).toBe('she knows');
  });

  /**
   * THE R-7 RULE. An acknowledgment is about ONE conflict. When the absence
   * changes, that conflict is a different conflict — and a stale flag hides a
   * client behind a decision about a situation that no longer exists.
   */
  it('is cleared when a NEW overlapping absence is recorded', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00');
    await createTimeOff(prisma, { businessId, providerId: danaId, ...absence, reason: 'sick' }, STAMP);
    await acknowledgeConflict(prisma, { appointmentId: appointment.id, businessId, reason: 'called her', actor: ACTOR, now: NOW });

    // The day changes again — she is off the whole week now.
    await createTimeOff(
      prisma,
      { businessId, providerId: danaId, startAt: at('2026-06-09T08:00:00-05:00'), endAt: at('2026-06-12T18:00:00-05:00'), reason: 'still sick' },
      STAMP,
    );

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.conflictAckAt).toBeNull();
    expect(row.conflictAckReason).toBeNull();
  });

  it('is cleared when the absence is REMOVED', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00');
    const timeOff = await createTimeOff(prisma, { businessId, providerId: danaId, ...absence, reason: 'sick' }, STAMP);
    await acknowledgeConflict(prisma, { appointmentId: appointment.id, businessId, reason: 'called her', actor: ACTOR, now: NOW });

    await deleteTimeOff(prisma, timeOff.id);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.conflictAckAt).toBeNull();
  });

  it('does not clear an acknowledgment about a different time', async () => {
    const morning = await book('2026-06-09T10:00:00-05:00');
    await acknowledgeConflict(prisma, { appointmentId: morning.id, businessId, reason: 'sorted', actor: ACTOR, now: NOW });

    // An afternoon absence has nothing to do with the morning's conflict.
    await createTimeOff(
      prisma,
      { businessId, providerId: danaId, startAt: at('2026-06-09T15:00:00-05:00'), endAt: at('2026-06-09T17:00:00-05:00'), reason: 'dentist' },
      STAMP,
    );

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: morning.id } });
    expect(row.conflictAckAt).not.toBeNull();
  });
});

describe('AVAIL-05 — reassigning', () => {
  it('moves the appointment to another provider, keeping its id and time', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00');

    const outcome = await reassignAppointment(prisma, {
      businessId,
      appointmentId: appointment.id,
      toProviderId: priyaId,
      actor: ACTOR,
      reason: 'Dana off sick',
    });

    expect(outcome.ok).toBe(true);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.providerId).toBe(priyaId);
    // The time did not move, so the client may not need telling at all.
    expect(row.startAt.toISOString()).toBe(at('2026-06-09T10:00:00-05:00').toISOString());
  });

  it('records a provider change in the log (APPT-07)', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00');
    await reassignAppointment(prisma, { businessId, appointmentId: appointment.id, toProviderId: priyaId, actor: ACTOR, reason: 'sick' });

    const event = await prisma.appointmentEvent.findFirstOrThrow({ where: { type: 'provider_changed' } });
    expect((event.payload as { toProviderId: string }).toProviderId).toBe(priyaId);
    expect(event.reason).toBe('sick');
  });

  /** "Where qualified" is the operative half of the bulk action's name. */
  it('refuses a provider who cannot do the service', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00'); // a Cut
    const outcome = await reassignAppointment(prisma, { businessId, appointmentId: appointment.id, toProviderId: marcusId, actor: ACTOR });

    expect(outcome).toMatchObject({ ok: false, failure: 'not-qualified' });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.providerId).toBe(danaId);
  });

  it('refuses a provider who must do the WHOLE visit', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00', { serviceIds: [cutId, colourId] });
    // Priya does cuts but not colour.
    const outcome = await reassignAppointment(prisma, { businessId, appointmentId: appointment.id, toProviderId: priyaId, actor: ACTOR });
    expect(outcome).toMatchObject({ ok: false, failure: 'not-qualified' });
  });

  /** The database decides, not a check here — so a bulk reassign cannot
   *  half-succeed into a double-book. */
  it('refuses when the new provider is already busy then', async () => {
    const hers = await book('2026-06-09T10:00:00-05:00');
    await book('2026-06-09T10:00:00-05:00', { providerId: priyaId, idempotencyKey: 'priya-busy' });

    const outcome = await reassignAppointment(prisma, { businessId, appointmentId: hers.id, toProviderId: priyaId, actor: ACTOR });
    expect(outcome).toMatchObject({ ok: false, failure: 'provider-busy' });
  });

  it('refuses a deactivated provider', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00');
    await prisma.provider.update({ where: { id: priyaId }, data: { active: false } });

    const outcome = await reassignAppointment(prisma, { businessId, appointmentId: appointment.id, toProviderId: priyaId, actor: ACTOR });
    expect(outcome).toMatchObject({ ok: false, failure: 'not-active' });
  });

  it('clears any acknowledgment, because the conflict it was about is gone', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00');
    await acknowledgeConflict(prisma, { appointmentId: appointment.id, businessId, reason: 'called her', actor: ACTOR, now: NOW });

    await reassignAppointment(prisma, { businessId, appointmentId: appointment.id, toProviderId: priyaId, actor: ACTOR });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.conflictAckAt).toBeNull();
  });

  /**
   * "Three reassigned to Priya, six kept-flagged" — the demo checkpoint's own
   * words. A bulk action that rolled back because of one awkward 2pm would
   * make the front desk do all nine by hand.
   */
  it('reassigns what it can and reports what it could not', async () => {
    const first = await book('2026-06-09T10:00:00-05:00');
    const second = await book('2026-06-09T12:00:00-05:00');
    const colourVisit = await book('2026-06-09T14:00:00-05:00', { serviceIds: [colourId] });

    const outcomes = await reassignMany(prisma, {
      businessId,
      appointmentIds: [first.id, second.id, colourVisit.id],
      toProviderId: priyaId,
      actor: ACTOR,
      reason: 'Dana off sick',
    });

    expect(outcomes.filter((o) => o.ok)).toHaveLength(2);
    expect(outcomes.find((o) => !o.ok)).toMatchObject({ appointmentId: colourVisit.id, failure: 'not-qualified' });

    // And the two that moved really moved.
    const rows = await prisma.appointment.findMany({ where: { providerId: priyaId } });
    expect(rows).toHaveLength(2);
  });
});

/**
 * A-036 (operator P-5) — THE MOVE THE CLIENT WAS NEVER TOLD ABOUT.
 *
 * Booking, rescheduling and pushing the column all enqueued a row. A bulk
 * reassign — the one that happens on the day a stylist calls in sick, to nine
 * people at once — enqueued nothing, which is precisely the silent change
 * AVAIL-05 says never happens.
 */
describe('A-036 — a reassign tells the client', () => {
  const noticesFor = (appointmentId: string) =>
    prisma.notificationOutbox.findMany({ where: { appointmentId, template: 'appointment.provider_changed' } });

  it('enqueues one notice per moved appointment, carrying the desk\u2019s reason', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00');
    const outcome = await reassignAppointment(prisma, {
      businessId,
      appointmentId: appointment.id,
      toProviderId: priyaId,
      actor: ACTOR,
      reason: 'Dana off sick',
    });

    expect(outcome.notified).toBe(true);
    const [notice, ...rest] = await noticesFor(appointment.id);
    expect(rest).toHaveLength(0);
    if (!notice) throw new Error('no notice was enqueued');
    expect(notice.recipient).toBe('5125550101');
    expect(notice.status).toBe('pending');
    expect(notice.payload).toMatchObject({ providerName: 'Priya', reason: 'Dana off sick' });
  });

  /** The desk that rang her first. A text arriving after the call contradicts
   *  a person she just spoke to. */
  it('sends nothing when the desk says it already rang her', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00');
    const outcome = await reassignAppointment(prisma, {
      businessId,
      appointmentId: appointment.id,
      toProviderId: priyaId,
      actor: ACTOR,
      notify: false,
    });

    expect(outcome.notified).toBe(false);
    expect(await noticesFor(appointment.id)).toHaveLength(0);
  });

  /** The whole point of enqueuing INSIDE the transaction: a move that could
   *  not commit must not leave a message promising it did. */
  it('leaves no notice behind for a move the database refused', async () => {
    const hers = await book('2026-06-09T10:00:00-05:00');
    await book('2026-06-09T10:00:00-05:00', { providerId: priyaId, idempotencyKey: 'priya-busy' });

    const outcome = await reassignAppointment(prisma, { businessId, appointmentId: hers.id, toProviderId: priyaId, actor: ACTOR });

    expect(outcome).toMatchObject({ ok: false, failure: 'provider-busy' });
    expect(await noticesFor(hers.id)).toHaveLength(0);
  });

  it('tells the two who moved and not the one who could not', async () => {
    const first = await book('2026-06-09T10:00:00-05:00');
    const second = await book('2026-06-09T12:00:00-05:00');
    const colourVisit = await book('2026-06-09T14:00:00-05:00', { serviceIds: [colourId] });

    await reassignMany(prisma, {
      businessId,
      appointmentIds: [first.id, second.id, colourVisit.id],
      toProviderId: priyaId,
      actor: ACTOR,
      reason: 'Dana off sick',
    });

    const notified = await prisma.notificationOutbox.findMany({
      where: { template: 'appointment.provider_changed' },
      select: { appointmentId: true },
    });
    expect(notified.map((n) => n.appointmentId).sort()).toEqual([first.id, second.id].sort());
  });

  /** The conflicts screen's "who has been told" column (operator R-4's index,
   *  asked from the other side). */
  it('surfaces the last thing she was told on the conflict row', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00');
    await createTimeOff(
      prisma,
      { businessId, providerId: danaId, startAt: at('2026-06-09T09:00:00-05:00'), endAt: at('2026-06-09T17:00:00-05:00'), reason: 'sick' },
      STAMP,
    );

    // Booking already told her once (A-009), so the column is never empty for
    // a real appointment — it shows the LATEST thing, which is the whole point.
    const before = await conflictsForDay(prisma, { businessId, day: DAY });
    expect(before.find((c) => c.id === appointment.id)?.lastNotice).toMatchObject({
      template: 'appointment.confirmed',
    });

    await enqueueNotification(prisma, {
      businessId,
      dedupeKey: `test-notice:${appointment.id}`,
      appointmentId: appointment.id,
      channel: 'sms',
      template: 'appointment.running_late',
      recipient: '5125550101',
      payload: {},
    });

    const after = await conflictsForDay(prisma, { businessId, day: DAY });
    expect(after.find((c) => c.id === appointment.id)?.lastNotice).toMatchObject({
      template: 'appointment.running_late',
      status: 'pending',
    });
  });
});

/**
 * A-034 — THE THIRD WRITE PATH, AND WHY IT NEEDED NO CHANGE.
 *
 * The backlog row named `reassignAppointment` alongside the reschedule and the
 * column push, on the ground that all three carry `resourceId` forward
 * unchanged. Carrying it forward is only a defect when the ENVELOPE moves: a
 * reassign changes the provider and nothing else, so the hold the trigger
 * rewrites is the identical chair over the identical range, and re-running the
 * chooser here could only ever churn a client into a different chair for no
 * reason. This test is the claim, so a later change that makes a reassign move
 * the time fails here rather than at a customer's chair.
 */
describe('A-034 — a reassign moves no chair, because it moves no time', () => {
  let chairId: string;

  beforeEach(async () => {
    const chairType = await prisma.resourceType.create({ data: { businessId, name: 'Chair' } });
    chairId = (
      await prisma.resource.create({ data: { businessId, resourceTypeId: chairType.id, name: 'Chair 1' } })
    ).id;
    await prisma.service.update({ where: { id: cutId }, data: { requiredResourceTypeId: chairType.id } });
  });

  it('keeps the chair and its hold exactly where they were', async () => {
    const appointment = await book('2026-06-09T10:00:00-05:00');
    const before = await prisma.appointmentResourceHold.findUniqueOrThrow({
      where: { appointmentId: appointment.id },
    });
    expect(before.resourceId).toBe(chairId);

    const outcome = await reassignAppointment(prisma, {
      businessId,
      appointmentId: appointment.id,
      toProviderId: priyaId,
      actor: ACTOR,
      reason: 'Dana off sick',
    });

    expect(outcome.ok).toBe(true);
    const after = await prisma.appointmentResourceHold.findUniqueOrThrow({
      where: { appointmentId: appointment.id },
    });
    expect(after.resourceId).toBe(chairId);
    expect(after.blockedStart.toISOString()).toBe(before.blockedStart.toISOString());
    expect(after.blockedEnd.toISOString()).toBe(before.blockedEnd.toISOString());
  });
});
