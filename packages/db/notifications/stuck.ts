/**
 * A-051 — WHAT DID NOT GO OUT (NOTIF-01).
 *
 * The other half of the retry policy, and the half that makes it worth
 * having: a queue that quietly gives up is the same silence as a queue that
 * never tried, with better manners. Somebody has to be able to stand at the
 * desk and see that Ada's reminder never reached her.
 *
 * TWO KINDS OF ROW, and they are deliberately shown together rather than on
 * two screens, because the desk's question is one question — "is anybody not
 * going to hear from us?":
 *
 *  - `failed` — given up on. A permanent refusal (a dead address), or the
 *    last attempt spent.
 *  - `pending` with attempts already spent — still trying, waiting out its
 *    backoff. Reassuring rather than alarming, and saying so is the point:
 *    without it, a row mid-backoff is invisible and the desk phones a client
 *    the system was about to reach anyway.
 *
 * A fresh `pending` row (attempts = 0) is not stuck, it is new, and it does
 * not belong here — it would put every message the salon sends on a screen
 * about the ones that did not.
 */
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface StuckNotification {
  id: string;
  /** `failed` (given up) or `pending` (waiting for its next try). */
  status: string;
  template: string;
  channel: string;
  /** The INTENDED address, always — never the sandbox redirect (enqueue.ts). */
  recipient: string | null;
  lastError: string | null;
  attempts: number;
  /** Set only while waiting: when the next attempt is due. */
  nextAttemptAt: Date | null;
  createdAt: Date;
  /** For the link back to the appointment this was about, when it was about
   *  one — a message with no appointment is ordinary (system mail later). */
  appointmentId: string | null;
  clientName: string | null;
}

/** The failed and the still-trying, newest first. Capped: this is a screen
 *  somebody reads, and a thousand rows on it is the same as none. */
export async function listStuckNotifications(
  db: Db,
  businessId: string,
  limit = 100,
): Promise<StuckNotification[]> {
  const rows = await db.notificationOutbox.findMany({
    where: { businessId, OR: [{ status: 'failed' }, { status: 'pending', attempts: { gt: 0 } }] },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      status: true,
      template: true,
      channel: true,
      recipient: true,
      lastError: true,
      attempts: true,
      nextAttemptAt: true,
      createdAt: true,
      appointmentId: true,
      appointment: { select: { client: { select: { name: true } } } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    template: row.template,
    channel: row.channel,
    recipient: row.recipient,
    lastError: row.lastError,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    createdAt: row.createdAt,
    appointmentId: row.appointmentId,
    clientName: row.appointment?.client?.name ?? null,
  }));
}

/** How many have been GIVEN UP ON — the number worth putting in front of
 *  somebody. A row still working through its backoff is not a number anybody
 *  should act on, and counting it would train the desk to ignore the badge. */
export async function countFailedNotifications(db: Db, businessId: string): Promise<number> {
  return db.notificationOutbox.count({ where: { businessId, status: 'failed' } });
}

/**
 * Put one back in the queue, by hand.
 *
 * The desk's move after fixing a wrong phone number, and the reason the
 * screen is not read-only: seeing that Ada was never told is only half an
 * answer if the only way to act on it is to phone her.
 *
 * ATTEMPTS RESET TO ZERO, deliberately. The column means "tries in the
 * current run", and a row retried with its budget already spent would make
 * exactly one more attempt and give up again — which looks, from the desk,
 * like the button does not work. The history of what went wrong is in
 * `lastError`, which is kept until the next attempt overwrites it.
 *
 * Scoped by business, so an id from elsewhere retries nothing rather than
 * somebody else's message.
 */
export async function retryNotification(db: Db, args: { businessId: string; id: string }): Promise<boolean> {
  const { count } = await db.notificationOutbox.updateMany({
    where: { id: args.id, businessId: args.businessId, status: 'failed' },
    data: { status: 'pending', attempts: 0, nextAttemptAt: null },
  });
  return count > 0;
}
