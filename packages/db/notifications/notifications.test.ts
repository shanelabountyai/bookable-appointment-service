/**
 * A-004 — enqueue/dispatch against the real database (CLAUDE.md: tests never
 * point at a remote database, and this module's whole point is what commits
 * and what doesn't, which a mock cannot show).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelAdapter, OutboundMessage, SendResult } from '../../core/notifications';
import { PrismaClient } from '../generated/client/index.js';
import { LOGGING_ADAPTER_ID } from '../../core/notifications';
import { dispatchPendingNotifications } from './dispatch';
import { reallyDelivered } from './provider';
import { enqueueNotification } from './enqueue';
import { resetDatabase } from '../testing';

const prisma = new PrismaClient();
let businessId: string;

/** A controllable fake — records every call, and can be told to fail or to
 *  refuse a channel, so dispatch's branches are each independently testable. */
class FakeAdapter implements ChannelAdapter {
  readonly id = 'fake';
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

/**
 * A-048. Blocks inside `send()` until released, so two `dispatchPending-
 * Notifications` calls are genuinely IN FLIGHT at the same time rather than
 * merely started in the same tick. Without this the race test can pass on
 * accidental serialisation and prove nothing.
 */
class BlockingAdapter implements ChannelAdapter {
  readonly id = 'blocking';
  readonly sent: OutboundMessage[] = [];
  private release!: () => void;
  readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  readonly entered: Promise<void>;
  private markEntered!: () => void;

  constructor() {
    this.entered = new Promise<void>((resolve) => {
      this.markEntered = resolve;
    });
  }

  open(): void {
    this.release();
  }

  supports(): boolean {
    return true;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    this.markEntered();
    await this.gate;
    return { externalId: `blocking-${this.sent.length}` };
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

  /**
   * A-048 — THE REGRESSION TEST THE ITEM NAMES.
   *
   * Two concurrent dispatchers over ONE pending row produce exactly one send.
   * Before the claim, both `findMany`d the same `pending` row and both sent
   * it — invisible while the adapter is a console log, and a client texted
   * twice on the first day Twilio is real.
   */
  it('two concurrent dispatchers over one pending row send it exactly once', async () => {
    await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:race',
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'ada@example.com',
      payload: {},
    });

    const first = new BlockingAdapter();
    const second = new FakeAdapter();

    // Start the first and WAIT until it is inside `send()` — the row is
    // claimed and the send is in flight. Only then does the second run start,
    // which is exactly the overlap that used to double-send.
    const firstRun = dispatchPendingNotifications(prisma, first);
    await first.entered;

    const secondResult = await dispatchPendingNotifications(prisma, second);
    first.open();
    const firstResult = await firstRun;

    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
    expect(firstResult.sent + secondResult.sent).toBe(1);

    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'confirmation:race' } });
    expect(row.status).toBe('sent');
    // Claimed once, so attempted once. A second claim would have incremented
    // it even if the send had somehow been skipped.
    expect(row.attempts).toBe(1);
  });

  it('records WHICH adapter handled it and what the provider called the message', async () => {
    await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:provenance',
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'ada@example.com',
      payload: {},
    });
    await dispatchPendingNotifications(prisma, new FakeAdapter());

    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'confirmation:provenance' } });
    expect(row.deliveredBy).toBe('fake');
    // `dispatch.ts` used to receive this and throw it away for want of a column.
    expect(row.externalId).toBe('fake-1');
  });

  it('a failure records the adapter too — "which driver could not send this" is the question then', async () => {
    await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:failed-provenance',
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'ada@example.com',
      payload: {},
    });
    const adapter = new FakeAdapter();
    adapter.failNext = true;
    await dispatchPendingNotifications(prisma, adapter);

    const row = await prisma.notificationOutbox.findFirstOrThrow({
      where: { dedupeKey: 'confirmation:failed-provenance' },
    });
    expect(row.status).toBe('failed');
    expect(row.deliveredBy).toBe('fake');
  });

  /**
   * A row whose dispatcher died mid-send would otherwise be stranded
   * `sending` forever — a message nobody ever sends, which is worse than one
   * sent twice. This is the one place a double-send remains possible, and it
   * is a deliberate trade.
   */
  it('reclaims a stale `sending` row, and leaves a fresh one alone', async () => {
    await enqueueNotification(prisma, {
      businessId,
      dedupeKey: 'confirmation:stale',
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'ada@example.com',
      payload: {},
    });
    const id = (await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'confirmation:stale' } })).id;

    // Freshly claimed: another dispatcher must NOT take it.
    await prisma.notificationOutbox.update({ where: { id }, data: { status: 'sending' } });
    expect((await dispatchPendingNotifications(prisma, new FakeAdapter())).sent).toBe(0);

    // Claimed twenty minutes ago and never resolved: the holder is gone.
    await prisma.$executeRaw`
      UPDATE "NotificationOutbox" SET "updatedAt" = now() - interval '20 minutes' WHERE id = ${id}
    `;
    const adapter = new FakeAdapter();
    expect((await dispatchPendingNotifications(prisma, adapter)).sent).toBe(1);
    expect(adapter.sent).toHaveLength(1);
  });

  /**
   * A-048 — the defect the ITEM did not name, found by probing the path.
   *
   * `enqueueNotification`'s duplicate branch used to catch the unique
   * violation and then READ the existing row. Postgres aborts a transaction
   * on a constraint violation, so inside a transaction — which is where the
   * booking path calls it — that read failed and the caller got an unknown
   * error instead of `duplicate`. The booking rolled back rather than being
   * idempotent, and every test passed because they all called it outside one.
   */
  it('reports a duplicate correctly from INSIDE a transaction, not just outside one', async () => {
    const input = {
      businessId,
      dedupeKey: 'confirmation:in-tx',
      channel: 'email' as const,
      template: 'appointment.confirmed',
      recipient: 'ada@example.com',
      payload: {},
    };
    const first = await enqueueNotification(prisma, input);
    expect(first.outcome).toBe('recorded');

    const inside = await prisma.$transaction(async (tx) => {
      const again = await enqueueNotification(tx, input);
      // The transaction must still be USABLE afterwards — an aborted one
      // fails here, which is exactly how the old version failed.
      const total = await tx.notificationOutbox.count({ where: { dedupeKey: input.dedupeKey } });
      return { again, total };
    });

    expect(inside.again.outcome).toBe('duplicate');
    expect(inside.again.id).toBe(first.id);
    expect(inside.total).toBe(1);
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

/**
 * A-048 — "was she actually told?" is a question about the ROW.
 *
 * A-044 answered it from the build, so the day a real driver landed every
 * message ever queued would retroactively have read "sent".
 */
describe('reallyDelivered (A-048)', () => {
  it('is false for the console adapter and for rows written before the column existed', () => {
    expect(reallyDelivered(LOGGING_ADAPTER_ID)).toBe(false);
    expect(reallyDelivered(null)).toBe(false);
    expect(reallyDelivered(undefined)).toBe(false);
  });

  it('is true for anything else — the swap is still one assignment (D-14)', () => {
    expect(reallyDelivered('twilio')).toBe(true);
  });
});
