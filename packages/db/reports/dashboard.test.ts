/**
 * A-024 — the owner dashboard (RPT-01, RPT-02, RPT-03).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { staffActor } from '../../core/auth';
import { transitionAppointment } from '../appointments';
import { bookAppointment } from '../booking';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { seedSetup } from '../settings';
import { dashboardSummary, listReportAppointments } from './dashboard';

const prisma = new PrismaClient();
const ACTOR = staffActor('staff-1');
const at = (iso: string) => toDate(instantFromIso(iso));

let businessId: string;
let danaId: string;
let priyaId: string;
let marcusId: string;
let cutId: string;
let clientId: string;

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
  danaId = setup.providerIds[0]!;
  priyaId = setup.providerIds[1]!;
  marcusId = setup.providerIds[2]!;
  cutId = setup.serviceIds[0]!;
  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;
});

const book = (startIso: string, providerId: string) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [cutId],
    clientId,
    startAt: at(startIso),
    now: at('2026-06-08T08:00:00-05:00'),
    actor: ACTOR,
    audience: 'staff',
    idempotencyKey: `${startIso}-${providerId}`,
  });

const complete = async (appointmentId: string, at_: string) => {
  for (const to of ['checked_in', 'in_progress', 'completed'] as const) {
    await transitionAppointment(prisma, { appointmentId, to, actor: ACTOR, now: at(at_) });
  }
};

describe('dashboardSummary', () => {
  it('counts bookings, splits cancels normal/late, and groups no-shows by provider', async () => {
    const completed = await book('2026-06-09T09:00:00-05:00', danaId);
    const noShowDana = await book('2026-06-09T11:00:00-05:00', danaId);
    // Left `booked` — counts toward "bookings" but neither cancels nor no-shows.
    await book('2026-06-10T09:00:00-05:00', danaId);
    const cancelled = await book('2026-06-10T11:00:00-05:00', danaId);
    const cancelledLate = await book('2026-06-11T09:00:00-05:00', danaId);
    const noShowPriya = await book('2026-06-09T09:00:00-05:00', priyaId);

    await complete(completed.id, '2026-06-09T18:00:00-05:00');
    await transitionAppointment(prisma, { appointmentId: noShowDana.id, to: 'no_show', actor: ACTOR, now: at('2026-06-09T18:00:00-05:00') });
    await transitionAppointment(prisma, { appointmentId: noShowPriya.id, to: 'no_show', actor: ACTOR, now: at('2026-06-09T18:00:00-05:00') });
    await transitionAppointment(prisma, { appointmentId: cancelled.id, to: 'cancelled', actor: ACTOR, now: at('2026-06-08T08:00:00-05:00'), reason: 'plans changed' });
    await transitionAppointment(prisma, { appointmentId: cancelledLate.id, to: 'cancelled_late', actor: ACTOR, now: at('2026-06-08T08:00:00-05:00') });

    const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-09' });

    expect(summary.fromDay).toBe('2026-06-08');
    expect(summary.toDay).toBe('2026-06-14');
    expect(summary.bookings).toBe(6);
    expect(summary.cancels).toEqual({ normal: 1, late: 1 });
    expect(summary.noShowsByProvider).toEqual(
      expect.arrayContaining([
        { providerId: danaId, providerName: 'Dana', count: 1 },
        { providerId: priyaId, providerName: 'Priya', count: 1 },
      ]),
    );
    // Nobody was booked on Marcus or Tess this week — no-show count is
    // filtered to providers who actually had one, not padded with zeros.
    expect(summary.noShowsByProvider).toHaveLength(2);
  });

  it("a provider with availability but nothing completed reads 0%, not n/a — those are different facts", async () => {
    const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-09' });
    const marcus = summary.utilizationByProvider.find((p) => p.providerId === marcusId)!;
    expect(marcus.utilization).toBe(0);
  });

  it('utilization counts completed/no-show minutes only — a merely-booked appointment contributes nothing', async () => {
    const completed = await book('2026-06-09T09:00:00-05:00', danaId); // Cut = 45 + 10 buffer minutes; BODY is 45.
    await complete(completed.id, '2026-06-09T18:00:00-05:00');
    await book('2026-06-10T09:00:00-05:00', danaId); // left `booked` — must not count

    const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-09' });
    const dana = summary.utilizationByProvider.find((p) => p.providerId === danaId)!;
    // The setup seed gives every provider 09:00-17:00 with a 12:00-13:00
    // break, Tue-Sat: 7 working hours/day × 5 days = 2100 minutes/week. One
    // completed 45-minute Cut (body only, no buffer) is 45/2100.
    expect(dana.utilization).toBeCloseTo(45 / 2100, 10);
  });
});

describe('listReportAppointments', () => {
  it('is the filtered list every tile drills into (RPT-01)', async () => {
    const cancelled = await book('2026-06-09T09:00:00-05:00', danaId);
    const cancelledLate = await book('2026-06-10T09:00:00-05:00', danaId);
    await book('2026-06-11T09:00:00-05:00', danaId); // left booked, excluded by the filter below
    await transitionAppointment(prisma, { appointmentId: cancelled.id, to: 'cancelled', actor: ACTOR, now: at('2026-06-08T08:00:00-05:00'), reason: 'x' });
    await transitionAppointment(prisma, { appointmentId: cancelledLate.id, to: 'cancelled_late', actor: ACTOR, now: at('2026-06-08T08:00:00-05:00') });

    const rows = await listReportAppointments(prisma, {
      businessId,
      fromDay: '2026-06-08',
      toDay: '2026-06-14',
      statuses: ['cancelled', 'cancelled_late'],
    });

    expect(rows.map((r) => r.id).sort()).toEqual([cancelled.id, cancelledLate.id].sort());
  });

  it('filters by provider too', async () => {
    const danaNoShow = await book('2026-06-09T09:00:00-05:00', danaId);
    await book('2026-06-09T09:00:00-05:00', priyaId);
    await transitionAppointment(prisma, { appointmentId: danaNoShow.id, to: 'no_show', actor: ACTOR, now: at('2026-06-09T18:00:00-05:00') });
    const otherProviderNoShow = await book('2026-06-09T11:00:00-05:00', priyaId);
    await transitionAppointment(prisma, { appointmentId: otherProviderNoShow.id, to: 'no_show', actor: ACTOR, now: at('2026-06-09T18:00:00-05:00') });

    const rows = await listReportAppointments(prisma, {
      businessId,
      fromDay: '2026-06-08',
      toDay: '2026-06-14',
      statuses: ['no_show'],
      providerId: danaId,
    });

    expect(rows.map((r) => r.id)).toEqual([danaNoShow.id]);
  });
});
