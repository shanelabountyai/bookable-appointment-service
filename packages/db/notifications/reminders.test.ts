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
import type { ChannelAdapter, OutboundMessage, SendResult } from '../../core/notifications';
import { dispatchPendingNotifications } from './dispatch';
import { enqueueNotification } from './enqueue';
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

  /**
   * A-054 (demo checkpoint 4, D-38) CHANGED WHAT THIS ASSERTS, and the change
   * is the finding.
   *
   * It used to assert that the reminder REVOKES her confirmation link — D-28's
   * stated intent, whose argument ends "the reminder always carries a fresh
   * link, so nothing is left dangling". That premise is about DELIVERY and
   * this code is about ENQUEUING. The walk revoked her link here, failed the
   * reminder permanently at the provider, and left her holding a dead link
   * with no replacement — A-048's harm through the other door.
   */
  it('mints a fresh link WITHOUT killing the one she is already holding (D-38)', async () => {
    const appointment = await seed({ startAt: at('2026-06-09T08:00:00-05:00') });
    await issueManageToken(prisma, {
      businessId,
      appointmentId: appointment.id,
      endAt: appointment.endAt,
      now: NOW,
    });
    const originalId = (await prisma.manageToken.findFirstOrThrow({ where: { appointmentId: appointment.id } })).id;

    await sendDueReminders(prisma, NOW);

    // Still live: a revocation is a promise that a replacement is in her
    // hands, and at enqueue time nobody can make that promise.
    const originalRow = await prisma.manageToken.findUniqueOrThrow({ where: { id: originalId } });
    expect(originalRow.revokedAt).toBeNull();

    // And the reminder still carries a link of its own — D-28's other half is
    // untouched, because the raw token of the first can never be recovered.
    const live = await prisma.manageToken.findMany({ where: { appointmentId: appointment.id, revokedAt: null } });
    expect(live).toHaveLength(2);
    expect(live.map((t) => t.id)).toContain(originalId);
  });

  /** Everything that is NOT the reminder still revokes on reissue — D-38
   *  narrows D-28 to one caller, it does not repeal it. */
  it('leaves revoke-on-reissue alone for every other caller', async () => {
    const appointment = await seed({ startAt: at('2026-06-09T08:00:00-05:00') });
    await issueManageToken(prisma, { businessId, appointmentId: appointment.id, endAt: appointment.endAt, now: NOW });
    const firstId = (await prisma.manageToken.findFirstOrThrow({ where: { appointmentId: appointment.id } })).id;

    await issueManageToken(prisma, { businessId, appointmentId: appointment.id, endAt: appointment.endAt, now: NOW });

    expect((await prisma.manageToken.findUniqueOrThrow({ where: { id: firstId } })).revokedAt).not.toBeNull();
  });
});

/**
 * A-054 (demo checkpoint 4) — A MESSAGE THAT STOPPED BEING TRUE.
 *
 * Deciding and sending are separate steps, and the world moves between them.
 * Walked at the seam: an appointment cancelled a minute after its reminder was
 * enqueued produced both the cancellation notice AND, after it, a reminder for
 * the appointment she had just cancelled.
 */
describe('the reminder that is no longer true (A-054)', () => {
  const NOW = at('2026-06-08T08:00:00-05:00');

  class Recorder implements ChannelAdapter {
    readonly id = 'recorder';
    readonly sent: OutboundMessage[] = [];
    supports(): boolean {
      return true;
    }
    async send(message: OutboundMessage): Promise<SendResult> {
      this.sent.push(message);
      return { externalId: 'rec-1' };
    }
  }

  const templatesSent = (adapter: Recorder) => adapter.sent.map((m) => m.template);

  it('does not remind a client who has cancelled', async () => {
    const appointment = await seed({ startAt: at('2026-06-09T08:00:00-05:00') });
    await sendDueReminders(prisma, NOW);

    await prisma.appointment.update({ where: { id: appointment.id }, data: { status: 'cancelled' } });

    const adapter = new Recorder();
    const result = await dispatchPendingNotifications(prisma, adapter, 100, NOW);
    expect(templatesSent(adapter)).not.toContain('appointment.reminder');
    expect(result.suppressed).toBe(1);

    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { template: 'appointment.reminder' } });
    expect(row.status).toBe('suppressed');
    // The reason a person can act on, on A-051's screen.
    expect(row.lastError).toBe('stale:the appointment is cancelled');
  });

  /**
   * A-051's backoff is what turns this from a race into a window: a transient
   * provider failure legitimately holds a row for up to two and a half hours,
   * and the walk sent a reminder naming Tuesday for an appointment that had
   * moved to Wednesday.
   */
  it('does not remind about a time the appointment has moved away from', async () => {
    const appointment = await seed({ startAt: at('2026-06-09T08:00:00-05:00') });
    await sendDueReminders(prisma, NOW);

    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { startAt: at('2026-06-10T08:00:00-05:00'), endAt: at('2026-06-10T09:00:00-05:00') },
    });

    const adapter = new Recorder();
    await dispatchPendingNotifications(prisma, adapter, 100, NOW);
    expect(templatesSent(adapter)).not.toContain('appointment.reminder');
    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { template: 'appointment.reminder' } });
    expect(row.lastError).toBe('stale:the appointment moved to a different time');
  });

  /** Nothing changed, so it goes — the check must not eat the ordinary case. */
  it('still sends a reminder that is still true', async () => {
    await seed({ startAt: at('2026-06-09T08:00:00-05:00') });
    await sendDueReminders(prisma, NOW);

    const adapter = new Recorder();
    await dispatchPendingNotifications(prisma, adapter, 100, NOW);
    expect(templatesSent(adapter)).toContain('appointment.reminder');
  });

  /**
   * ONLY the reminder can go stale, and that is a property of what it says.
   * A cancellation notice reports something that HAPPENED — still true when
   * it arrives late, and suppressing it would be the silence this product is
   * the opposite of.
   */
  it('still sends a CANCELLATION notice for a cancelled appointment', async () => {
    const appointment = await seed({ startAt: at('2026-06-09T08:00:00-05:00') });
    await prisma.appointment.update({ where: { id: appointment.id }, data: { status: 'cancelled' } });
    await enqueueNotification(prisma, {
      businessId,
      dedupeKey: `cancelled:${appointment.id}`,
      appointmentId: appointment.id,
      channel: 'email',
      template: 'appointment.cancelled',
      recipient: 'ada@example.test',
      payload: { appointmentId: appointment.id },
    });

    const adapter = new Recorder();
    await dispatchPendingNotifications(prisma, adapter, 100, NOW);
    expect(templatesSent(adapter)).toContain('appointment.cancelled');
  });
});
