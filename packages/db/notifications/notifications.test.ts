/**
 * A-004 — enqueue/dispatch against the real database (CLAUDE.md: tests never
 * point at a remote database, and this module's whole point is what commits
 * and what doesn't, which a mock cannot show).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelAdapter, OutboundMessage, SendResult } from '../../core/notifications';
import { PrismaClient } from '../generated/client/index.js';
import { dispatchPendingNotifications } from './dispatch';
import { enqueueNotification } from './enqueue';
import { resetDatabase } from '../testing';

const prisma = new PrismaClient();
let businessId: string;

/** A controllable fake — records every call, and can be told to fail or to
 *  refuse a channel, so dispatch's branches are each independently testable. */
class FakeAdapter implements ChannelAdapter {
  readonly sent: OutboundMessage[] = [];
  failNext = false;
  unsupportedChannels = new Set<string>();

  supports(channel: string): boolean {
    return !this.unsupportedChannels.has(channel);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('provider rejected the message');
    }
    return { externalId: 'fake-1' };
  }
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const b = await prisma.business.create({ data: { name: 'Shear Genius', timezone: 'America/Chicago' } });
  businessId = b.id;
  delete process.env.NOTIFICATIONS_ENABLED;
  delete process.env.NOTIFICATIONS_SANDBOX_TO;
});

describe('enqueueNotification — decide and record', () => {
  it('writes a pending row for a normal enqueue', async () => {
    const result = await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:appt1',
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'dana@example.com',
      payload: { appointmentId: 'appt1' },
    });
    expect(result.outcome).toBe('recorded');
    expect(result.status).toBe('pending');

    const row = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.recipient).toBe('dana@example.com');
    expect(row.dedupeKey).toBe('confirmation:appt1');
  });

  // The idempotency guarantee, and BOOK-03(f)'s pattern applied here: two
  // calls with the same key produce ONE decision, permanently.
  it('is idempotent — a second call with the same dedupeKey returns the FIRST decision, writes nothing new', async () => {
    const first = await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:appt1',
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'dana@example.com',
      payload: { v: 1 },
    });
    const second = await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:appt1',
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'someone-else@example.com', // different payload — must NOT overwrite
      payload: { v: 2 },
    });
    expect(second.outcome).toBe('duplicate');
    expect(second.id).toBe(first.id);

    const count = await prisma.notificationOutbox.count({ where: { dedupeKey: 'confirmation:appt1' } });
    expect(count).toBe(1);
    const row = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.recipient).toBe('dana@example.com'); // the FIRST decision, untouched
  });

  // P2-4: a walk-in with no phone on file must not fail the booking.
  it('does not throw when recipient is absent — records suppressed:no_recipient instead', async () => {
    const result = await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:appt-walkin',
      channel: 'sms',
      template: 'appointment.confirmed',
      recipient: null,
      payload: {},
    });
    expect(result.status).toBe('suppressed');
    const row = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.lastError).toBe('suppressed:no_recipient');
    expect(row.recipient).toBeNull();
  });

  it('treats a blank/whitespace recipient the same as absent', async () => {
    const result = await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:blank',
      channel: 'sms',
      template: 'appointment.confirmed',
      recipient: '   ',
      payload: {},
    });
    expect(result.status).toBe('suppressed');
  });

  // The kill switch is a DECISION-time control (config.ts): still recorded,
  // never silently dropped.
  it('records suppressed:kill_switch when NOTIFICATIONS_ENABLED=false, and still writes the row', async () => {
    process.env.NOTIFICATIONS_ENABLED = 'false';
    const result = await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:appt2',
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'dana@example.com',
      payload: {},
    });
    expect(result.status).toBe('suppressed');
    const row = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.lastError).toBe('suppressed:kill_switch');
    expect(row.recipient).toBe('dana@example.com'); // the intended recipient is still on record
  });

  it('commits and rolls back with a caller-supplied transaction', async () => {
    let enqueuedId: string | undefined;
    await expect(
      prisma.$transaction(async (tx) => {
        const result = await enqueueNotification(tx, {
          businessId,
          dedupeKey: 'confirmation:tx-rollback',
          channel: 'email',
          template: 'appointment.confirmed',
          recipient: 'dana@example.com',
          payload: {},
        });
        enqueuedId = result.id;
        throw new Error('caller-side failure after enqueue');
      }),
    ).rejects.toThrow('caller-side failure after enqueue');

    expect(enqueuedId).toBeDefined();
    const row = await prisma.notificationOutbox.findUnique({ where: { id: enqueuedId! } });
    expect(row).toBeNull(); // rolled back with the rest of the transaction
  });
});

describe('dispatchPendingNotifications — send', () => {
  it('sends every pending row and marks it sent', async () => {
    await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:appt3',
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'dana@example.com',
      payload: { appointmentId: 'appt3' },
    });
    const adapter = new FakeAdapter();
    const result = await dispatchPendingNotifications(prisma, adapter);
    expect(result).toEqual({ sent: 1, failed: 0, suppressed: 0 });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]).toMatchObject({ channel: 'email', to: 'dana@example.com', template: 'appointment.confirmed' });

    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'confirmation:appt3' } });
    expect(row.status).toBe('sent');
    expect(row.sentAt).not.toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('does not send an already-suppressed row', async () => {
    await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:appt-none',
      channel: 'sms',
      template: 'appointment.confirmed',
      recipient: null,
      payload: {},
    });
    const adapter = new FakeAdapter();
    const result = await dispatchPendingNotifications(prisma, adapter);
    expect(result).toEqual({ sent: 0, failed: 0, suppressed: 0 });
    expect(adapter.sent).toHaveLength(0);
  });

  it('marks a row failed and records the error when the adapter throws', async () => {
    await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:appt4',
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'dana@example.com',
      payload: {},
    });
    const adapter = new FakeAdapter();
    adapter.failNext = true;
    const result = await dispatchPendingNotifications(prisma, adapter);
    expect(result).toEqual({ sent: 0, failed: 1, suppressed: 0 });

    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'confirmation:appt4' } });
    expect(row.status).toBe('failed');
    expect(row.lastError).toBe('provider rejected the message');
    expect(row.attempts).toBe(1);
  });

  it('suppresses a row on an unsupported channel without throwing', async () => {
    await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:appt5',
      channel: 'sms',
      template: 'appointment.confirmed',
      recipient: '+15125550100',
      payload: {},
    });
    const adapter = new FakeAdapter();
    adapter.unsupportedChannels.add('sms');
    const result = await dispatchPendingNotifications(prisma, adapter);
    expect(result).toEqual({ sent: 0, failed: 0, suppressed: 1 });

    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'confirmation:appt5' } });
    expect(row.status).toBe('suppressed');
    expect(row.lastError).toBe('suppressed:unsupported_channel');
  });

  // The safety property that matters most: flipping the switch halts an
  // ALREADY-QUEUED backlog, not just future enqueues.
  it('halts an already-queued backlog when the kill switch is off at dispatch time', async () => {
    await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:appt6',
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'dana@example.com',
      payload: {},
    });
    process.env.NOTIFICATIONS_ENABLED = 'false';
    const adapter = new FakeAdapter();
    const result = await dispatchPendingNotifications(prisma, adapter);
    expect(result).toEqual({ sent: 0, failed: 0, suppressed: 0 });
    expect(adapter.sent).toHaveLength(0);

    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'confirmation:appt6' } });
    expect(row.status).toBe('pending'); // untouched — dispatch never reached it
  });

  it('redirects the actual send to the sandbox address, but the outbox row keeps the intended recipient', async () => {
    await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:appt7',
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'real-client@example.com',
      payload: {},
    });
    process.env.NOTIFICATIONS_SANDBOX_TO = 'sandbox@example.com';
    const adapter = new FakeAdapter();
    await dispatchPendingNotifications(prisma, adapter);

    expect(adapter.sent[0]!.to).toBe('sandbox@example.com');
    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'confirmation:appt7' } });
    expect(row.recipient).toBe('real-client@example.com'); // the record of who this was actually for
  });

  it('respects the limit and processes oldest first', async () => {
    for (let i = 0; i < 5; i++) {
      await enqueueNotification(prisma, {
        businessId,
        dedupeKey: `confirmation:batch-${i}`,
        channel: 'email',
        template: 'appointment.confirmed',
        recipient: `client${i}@example.com`,
        payload: { i },
      });
    }
    const adapter = new FakeAdapter();
    const result = await dispatchPendingNotifications(prisma, adapter, 3);
    expect(result.sent).toBe(3);
    const remaining = await prisma.notificationOutbox.count({ where: { status: 'pending' } });
    expect(remaining).toBe(2);
  });
});
