/**
 * A-060 — the overrule drill-down (APPT-06).
 *
 * The escape beside the one Cancel button is only safe because it is
 * countable and has a name on it. These assert the two halves of that: an
 * overrule appears here with the person and the reason, and an ordinary
 * cancellation — of either kind — does not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { staffActor } from '../../core/auth';
import { transitionAppointment } from '../appointments';
import { bookAppointment } from '../booking';
import { saveStaffMember } from '../auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { seedSetup } from '../settings';
import { dashboardSummary } from './dashboard';
import { countOverruledCancellations, listOverruledCancellations } from './overruled';

const prisma = new PrismaClient();
const at = (iso: string) => toDate(instantFromIso(iso));
const WEEK = { fromDay: '2026-06-08', toDay: '2026-06-14' };

let businessId: string;
let providerId: string;
let serviceId: string;
let clientId: string;
let priya: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const setup = await seedSetup(prisma);
  businessId = setup.businessId;
  providerId = setup.providerIds[0]!;
  serviceId = setup.serviceIds[0]!;
  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;
  priya = (await saveStaffMember(prisma, { businessId, name: 'Priya', pin: '4321' })).id;
});

const book = (startIso: string) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [serviceId],
    clientId,
    startAt: at(startIso),
    now: at('2026-06-01T08:00:00-05:00'),
    actor: staffActor(priya),
    audience: 'staff',
    idempotencyKey: startIso,
  });

/** An hour before a 09:00 start — inside the seed's cutoff either way. */
const anHourBefore = (day: string) => at(`${day}T08:00:00-05:00`);

describe('A-060 — how many did we overrule, and who', () => {
  it('lists the overrule with the person, the client and the reason', async () => {
    const appointment = await book('2026-06-09T09:00:00-05:00');
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      cancellation: 'override',
      actor: staffActor(priya),
      now: anHourBefore('2026-06-09'),
      reason: 'we moved her twice already',
    });

    const rows = await listOverruledCancellations(prisma, { businessId, ...WEEK });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      appointmentId: appointment.id,
      clientName: 'Ada Chen',
      // A-037's rule: the log knows who, so the screen says who.
      staffName: 'Priya',
      reason: 'we moved her twice already',
      overruled: 'cancelled_late',
    });
    expect(await countOverruledCancellations(prisma, { businessId, ...WEEK })).toBe(1);
  });

  it('ignores cancellations the machine classified, of either kind', async () => {
    const late = await book('2026-06-09T09:00:00-05:00');
    const ontime = await book('2026-06-10T09:00:00-05:00');
    await transitionAppointment(prisma, {
      appointmentId: late.id,
      to: 'cancelled',
      cancellation: 'derive',
      actor: staffActor(priya),
      now: anHourBefore('2026-06-09'),
    });
    await transitionAppointment(prisma, {
      appointmentId: ontime.id,
      to: 'cancelled',
      cancellation: 'derive',
      actor: staffActor(priya),
      now: at('2026-06-01T08:00:00-05:00'),
    });

    expect(await listOverruledCancellations(prisma, { businessId, ...WEEK })).toEqual([]);
  });

  it('scopes by the appointment’s own day, so it reconciles with the tile it hangs off', async () => {
    const nextWeek = await book('2026-06-16T09:00:00-05:00');
    await transitionAppointment(prisma, {
      appointmentId: nextWeek.id,
      to: 'cancelled',
      cancellation: 'override',
      // Overruled DURING the week under test; the appointment is not in it.
      actor: staffActor(priya),
      now: anHourBefore('2026-06-16'),
      reason: 'our fault',
    });

    expect(await countOverruledCancellations(prisma, { businessId, ...WEEK })).toBe(0);
    expect(
      await countOverruledCancellations(prisma, { businessId, fromDay: '2026-06-15', toDay: '2026-06-21' }),
    ).toBe(1);
  });

  it('is the same number the dashboard shows', async () => {
    const appointment = await book('2026-06-09T09:00:00-05:00');
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      cancellation: 'override',
      actor: staffActor(priya),
      now: anHourBefore('2026-06-09'),
      reason: 'our fault',
    });

    const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-09' });
    // An overrule is a subset of the NORMAL cancellations, never a third bucket.
    expect(summary.cancels).toEqual({ normal: 1, late: 0, overruled: 1 });
  });
});
