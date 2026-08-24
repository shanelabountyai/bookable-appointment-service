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
  /**
   * The appointment this notification is ABOUT, as a real foreign key.
   *
   * Not optional-because-nobody-needs-it: this is what makes "was she actually
   * told?" one indexed lookup on the appointment detail panel (operator R-4),
   * and what makes `onDelete: Restrict` protect a notified appointment from
   * deletion. Absent only for notifications that genuinely have no appointment
   * — a future business-level announcement.
   *
   * Demo checkpoint 1 found this missing: the column and its index were added
   * at the M1 boundary and NOTHING ever wrote them, so all 228 seeded outbox
   * rows carried `appointmentId = NULL`. The id was in the payload JSON, which
   * looks identical in a passing test and is unusable as a lookup. Invisible
   * from inside A-003, A-004 and A-009 alike — each was correct on its own.
   */
  appointmentId?: string | null;
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

  // A-048 — `createMany({ skipDuplicates })` rather than create-and-catch.
  //
  // THE CATCH VERSION DID NOT WORK INSIDE A TRANSACTION, which is where the
  // main caller runs it: a booking enqueues its confirmation inside the
  // booking's own transaction (that coupling is the whole point of this
  // module). Postgres ABORTS a transaction on a constraint violation, so the
  // recovery read that followed the catch failed with "current transaction is
  // aborted" and the caller got an unknown error instead of `duplicate` — the
  // booking rolled back rather than being idempotent. Measured, not reasoned:
  // the same call outside a transaction returned `duplicate` correctly, which
  // is why every test of this path passed.
  //
  // `skipDuplicates` never raises, so the transaction stays healthy and the
  // read below is an ordinary query. The uniqueness guarantee is unchanged —
  // it is still the database's index doing the work.
  const written = await db.notificationOutbox.createMany({
    data: [
      {
        businessId: input.businessId,
        dedupeKey: input.dedupeKey,
        appointmentId: input.appointmentId ?? null,
        channel: input.channel,
        template: input.template,
        recipient,
        payload: input.payload as Prisma.InputJsonValue,
        status: suppressedReason ? 'suppressed' : 'pending',
        lastError: suppressedReason ? `suppressed:${suppressedReason}` : null,
      },
    ],
    skipDuplicates: true,
  });

  // One read either way: `createMany` does not return rows, and the duplicate
  // case has to return the EXISTING decision unchanged.
  const row = await db.notificationOutbox.findUniqueOrThrow({
    where: { dedupeKey: input.dedupeKey },
    select: { id: true, status: true },
  });

  // `count === 0` is the invariant holding, not a failure: some other call —
  // a retried write path, a re-run job, a concurrent one — already decided
  // this exact notification.
  return { outcome: written.count === 1 ? 'recorded' : 'duplicate', id: row.id, status: row.status };
}
