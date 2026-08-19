/**
 * A-022 against a real database (NOTIF-02, NOTIF-03).
 *
 * The DST instant is taken verbatim from docs/reviews/03-slot-engine-spec.md
 * §3 row X-3 (CLAUDE.md: do not re-derive by hand).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromDate, instant, instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { issueManageToken } from '../appointments/manage-token';
import { sendDueReminders } from './reminders';

const prisma = new PrismaClient();

const at = (iso: string) => toDate(instantFromIso(iso));

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
  delete process.env.NOTIFICATIONS_ENABLED;
  delete process.env.NOTIFICATIONS_SANDBOX_TO;

  const business = await prisma.business.create({ data: { name: 'Shear Genius', timezone: 'America/Chicago' } });
  businessId = business.id;
  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  providerId = dana.id;
  const cut = await prisma.service.create({ data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 } });
  serviceId = cut.id;
  await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId } });
  clientId = (
    await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101', email: 'ada@example.test' } })
  ).id;
});

async function seed(options: { startAt: Date; status?: string }) {
  const endAt = toDate(instantFromIso('2026-06-09T11:00:00-05:00'));
  return prisma.appointment.create({
    data: {
      businessId,
      providerId,
      clientId,
      status: (options.status ?? 'booked') as 'booked',
      startAt: options.startAt,
      endAt,
      blockedStart: options.startAt,
      blockedEnd: endAt,
      startDay: '2026-06-09',
      startWallTime: '10:00',
      lines: { create: { businessId, serviceId, ordinal: 0, priceCents: 5500, durationMinutes: 60 } },
    },
  });
}

describe('sendDueReminders — the window (X-3, X-4)', () => {
  const NOW = at('2026-06-08T08:00:00-05:00');

  it('finds an appointment exactly 24h out, and writes a reminder carrying a working link', async () => {
    const appointment = await seed({ startAt: at('2026-06-09T08:00:00-05:00') });

    const result = await sendDueReminders(prisma, NOW);

    expect(result).toEqual({ due: 1, enqueued: 1, duplicate: 0 });

    const row = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { dedupeKey: `reminder-24h:${appointment.id}:${fromDate(appointment.startAt)}` },
    });
    expect(row.template).toBe('appointment.reminder');
    expect(row.appointmentId).toBe(appointment.id);
    expect(row.recipient).toBe('ada@example.test'); // email preferred over phone
    const payload = row.payload as { manageUrl: string };
    expect(payload.manageUrl).toMatch(/^\/manage\/.+/);
  });

  it('excludes an appointment starting one millisecond before the window opens', async () => {
    await seed({ startAt: toDate(instant(instantFromIso('2026-06-09T08:00:00-05:00') - 1)) });

    expect(await sendDueReminders(prisma, NOW)).toEqual({ due: 0, enqueued: 0, duplicate: 0 });
  });

  it('excludes an appointment starting exactly at the window’s exclusive end', async () => {
    await seed({ startAt: at('2026-06-09T08:05:00-05:00') });

    expect(await sendDueReminders(prisma, NOW)).toEqual({ due: 0, enqueued: 0, duplicate: 0 });
  });

  it('is a physical 24 hours across spring-forward, not a calendar day (X-3)', async () => {
    // A 09:00 CDT appointment on the day AFTER the transition, reminded from
    // the day BEFORE it — the spec's own verified instants.
    const dstNow = at('2026-03-07T08:00:00-06:00'); // 14:00Z, 08:00 CST
    const appointment = await seed({ startAt: at('2026-03-08T09:00:00-05:00') }); // 14:00Z, 09:00 CDT

    const result = await sendDueReminders(prisma, dstNow);

    expect(result).toEqual({ due: 1, enqueued: 1, duplicate: 0 });
    expect(
      await prisma.notificationOutbox.count({
        where: { dedupeKey: `reminder-24h:${appointment.id}:${fromDate(appointment.startAt)}` },
      }),
    ).toBe(1);
  });

  it.each(['confirmed'])('also reminds a %s appointment', async (status) => {
    await seed({ startAt: at('2026-06-09T08:00:00-05:00'), status });

    expect((await sendDueReminders(prisma, NOW)).enqueued).toBe(1);
  });

  it.each(['cancelled', 'cancelled_late', 'no_show', 'completed', 'checked_in', 'in_progress'])(
    'skips a %s appointment — only booked/confirmed are due',
    async (status) => {
      await seed({ startAt: at('2026-06-09T08:00:00-05:00'), status });

      expect(await sendDueReminders(prisma, NOW)).toEqual({ due: 0, enqueued: 0, duplicate: 0 });
    },
  );

  it('skips a row whose startAt no longer falls in the window — rescheduled-away, D-6', async () => {
    const appointment = await seed({ startAt: at('2026-06-09T08:00:00-05:00') });
    // D-6: reschedule is a same-row UPDATE. Simulated directly here because
    // the job has no reschedule-specific code path to exercise — it is
    // oblivious to HOW startAt changed, which is the whole point.
    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { startAt: at('2026-06-10T08:00:00-05:00'), endAt: at('2026-06-10T09:00:00-05:00') },
    });

    expect(await sendDueReminders(prisma, NOW)).toEqual({ due: 0, enqueued: 0, duplicate: 0 });
  });
});

describe('sendDueReminders — exactly-once (P1-7)', () => {
  const NOW = at('2026-06-08T08:00:00-05:00');

  it('re-running for the same now is a no-op the second time', async () => {
    await seed({ startAt: at('2026-06-09T08:00:00-05:00') });

    expect(await sendDueReminders(prisma, NOW)).toEqual({ due: 1, enqueued: 1, duplicate: 0 });
    expect(await sendDueReminders(prisma, NOW)).toEqual({ due: 1, enqueued: 0, duplicate: 1 });

    expect(await prisma.notificationOutbox.count({ where: { template: 'appointment.reminder' } })).toBe(1);
  });

  it('does not reissue the manage token on the duplicate run', async () => {
    await seed({ startAt: at('2026-06-09T08:00:00-05:00') });

    await sendDueReminders(prisma, NOW);
    const liveAfterFirst = await prisma.manageToken.findMany({ where: { revokedAt: null } });
    await sendDueReminders(prisma, NOW);
    const liveAfterSecond = await prisma.manageToken.findMany({ where: { revokedAt: null } });

    expect(liveAfterSecond.map((t) => t.id)).toEqual(liveAfterFirst.map((t) => t.id));
  });

  it('a reschedule to a NEW time inside a later window produces a second, distinct reminder', async () => {
    const appointment = await seed({ startAt: at('2026-06-09T08:00:00-05:00') });
    expect((await sendDueReminders(prisma, NOW)).enqueued).toBe(1);

    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { startAt: at('2026-06-10T08:00:00-05:00'), endAt: at('2026-06-10T09:00:00-05:00') },
    });
    const nextDay = at('2026-06-09T08:00:00-05:00'); // now + 24h = the NEW startAt

    expect((await sendDueReminders(prisma, nextDay)).enqueued).toBe(1);
    expect(await prisma.notificationOutbox.count({ where: { template: 'appointment.reminder' } })).toBe(2);
  });
});

describe('sendDueReminders — the link (D-28)', () => {
  const NOW = at('2026-06-08T08:00:00-05:00');

  it('reissues the manage token — the ORIGINAL confirmation link stops working, and that is intended', async () => {
    const appointment = await seed({ startAt: at('2026-06-09T08:00:00-05:00') });
    await issueManageToken(prisma, {
      businessId,
      appointmentId: appointment.id,
      endAt: appointment.endAt,
      now: NOW,
    });
    const originalId = (await prisma.manageToken.findFirstOrThrow({ where: { appointmentId: appointment.id } })).id;

    await sendDueReminders(prisma, NOW);

    const originalRow = await prisma.manageToken.findUniqueOrThrow({ where: { id: originalId } });
    expect(originalRow.revokedAt).not.toBeNull();

    const live = await prisma.manageToken.findMany({ where: { appointmentId: appointment.id, revokedAt: null } });
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(originalId);
  });
});
