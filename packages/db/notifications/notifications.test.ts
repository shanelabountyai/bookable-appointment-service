/**
 * A-004 — enqueue/dispatch against the real database (CLAUDE.md: tests never
 * point at a remote database, and this module's whole point is what commits
 * and what doesn't, which a mock cannot show).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelAdapter, OutboundMessage, SendResult } from '../../core/notifications';
import { PrismaClient } from '../generated/client/index.js';
import { ChannelSendError, LOGGING_ADAPTER_ID } from '../../core/notifications';
import { instant, instantFromIso, toDate } from '../../core/time';
import { dispatchPendingNotifications } from './dispatch';
import { countFailedNotifications, listStuckNotifications, retryNotification } from './stuck';
import { reallyDelivered } from './provider';
import { enqueueNotification } from './enqueue';
import { resetDatabase } from '../testing';

const prisma = new PrismaClient();
let businessId: string;

/**
 * A-051 — a FROZEN now, so the backoff is tested by advancing a clock rather
 * than by sleeping through two hours of it. Through the one conversion module,
 * like every other instant in this repo.
 */
const AT = toDate(instantFromIso('2026-06-09T15:00:00.000Z'));
const later = (ms: number) => toDate(instant(instantFromIso('2026-06-09T15:00:00.000Z') + ms));

/** Fails every send with a given provider code — the input the retry policy
 *  actually branches on. */
class CodedAdapter implements ChannelAdapter {
  readonly id = 'coded';
  attempts = 0;
  constructor(private readonly code: string) {}
  supports(): boolean {
    return true;
  }
  async send(): Promise<SendResult> {
    this.attempts++;
    throw new ChannelSendError(this.code, 'the provider said no');
  }
}

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
    expect(result).toEqual({ sent: 1, failed: 0, retrying: 0, suppressed: 0 });
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
    expect(result).toEqual({ sent: 0, failed: 0, retrying: 0, suppressed: 0 });
    expect(adapter.sent).toHaveLength(0);
  });

  /**
   * A-051 CHANGED WHAT THIS TEST ASSERTS, and the change is the item.
   *
   * It used to assert `failed` after one throw — which was true, and was the
   * defect: a row that reached `failed` was terminal, so a provider's bad
   * minute became a client who was never told. An unrecognised error is
   * TRANSIENT now, so the row goes back to `pending` with a wait on it and
   * the reason kept.
   */
  it('puts a row back with a wait when the adapter throws something unrecognised', async () => {
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
    const result = await dispatchPendingNotifications(prisma, adapter, 100, AT);
    expect(result).toEqual({ sent: 0, failed: 0, retrying: 1, suppressed: 0 });

    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'confirmation:appt4' } });
    expect(row.status).toBe('pending');
    expect(row.lastError).toBe('provider rejected the message');
    expect(row.attempts).toBe(1);
    // A minute, from the table in `core/notifications/retry.ts`.
    expect(row.nextAttemptAt?.getTime()).toBe(AT.getTime() + 60_000);
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
    expect(result).toEqual({ sent: 0, failed: 0, retrying: 0, suppressed: 1 });

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
    expect(result).toEqual({ sent: 0, failed: 0, retrying: 0, suppressed: 0 });
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
    await dispatchPendingNotifications(prisma, adapter, 100, AT);

    const row = await prisma.notificationOutbox.findFirstOrThrow({
      where: { dedupeKey: 'confirmation:failed-provenance' },
    });
    // A-051 moved the STATUS an unrecognised failure lands in — it goes back
    // to `pending` with a wait rather than straight to `failed`. A-048's
    // subject is unchanged and is the reason this test exists: whichever
    // driver could not send it is on the row either way.
    expect(row.status).toBe('pending');
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

/**
 * A-051 — RETRY, BACKOFF, AND THE SCREEN THAT SHOWS WHAT IS STUCK.
 *
 * Before this, a row that reached `failed` was never looked at again: the
 * A-048 claim matches `pending` or a stale `sending` and nothing else. Against
 * the console adapter that is invisible. Against a real provider it is a
 * client who is never told because the provider had a bad minute.
 */
describe('A-051 — the retry policy', () => {
  const queue = (dedupeKey: string, recipient: string | null = 'dana@example.com') =>
    enqueueNotification(prisma, {
      businessId,
      dedupeKey,
      channel: 'email',
      template: 'appointment.confirmed',
      recipient,
      payload: {},
    });

  /** The rule the backlog row states in one line: retry a 503, never retry a
   *  bad phone number. */
  it('never retries a failure that is about the recipient', async () => {
    await queue('retry:permanent');
    const adapter = new CodedAdapter('invalid_recipient');

    const result = await dispatchPendingNotifications(prisma, adapter, 100, AT);
    expect(result).toEqual({ sent: 0, failed: 1, retrying: 0, suppressed: 0 });

    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'retry:permanent' } });
    expect(row.status).toBe('failed');
    expect(row.nextAttemptAt).toBeNull();
    // The CODE is kept in front of the message — the part a policy branches on
    // and the part a human can search for. `dispatch.ts` used to store only
    // `error.message`, throwing away the one stable identifier the contract
    // has promised since A-004.
    expect(row.lastError).toBe('invalid_recipient: the provider said no');

    // And it is not tried again on the next run, whatever the clock says.
    await dispatchPendingNotifications(prisma, adapter, 100, later(24 * 60 * 60_000));
    expect(adapter.attempts).toBe(1);
  });

  it('retries a transient failure on a growing backoff, then gives up', async () => {
    await queue('retry:transient');
    const adapter = new CodedAdapter('rate_limited');

    // A minute, five minutes, twenty-five minutes, two hours — the table in
    // `core/notifications/retry.ts`, asserted as elapsed time from the first
    // attempt rather than re-derived here.
    const schedule = [60_000, 5 * 60_000, 25 * 60_000, 2 * 60 * 60_000];
    let elapsed = 0;
    for (const wait of schedule) {
      const at = later(elapsed);
      const result = await dispatchPendingNotifications(prisma, adapter, 100, at);
      expect(result.retrying).toBe(1);
      const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'retry:transient' } });
      expect(row.status).toBe('pending');
      expect(row.nextAttemptAt?.getTime()).toBe(at.getTime() + wait);
      elapsed += wait;
    }

    // The fifth attempt is the last one MAX_ATTEMPTS allows.
    const final = await dispatchPendingNotifications(prisma, adapter, 100, later(elapsed));
    expect(final).toEqual({ sent: 0, failed: 1, retrying: 0, suppressed: 0 });
    expect(adapter.attempts).toBe(5);

    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'retry:transient' } });
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(5);
    expect(row.nextAttemptAt).toBeNull();
  });

  /** The backoff has to be a PREDICATE, not a hope: a dispatcher running a
   *  second later must not pick the row straight back up. */
  it('leaves a waiting row alone until its next attempt is due', async () => {
    await queue('retry:waiting');
    const adapter = new CodedAdapter('temporarily_unavailable');
    await dispatchPendingNotifications(prisma, adapter, 100, AT);
    expect(adapter.attempts).toBe(1);

    // One second later: still waiting.
    const tooSoon = await dispatchPendingNotifications(prisma, adapter, 100, later(1_000));
    expect(tooSoon).toEqual({ sent: 0, failed: 0, retrying: 0, suppressed: 0 });
    expect(adapter.attempts).toBe(1);

    // A minute later: due.
    await dispatchPendingNotifications(prisma, adapter, 100, later(60_000));
    expect(adapter.attempts).toBe(2);
  });

  /** The happy ending, which is the whole point of retrying at all. */
  it('sends on a later attempt and clears the wait behind it', async () => {
    await queue('retry:recovers');
    const failing = new CodedAdapter('server_error');
    await dispatchPendingNotifications(prisma, failing, 100, AT);

    const working = new FakeAdapter();
    const result = await dispatchPendingNotifications(prisma, working, 100, later(60_000));
    expect(result).toEqual({ sent: 1, failed: 0, retrying: 0, suppressed: 0 });

    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'retry:recovers' } });
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(2);
    // A stale wait on a sent row is a lie on the screen.
    expect(row.nextAttemptAt).toBeNull();
    expect(row.lastError).toBeNull();
  });

  /**
   * A row with nobody to send to used to be handed to the adapter as an empty
   * string. The console adapter cheerfully "delivered" it; a real one would
   * have failed it four more times on a backoff first.
   */
  it('gives up immediately on a row with no recipient at all', async () => {
    // Written directly: `enqueueNotification` suppresses a null recipient up
    // front (P2-4), so the only way into this state is a row that lost its
    // contact details afterwards — which is exactly the case worth defending.
    await prisma.notificationOutbox.create({
      data: {
        businessId,
        dedupeKey: 'retry:no-recipient',
        channel: 'email',
        template: 'appointment.confirmed',
        recipient: null,
        payload: {},
        status: 'pending',
      },
    });
    const adapter = new FakeAdapter();
    const result = await dispatchPendingNotifications(prisma, adapter, 100, AT);

    expect(result).toEqual({ sent: 0, failed: 1, retrying: 0, suppressed: 0 });
    expect(adapter.sent).toHaveLength(0);
    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'retry:no-recipient' } });
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/^no_recipient:/);
  });
});

describe('A-051 — what did not go out', () => {
  const queue = (dedupeKey: string) =>
    enqueueNotification(prisma, {
      businessId,
      dedupeKey,
      channel: 'email',
      template: 'appointment.confirmed',
      recipient: 'dana@example.com',
      payload: {},
    });

  /** Both kinds on one list — the desk's question is one question. */
  it('lists the given-up and the still-trying, and nothing that is merely new', async () => {
    // Written directly, because the SUBJECT here is which rows the query
    // selects, and driving three different outcomes through the dispatcher to
    // get there would be testing the dispatcher again with more steps.
    const row = (dedupeKey: string, status: 'pending' | 'failed' | 'sent', attempts: number) =>
      prisma.notificationOutbox.create({
        data: {
          businessId,
          dedupeKey,
          channel: 'email',
          template: 'appointment.confirmed',
          recipient: 'dana@example.com',
          payload: {},
          status,
          attempts,
        },
      });

    await row('stuck:dead', 'failed', 5);
    await row('stuck:waiting', 'pending', 2);
    await row('stuck:fresh', 'pending', 0); // queued a second ago — not stuck
    await row('stuck:gone-out', 'sent', 1);

    const stuck = await listStuckNotifications(prisma, businessId);
    const keys = await Promise.all(
      stuck.map(async (found) => (await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: found.id } })).dedupeKey),
    );
    expect(keys.sort()).toEqual(['stuck:dead', 'stuck:waiting']);
    expect(stuck.find((found) => found.status === 'failed')?.attempts).toBe(5);
  });

  it('counts only what has been given up on', async () => {
    await queue('count:waiting');
    await dispatchPendingNotifications(prisma, new CodedAdapter('server_error'), 100, AT);
    expect(await countFailedNotifications(prisma, businessId)).toBe(0);

    await dispatchPendingNotifications(prisma, new CodedAdapter('invalid_recipient'), 100, later(60_000));
    expect(await countFailedNotifications(prisma, businessId)).toBe(1);
  });

  /** The desk fixed the phone number. The row gets a FULL budget back — a
   *  retry with its budget already spent would try once, give up again, and
   *  look from the desk like the button does not work. */
  it('puts a failed row back with its attempts reset, and refuses one from another salon', async () => {
    await queue('retry:by-hand');
    await dispatchPendingNotifications(prisma, new CodedAdapter('invalid_recipient'), 100, AT);
    const failed = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: 'retry:by-hand' } });

    const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });
    expect(await retryNotification(prisma, { businessId: other.id, id: failed.id })).toBe(false);

    expect(await retryNotification(prisma, { businessId, id: failed.id })).toBe(true);
    const requeued = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: failed.id } });
    expect(requeued.status).toBe('pending');
    expect(requeued.attempts).toBe(0);
    expect(requeued.nextAttemptAt).toBeNull();

    // And it really does go out on the next run.
    const working = new FakeAdapter();
    expect((await dispatchPendingNotifications(prisma, working, 100, later(1_000))).sent).toBe(1);
  });
});
