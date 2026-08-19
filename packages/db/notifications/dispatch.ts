/**
 * dispatchPendingNotifications — the "send" half of NOTIF-01. See enqueue.ts
 * for why deciding and sending are separate steps.
 *
 * ponytail: no claim-before-send row locking. Two concurrent dispatchers could
 * both pick up the same `pending` row and send it twice. Left this way
 * because the one caller that exists (A-022's reminder job route) is a single
 * scheduled trigger, not proven-concurrent — the risk is a slow run
 * overlapping a retry, not routine operation. Upgrade path if that changes:
 * an `UPDATE ... WHERE status = 'pending' RETURNING ...` claim (the pattern
 * A-003's blocked-range trigger already established for this schema), or a
 * fifth `sending` OutboxStatus.
 */
import type { ChannelAdapter } from '../../core/notifications';
import type { OutboxStatus, PrismaClient } from '../generated/client/index.js';
import { notificationConfig } from './config';

export interface DispatchResult {
  sent: number;
  failed: number;
  suppressed: number;
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

  const due = await prisma.notificationOutbox.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

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
          attempts: { increment: 1 },
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
        data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, lastError: null },
      });
      void result; // externalId has nowhere to land yet — see adapter.ts.
      sent++;
    } catch (error) {
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          attempts: { increment: 1 },
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      failed++;
    }
  }

  return { sent, failed, suppressed };
}
