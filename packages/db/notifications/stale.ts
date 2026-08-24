/**
 * A-054 (demo checkpoint 4) — A MESSAGE THAT STOPPED BEING TRUE BEFORE IT WAS
 * SENT.
 *
 * `enqueueNotification` decides, `dispatchPendingNotifications` sends, and
 * between those two moments the world moves: she rings and cancels, or the
 * desk moves her to Wednesday. The dispatcher sent the row regardless, because
 * a queued row was assumed to still describe reality.
 *
 * Walked at the seam and confirmed: an appointment cancelled a minute after
 * the reminder was enqueued produced BOTH the cancellation notice AND, after
 * it, a reminder for the appointment she had just cancelled.
 *
 * A-051 turned that from a race into a window. Before it, enqueue and dispatch
 * ran back to back in one cron request and the exposure was milliseconds; a
 * transient provider failure now legitimately holds a row for up to two and a
 * half hours, and the walk sent a reminder naming Tuesday for an appointment
 * that had moved to Wednesday.
 *
 * ONLY THE REMINDER CAN GO STALE, and that is a property of what it says
 * rather than a shortcut. Every other template reports something that
 * HAPPENED — booked, moved, cancelled, running late — and a fact about the
 * past is still true when it arrives late. The reminder is the one message
 * that makes a claim about the FUTURE ("you have an appointment tomorrow at
 * two"), which is the only kind of claim the world can falsify while the
 * message sits in a queue.
 */
import { REMINDER_ELIGIBLE_STATUSES } from '../../core/scheduling';
import { fromDate, instantFromIso } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** The template whose claim is about the future. */
const REMINDER_TEMPLATE = 'appointment.reminder';

export interface QueuedMessage {
  template: string;
  appointmentId: string | null;
  payload: unknown;
}

/**
 * Why this message should not be sent, or null to send it.
 *
 * A SENTENCE-SHAPED CODE, kept on the row: `lastError` is what the "messages
 * that did not go out" screen (A-051) renders, and "the appointment moved" is
 * the difference between a desk that shrugs and a desk that checks.
 */
export async function staleReason(db: Db, message: QueuedMessage): Promise<string | null> {
  if (message.template !== REMINDER_TEMPLATE) return null;
  // A reminder with no appointment is not a reminder this product writes; if
  // one ever exists there is nothing to check it against, so it goes.
  if (!message.appointmentId) return null;

  const appointment = await db.appointment.findUnique({
    where: { id: message.appointmentId },
    select: { status: true, startAt: true },
  });
  if (!appointment) return 'stale:the appointment no longer exists';

  if (!(REMINDER_ELIGIBLE_STATUSES as readonly string[]).includes(appointment.status)) {
    // The SAME list `sendDueReminders` selects on, asked a second time at the
    // moment of sending. One list, two moments — never a second copy of the
    // statuses, which is the trap CLAUDE.md names about status enums.
    return `stale:the appointment is ${appointment.status.replace('_', ' ')}`;
  }

  // MOVED. Compared on the INSTANT the message actually carries, not on a
  // day or a wall time: the payload holds an offset-bearing ISO string (D-4),
  // and on fall-back day two different instants share a label.
  const promised = (message.payload as { startAt?: unknown } | null)?.startAt;
  if (typeof promised === 'string') {
    // Through the ONE conversion module — `Date.parse` is banned repo-wide,
    // and it is banned precisely because a string that looks like a time is
    // where the two axes get crossed. `instantFromIso` refuses anything
    // without an explicit offset, which is what the payload always carries.
    let promisedAt: number | null = null;
    try {
      promisedAt = instantFromIso(promised);
    } catch {
      promisedAt = null;
    }
    if (promisedAt !== null && promisedAt !== fromDate(appointment.startAt)) {
      // Not an error: `sendDueReminders` keys on `reminder-24h:{id}:{startAt}`
      // (P1-7), so the window catches the NEW time on its own and enqueues a
      // fresh reminder. Suppressing this one is what lets that be the only
      // reminder she gets.
      return 'stale:the appointment moved to a different time';
    }
  }

  return null;
}
