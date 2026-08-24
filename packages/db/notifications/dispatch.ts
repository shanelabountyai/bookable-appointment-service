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
import type { ChannelAdapter } from '../../core/notifications';
import { instant, toDate } from '../../core/time';
import type { OutboxStatus, PrismaClient } from '../generated/client/index.js';
import { notificationConfig } from './config';

export interface DispatchResult {
  sent: number;
  failed: number;
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
): Promise<DispatchResult> {
  const config = notificationConfig();
  if (!config.enabled) return { sent: 0, failed: 0, suppressed: 0 };

  // Through the one conversion module (D-3), like every other instant here.
  const staleBefore = toDate(instant(Date.now() - STALE_CLAIM_MS));

  // Raw because this has to be ONE statement. Prisma's `updateMany` cannot
  // return the rows it touched, and a findMany-then-updateMany is precisely
  // the check-then-write this exists to remove.
  const due = await prisma.$queryRaw<ClaimedRow[]>`
    UPDATE "NotificationOutbox" AS o
       SET status = 'sending', attempts = o.attempts + 1, "updatedAt" = now()
     WHERE o.id IN (
             SELECT c.id
               FROM "NotificationOutbox" AS c
              WHERE c.status = 'pending'
                 OR (c.status = 'sending' AND c."updatedAt" < ${staleBefore})
              ORDER BY c."createdAt" ASC
              LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
           )
    RETURNING o.id, o.channel, o.template, o.recipient, o.payload
  `;

  let sent = 0;
  let failed = 0;
  let suppressed = 0;

  for (const row of due) {
    if (!adapter.supports(row.channel)) {
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: 'suppressed' satisfies OutboxStatus,
          lastError: 'suppressed:unsupported_channel',
        },
      });
      suppressed++;
      continue;
    }

    // The recipient column is always the INTENDED address (enqueue.ts). The
    // sandbox redirect changes only where the actual send goes; it never
    // changes what's on the record.
    const to = config.sandboxTo ?? row.recipient ?? '';

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
          sentAt: new Date(),
          lastError: null,
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
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          deliveredBy: adapter.id,
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      failed++;
    }
  }

  return { sent, failed, suppressed };
}
