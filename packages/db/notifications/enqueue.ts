/**
 * enqueueNotification — the "decide and record" half of NOTIF-01.
 *
 * Deciding and recording are separate from sending (dispatch.ts), and the
 * separation is the whole design: enqueue() runs inside whatever transaction
 * its caller is already in, so a booking write and its confirmation row
 * commit or roll back together (A-009 needs exactly this — a booking must
 * never succeed with its confirmation silently lost, or vice versa). Sending
 * happens later, outside any transaction, because a network call held open
 * inside a database transaction pins a pooled connection for the length of a
 * third party's outage.
 */
import type { NotificationChannel, OutboxStatus, Prisma, PrismaClient } from '../generated/client/index.js';
import { isUniqueViolation } from '../errors';
import { notificationConfig } from './config';

type Db = Prisma.TransactionClient | PrismaClient;

export interface EnqueueInput {
  businessId: string;
  /**
   * The natural key of the fact being announced — "confirmation:{appointmentId}",
   * not a fresh UUID. It has to be derivable from the fact rather than from
   * the attempt, or a retry generates a new key and the idempotency guarantee
   * is worth nothing. (P1-7: a reminder's key MUST also include the target
   * instant — "reminder-24h:{appointmentId}:{startAtEpochMs}" — so a
   * reschedule doesn't silently keep or drop a reminder for the wrong time.)
   */
  dedupeKey: string;
  channel: NotificationChannel;
  template: string;
  /** The address to send to. `null`/absent means no address is on file — the
   *  walk-in-with-no-phone case (BOOK-04). Enqueuing must not throw for this;
   *  a booking cannot be allowed to fail because the client has no phone. */
  recipient?: string | null;
  payload: unknown;
}

export interface EnqueueResult {
  /** `recorded` — a new row was written (possibly already suppressed).
   *  `duplicate` — this exact dedupeKey was already decided; nothing was
   *  written, and the EXISTING decision is returned unchanged. */
  outcome: 'recorded' | 'duplicate';
  id: string;
  status: OutboxStatus;
}

/**
 * Decides and records one notification. Sends nothing — see dispatch.ts.
 *
 * The kill switch is applied HERE, not in dispatch(): "notifications are
 * still decided and recorded" (config.ts) is the property that makes
 * "why didn't this go out" answerable, and that answer has to exist even for
 * a notification that was never going to be sent.
 */
export async function enqueueNotification(db: Db, input: EnqueueInput): Promise<EnqueueResult> {
  const config = notificationConfig();
  const recipient = input.recipient?.trim() || null;

  const suppressedReason = !config.enabled ? 'kill_switch' : recipient === null ? 'no_recipient' : null;

  try {
    const created = await db.notificationOutbox.create({
      data: {
        businessId: input.businessId,
        dedupeKey: input.dedupeKey,
        channel: input.channel,
        template: input.template,
        recipient,
        payload: input.payload as Prisma.InputJsonValue,
        status: suppressedReason ? 'suppressed' : 'pending',
        lastError: suppressedReason ? `suppressed:${suppressedReason}` : null,
      },
      select: { id: true, status: true },
    });
    return { outcome: 'recorded', id: created.id, status: created.status };
  } catch (error) {
    if (isUniqueViolation(error, 'dedupeKey')) {
      // The invariant holding, not a failure: some other call — a retried
      // write path, a re-run job — already decided this exact notification.
      const existing = await db.notificationOutbox.findUniqueOrThrow({
        where: { dedupeKey: input.dedupeKey },
        select: { id: true, status: true },
      });
      return { outcome: 'duplicate', id: existing.id, status: existing.status };
    }
    throw error;
  }
}
