/**
 * A-051 — WHAT DID NOT GO OUT (NOTIF-01).
 *
 * The other half of the retry policy, and the half that makes it worth
 * having: a queue that quietly gives up is the same silence as a queue that
 * never tried, with better manners. Somebody has to be able to stand at the
 * desk and see that Ada's reminder never reached her.
 *
 * THREE KINDS OF ROW (two until A-108), and they are deliberately shown
 * together rather than on three screens, because the desk's question is one
 * question — "is anybody not going to hear from us?":
 *
 *  - `failed` — given up on. A permanent refusal (a dead address), or the
 *    last attempt spent.
 *  - `pending` with attempts already spent — still trying, waiting out its
 *    backoff. Reassuring rather than alarming, and saying so is the point:
 *    without it, a row mid-backoff is invisible and the desk phones a client
 *    the system was about to reach anyway.
 *  - `pending` with NO attempt ever spent, and OLD (A-108 / D-51). The
 *    argument below for excluding a fresh one — "it is new, not stuck" — is
 *    true only WHILE THE DISPATCHER IS RUNNING. A row it has never touched
 *    stays `pending`/`attempts = 0` forever, and for eight items that was the
 *    one state this screen could not see: 713 rows in it on two independent
 *    databases, under the sentence "Everything has gone out."
 *
 * A fresh `pending` row (attempts = 0) is still not stuck, it is new, and an
 * age bound is the whole of the difference — an hour is twelve missed
 * five-minute ticks, far past any ordinary backlog and well short of a
 * working day (D-51).
 *
 * THE THREE BUCKETS ARE NAMED ON THE ROW, not re-derived by the screen from
 * `status` and `attempts`. Two readers of one fact under different names is
 * the defect this repo has now caught four times.
 */
import { fromDate, instant, toDate } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * D-51. How long a `pending` row with no attempt ever spent may sit before it
 * stops meaning "new" and starts meaning "the job may not be running".
 */
export const UNTRIED_ALARM_MS = 60 * 60 * 1000;

/**
 * Which of the three this row is — decided HERE and carried on the row, so
 * the screen and the badge cannot each invent their own version of it.
 *
 *  - `given-up`      — failed. Nobody is ever going to be told.
 *  - `never-tried`   — queued over an hour ago and not attempted once.
 *  - `retrying`      — mid-backoff. Reassuring, and not a number to act on.
 */
export type StuckKind = 'given-up' | 'never-tried' | 'retrying';

/** The two the desk must ACT on. `retrying` is deliberately not one: counting
 *  a row the system is about to reach anyway trains the desk to ignore the
 *  badge, which was A-051's reasoning and still holds. */
const ACTIONABLE_KINDS: readonly StuckKind[] = ['given-up', 'never-tried'];

/**
 * Rows nobody has been told about and somebody should look at.
 *
 * THE AGE IS MEASURED FROM `updatedAt`, NOT `createdAt`, and the difference is
 * a defect rather than a nicety. `retryNotification` puts a row back with
 * `attempts` reset to 0 (deliberately — see below), and its `createdAt` is by
 * definition already old, so an age bound on creation would bounce every
 * hand-retried message straight back onto this screen as "queued over an hour
 * ago and not tried" the instant the desk pressed the button. On a row nobody
 * has ever touched the two columns are equal, which is the only case the
 * bucket is actually about.
 */
function actionableWhere(businessId: string, now: Date): Prisma.NotificationOutboxWhereInput {
  return {
    businessId,
    OR: [
      { status: 'failed' },
      {
        status: 'pending',
        attempts: 0,
        updatedAt: { lt: toDate(instant(fromDate(now) - UNTRIED_ALARM_MS)) },
      },
    ],
  };
}

export interface StuckNotification {
  id: string;
  /** Which bucket, decided once (see `StuckKind`). */
  kind: StuckKind;
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

/**
 * The failed, the never-tried and the still-trying, newest first. Capped: this
 * is a screen somebody reads, and a thousand rows on it is the same as none.
 *
 * `now` is a PARAMETER — the untried bucket is an age question, and this
 * package's discipline is that nothing below a job boundary reads a clock.
 */
export async function listStuckNotifications(
  db: Db,
  businessId: string,
  args: { now: Date; limit?: number },
): Promise<StuckNotification[]> {
  const rows = await db.notificationOutbox.findMany({
    where: {
      OR: [
        // The same predicate the badge counts, never a second copy of it.
        actionableWhere(businessId, args.now),
        { businessId, status: 'pending', attempts: { gt: 0 } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: args.limit ?? 100,
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
    kind: row.status === 'failed' ? 'given-up' : row.attempts === 0 ? 'never-tried' : 'retrying',
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

/**
 * How many NOBODY HAS BEEN TOLD ABOUT — the number worth putting in front of
 * somebody. A row still working through its backoff is not a number anybody
 * should act on, and counting it would train the desk to ignore the badge.
 *
 * A-108 renamed this from `countFailedNotifications` rather than widening it
 * in place: it counted `failed` alone while the screen beside it grew a second
 * actionable bucket, and a badge reading 0 next to a list of 713 is worse than
 * no badge. The predicate is `actionableWhere`, shared with the listing —
 * `notifications.test.ts` asserts the two agree on a book that has all three
 * kinds in it, which is the only fixture where they CAN disagree.
 */
export async function countUnsentNotifications(db: Db, businessId: string, now: Date): Promise<number> {
  return db.notificationOutbox.count({ where: actionableWhere(businessId, now) });
}

/** Whether a row's kind is one the badge counts — exported so a test can
 *  compare the two answers rather than restating the rule. */
export function isActionable(kind: StuckKind): boolean {
  return ACTIONABLE_KINDS.includes(kind);
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
