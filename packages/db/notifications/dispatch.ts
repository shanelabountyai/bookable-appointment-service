/**
 * dispatchPendingNotifications — the "send" half of NOTIF-01. See enqueue.ts
 * for why deciding and sending are separate steps.
 *
 * A-048 — THE CLAIM (NOTIF-01, D-14).
 *
 * This used to `findMany({ where: { status: 'pending' } })` and then send.
 * Two overlapping runs both picked up the same row and both sent it, and the
 * only reason nobody saw it is that the wired adapter writes to a console. On
 * the first day Twilio is real that is a client texted twice, and the bill is
 * where you find out. Fixing it after the driver lands means debugging a race
 * against live SMS charges, which is why it is cheapest now.
 *
 * The claim is ONE statement — `UPDATE ... WHERE status = 'pending' ...
 * RETURNING` — so exactly one dispatcher can win a row. The same division of
 * labour D-2 established for bookings: the database is the enforcer, not a
 * check the application performs first and hopes about.
 *
 * `FOR UPDATE SKIP LOCKED` on the inner select is what makes a second
 * dispatcher pick up DIFFERENT work rather than block on the first one's.
 * Without it the claim is still correct — the re-evaluated `status = 'pending'`
 * predicate matches nothing after the winner commits — just serialised.
 */
import { type ChannelAdapter, ChannelSendError, classifyFailure, retryDelayMs } from '../../core/notifications';
import { fromDate, instant, toDate } from '../../core/time';
import type { OutboxStatus, PrismaClient } from '../generated/client/index.js';
import { notificationConfig } from './config';

export interface DispatchResult {
  sent: number;
  /** Given up on: a permanent failure, or the last attempt spent. */
  failed: number;
  /** A-051 — failed this time and put back with a wait on it. Counted apart
   *  from `failed` because "we will try again in five minutes" and "nobody is
   *  ever going to be told" are different facts, and a job log that calls both
   *  of them `failed` is how the second one hides behind the first. */
  retrying: number;
  suppressed: number;
}

/**
 * How long a row may sit `sending` before another dispatcher may take it.
 *
 * THE ONE PLACE A DOUBLE-SEND IS STILL POSSIBLE, and it is a deliberate
 * trade: a process that dies mid-send (a serverless timeout is the realistic
 * case) would otherwise strand its claim forever, and a message nobody ever
 * sends is worse than one sent twice. Fifteen minutes is far longer than any
 * provider call, so reclaiming a merely-slow dispatcher's row takes a genuine
 * hang rather than ordinary latency — and `externalId` is what lets a real
 * driver reconcile if it ever happens.
 */
const STALE_CLAIM_MS = 15 * 60 * 1000;

/** The columns the claim returns — `SELECT *` would silently change shape
 *  under a later migration. */
interface ClaimedRow {
  id: string;
  channel: 'email' | 'sms';
  template: string;
  recipient: string | null;
  payload: unknown;
  /** Post-increment: 1 on the first pass. The backoff table is indexed off
   *  this, so it has to come back from the claim rather than be re-read. */
  attempts: number;
}

/**
 * Sends everything still `pending`, up to `limit`, oldest first.
 *
 * Re-checks the kill switch before touching anything: flipping
 * NOTIFICATIONS_ENABLED=false must halt an already-queued backlog within a
 * minute, not just refuse new enqueues (config.ts).
 */
export async function dispatchPendingNotifications(
  prisma: PrismaClient,
  adapter: ChannelAdapter,
  limit = 100,
  /** A-051. INJECTED, so the backoff can be tested by advancing a clock
   *  rather than by sleeping through two hours of it. Defaulted here — this
   *  is the boundary a scheduled job calls, which is where reading the clock
   *  is legitimate. */
  now: Date = new Date(),
): Promise<DispatchResult> {
  const config = notificationConfig();
  if (!config.enabled) return { sent: 0, failed: 0, retrying: 0, suppressed: 0 };

  // Through the one conversion module (D-3), like every other instant here.
  const staleBefore = toDate(instant(fromDate(now) - STALE_CLAIM_MS));

  // Raw because this has to be ONE statement. Prisma's `updateMany` cannot
  // return the rows it touched, and a findMany-then-updateMany is precisely
  // the check-then-write this exists to remove.
  const due = await prisma.$queryRaw<ClaimedRow[]>`
    UPDATE "NotificationOutbox" AS o
       SET status = 'sending', attempts = o.attempts + 1, "updatedAt" = now()
     WHERE o.id IN (
             SELECT c.id
               FROM "NotificationOutbox" AS c
              -- A-051: a row waiting out its backoff is pending with
              -- nextAttemptAt in the future, so the wait is a predicate here
              -- rather than a state of its own. NULL means no wait at all,
              -- which is every row on its first pass -- hence the OR, and
              -- hence no backfill on the column.
              WHERE (c.status = 'pending'
                     AND (c."nextAttemptAt" IS NULL OR c."nextAttemptAt" <= ${now}))
                 OR (c.status = 'sending' AND c."updatedAt" < ${staleBefore})
              ORDER BY c."createdAt" ASC
              LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
           )
    RETURNING o.id, o.channel, o.template, o.recipient, o.payload, o.attempts
  `;

  let sent = 0;
  let failed = 0;
  let retrying = 0;
  let suppressed = 0;

  for (const row of due) {
    if (!adapter.supports(row.channel)) {
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: 'suppressed' satisfies OutboxStatus,
          lastError: 'suppressed:unsupported_channel',
          // Never coming back, so it must not look like it is waiting.
          nextAttemptAt: null,
        },
      });
      suppressed++;
      continue;
    }

    // The recipient column is always the INTENDED address (enqueue.ts). The
    // sandbox redirect changes only where the actual send goes; it never
    // changes what's on the record.
    const to = config.sandboxTo ?? row.recipient ?? '';

    // A-051 — NOBODY TO SEND IT TO. `enqueueNotification` allows a null
    // recipient (a client with neither an email nor a phone is ordinary), and
    // until now that row was handed to the adapter as an empty string: a
    // console adapter cheerfully "delivered" it, and a real one would fail it
    // four more times on a backoff first. It is permanent by construction, so
    // it is said once, in words, and put where the desk can see it.
    if (to === '') {
      await failRow(prisma, row.id, adapter.id, 'no_recipient: nobody to send this to — no email and no phone');
      failed++;
      continue;
    }

    try {
      const result = await adapter.send({
        channel: row.channel,
        to,
        template: row.template,
        payload: row.payload,
      });
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: 'sent',
          sentAt: now,
          lastError: null,
          // A row that failed twice and then went out must not keep the wait
          // that got it here — `pending` is the only status the claim reads,
          // but a stale timestamp on a sent row is a lie on the screen.
          nextAttemptAt: null,
          // A-048: WHO handled it and WHAT the provider called it. Recorded
          // together because either one alone leaves the question half
          // answered — the adapter's id says whether anybody was really
          // reached, the provider's id is how you go and check.
          deliveredBy: adapter.id,
          externalId: result.externalId ?? null,
        },
      });
      sent++;
    } catch (error) {
      // A-051 — the split the whole item is about: retry a 503, never retry a
      // bad phone number. The classification is pure and lives in
      // `core/notifications/retry.ts`, so it is tested against a table of
      // codes rather than against a provider having a bad afternoon.
      const delay = classifyFailure(error) === 'transient' ? retryDelayMs(row.attempts) : null;
      const reason = describe(error);

      if (delay === null) {
        // Permanent, or the last attempt spent. Terminal on purpose — and now
        // terminal ON A SCREEN, which is the other half of this item: a retry
        // policy nobody can see is the same silence with better manners.
        await failRow(prisma, row.id, adapter.id, reason);
        failed++;
        continue;
      }

      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          // BACK TO `pending`, not a new status. The claim already asks for
          // pending; `nextAttemptAt` is the only thing it had to also ask.
          status: 'pending' satisfies OutboxStatus,
          deliveredBy: adapter.id,
          lastError: reason,
          nextAttemptAt: toDate(instant(fromDate(now) + delay)),
        },
      });
      retrying++;
    }
  }

  return { sent, failed, retrying, suppressed };
}

/** Terminal, with the reason kept in the words the provider used. */
async function failRow(prisma: PrismaClient, id: string, adapterId: string, reason: string): Promise<void> {
  await prisma.notificationOutbox.update({
    where: { id },
    data: {
      status: 'failed' satisfies OutboxStatus,
      deliveredBy: adapterId,
      lastError: reason,
      // Cleared, so a row the desk retries by hand is not still holding a wait
      // from the attempt that gave up.
      nextAttemptAt: null,
    },
  });
}

/**
 * The failure as a string worth reading later.
 *
 * The CODE is kept in front of the message, because the code is the part a
 * policy branches on and the part a human can search for across rows —
 * `dispatch.ts` recorded only `error.message` before this item, which meant
 * the one stable identifier the contract has promised since A-004 was thrown
 * away at the exact moment it became evidence.
 */
function describe(error: unknown): string {
  if (error instanceof ChannelSendError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
