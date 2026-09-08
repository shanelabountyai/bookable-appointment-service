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
/** Monday of the 2026-06-08..14 week every test below reports on — so that
 *  week is the CURRENT one unless a test deliberately looks further out. */
const NOW = at('2026-06-08T08:00:00-05:00');

let businessId: string;
let danaId: string;
let priyaId: string;
let marcusId: string;
let tessId: string;
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
  tessId = setup.providerIds[3]!;
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

    const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-09', now: NOW });

    expect(summary.fromDay).toBe('2026-06-08');
    expect(summary.toDay).toBe('2026-06-14');
    expect(summary.bookings).toBe(6);
    expect(summary.cancels).toEqual({ normal: 1, late: 1, overruled: 0 });
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
    const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-09', now: NOW });
    const marcus = summary.utilizationByProvider.find((p) => p.providerId === marcusId)!;
    expect(marcus.utilization).toBe(0);
  });

  it('utilization counts completed/no-show minutes only — a merely-booked appointment contributes nothing', async () => {
    const completed = await book('2026-06-09T09:00:00-05:00', danaId); // Cut = 45 + 10 buffer minutes; BODY is 45.
    await complete(completed.id, '2026-06-09T18:00:00-05:00');
    await book('2026-06-10T09:00:00-05:00', danaId); // left `booked` — must not count

    const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-09', now: NOW });
    const dana = summary.utilizationByProvider.find((p) => p.providerId === danaId)!;
    // The setup seed gives every provider 09:00-17:00 with a 12:00-13:00
    // break, Tue-Sat: 7 working hours/day × 5 days = 2100 minutes/week. One
    // completed 45-minute Cut (body only, no buffer) is 45/2100.
    expect(dana.utilization).toBeCloseTo(45 / 2100, 10);
  });

  /**
   * A-101 (D-51) — THE WEEK THE DASHBOARD OPENS ON.
   *
   * RPT-02's formula is frozen and these tests do not touch it. What they
   * assert is the thing nobody ever specified: that the tile says something
   * DIFFERENT about a week nobody could have worked yet, and that the owner
   * gets a forward number for the week they can still act on.
   *
   * Every assertion before this item was made against a week in the PAST
   * (DEMO_WEEK) or the current one, which is the only kind where a
   * retrospective number is the right answer — which is exactly why forty
   * green runs could not see 0.0% on four stylists on a Tuesday.
   */
  describe('A-101 — a week that has not been worked yet', () => {
    // Two weeks out from NOW: 2026-06-22..28, entirely ahead of it.
    const AHEAD = '2026-06-23';

    it('says the week is ahead — a fact about the CALENDAR, in the business zone', async () => {
      expect((await dashboardSummary(prisma, { businessId, anyDayInWeek: AHEAD, now: NOW })).weekIsAhead).toBe(true);
      // The current week and a past one are both NOT ahead: `now` inside the
      // week's own bounds must not be rounded the wrong way.
      expect((await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-09', now: NOW })).weekIsAhead).toBe(false);
      expect((await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-02', now: NOW })).weekIsAhead).toBe(false);
      // NOW is the Monday itself — the first instant of the week it reports.
      expect((await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-08', now: NOW })).weekIsAhead).toBe(false);
    });

    it('a booking two weeks out reads 0 worked and a real BOOKED fraction — the two facts the tile used to spell the same way', async () => {
      // Cut = 45 minutes of body. Dana's seeded hours are 09:00-17:00 Tue-Sat
      // with a 12:00-13:00 break: 2100 available minutes in the week. (The
      // other three differ — Marcus has a split Thursday clipped by the
      // salon's close, Tess takes no break — which is why only Dana's
      // denominator is spelled out anywhere.)
      await book('2026-06-23T09:00:00-05:00', danaId);

      const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: AHEAD, now: NOW });
      const dana = summary.utilizationByProvider.find((p) => p.providerId === danaId)!;

      // The frozen formula, unchanged: nothing has HAPPENED, so nothing is
      // worked. This is the number that used to be the tile's only one.
      expect(dana.utilization).toBe(0);
      // …and the number the owner is actually deciding on.
      expect(dana.booked).toBeCloseTo(45 / 2100, 10);

      // The stylist with nothing in the book is 0 on BOTH, and is not `null`:
      // she has her hours, so "n/a" would be a third wrong answer.
      const marcus = summary.utilizationByProvider.find((p) => p.providerId === marcusId)!;
      expect(marcus.utilization).toBe(0);
      expect(marcus.booked).toBe(0);
    });

    it('booked counts everything that occupies the chair and worked counts only what happened — never the other way round', async () => {
      const completed = await book('2026-06-09T09:00:00-05:00', danaId);
      await complete(completed.id, '2026-06-09T18:00:00-05:00');
      await book('2026-06-10T09:00:00-05:00', danaId); // still `booked`
      const cancelled = await book('2026-06-11T09:00:00-05:00', danaId);
      await transitionAppointment(prisma, { appointmentId: cancelled.id, to: 'cancelled', actor: ACTOR, now: at('2026-06-08T08:00:00-05:00'), reason: 'x' });

      const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-09', now: NOW });
      const dana = summary.utilizationByProvider.find((p) => p.providerId === danaId)!;

      expect(dana.utilization).toBeCloseTo(45 / 2100, 10); // the completed one only
      expect(dana.booked).toBeCloseTo(90 / 2100, 10); // …plus the one still to come
      // The cancelled one is in NEITHER: it gave its time back (D-7), which is
      // the one place the two numerators must still agree.
      expect(dana.booked).toBeLessThan(135 / 2100);
    });

    it('booked is never below worked, and the two share one denominator — both null together, never one of them', async () => {
      const completed = await book('2026-06-09T09:00:00-05:00', danaId);
      await complete(completed.id, '2026-06-09T18:00:00-05:00');
      // Tess is off the roster this week entirely: zero denominator, so RPT-02
      // renders "n/a" — and the forward number has to be n/a for the same
      // reason, not 0%, or the tile grows the conflation back on the other side.
      await prisma.weeklyWindow.deleteMany({ where: { businessId, providerId: tessId } });

      const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-09', now: NOW });
      for (const p of summary.utilizationByProvider) {
        expect(p.booked === null, `${p.providerName}: one fraction null and the other not`).toBe(p.utilization === null);
        if (p.booked !== null) expect(p.booked).toBeGreaterThanOrEqual(p.utilization!);
      }
      const tess = summary.utilizationByProvider.find((p) => p.providerId === tessId)!;
      expect(tess.utilization).toBeNull();
      expect(tess.booked).toBeNull();
    });
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
