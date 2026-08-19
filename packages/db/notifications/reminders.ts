/**
 * A-022 — THE REMINDER JOB (NOTIF-02, NOTIF-03).
 *
 * "Skips terminal/rescheduled-away" is two different guarantees built two
 * different ways:
 *
 *  - TERMINAL: `REMINDER_ELIGIBLE_STATUSES` (core/scheduling/status.ts) is a
 *    positive allow-list, `{booked, confirmed}` — the same discipline as
 *    every other status list in this codebase living in one place (D-7).
 *  - RESCHEDULED-AWAY: not a status at all (D-6 — reschedule is a same-row
 *    UPDATE). A rescheduled appointment is simply not found by THIS query at
 *    ITS NEW startAt until the window catches up to it again, and the old
 *    startAt it was rescheduled away FROM was never a row this query could
 *    match on a second pass. Nothing to skip, because nothing to find.
 *
 * "Exactly-once, idempotent under re-run" is `enqueueNotification`'s existing
 * dedupeKey contract (P1-7): `reminder-24h:{appointmentId}:{startAtEpochMs}`.
 * Embedding the target instant is what makes a reschedule produce a genuinely
 * NEW reminder for the new time rather than colliding with — or silently
 * reusing — a stale one.
 */
import { REMINDER_ELIGIBLE_STATUSES } from '../../core/scheduling';
import { reminderWindow } from '../../core/notifications';
import { fromDate, toDate } from '../../core/time';
import type { PrismaClient } from '../generated/client/index.js';
// Direct file import, not the `../appointments` barrel: that barrel pulls in
// reschedule.ts, which imports `../notifications` — importing the barrel here
// would close a cycle between the two packages' index files.
import { issueManageToken } from '../appointments/manage-token';
import { enqueueNotification } from './enqueue';

export interface ReminderRunResult {
  /** How many appointments matched the window this run. */
  due: number;
  /** New outbox rows actually written. */
  enqueued: number;
  /** Already had a row from an earlier run (or an overlapping one) — no
   *  token touched, nothing sent twice. */
  duplicate: number;
}

/**
 * Enqueues (never sends — see dispatch.ts) exactly one reminder for every
 * appointment starting in `[now+24h, now+24h+5m)`.
 *
 * `now` is a parameter, read from the system clock exactly once, at the one
 * legitimate boundary — the route handler an external scheduler calls.
 * Nothing below this line reads a clock of its own.
 */
export async function sendDueReminders(prisma: PrismaClient, now: Date): Promise<ReminderRunResult> {
  const window = reminderWindow(fromDate(now));

  const due = await prisma.appointment.findMany({
    where: {
      status: { in: [...REMINDER_ELIGIBLE_STATUSES] },
      startAt: { gte: toDate(window.start), lt: toDate(window.end) },
    },
    orderBy: { startAt: 'asc' },
    select: {
      id: true,
      businessId: true,
      startAt: true,
      endAt: true,
      client: { select: { email: true, phone: true } },
    },
  });

  let enqueued = 0;
  let duplicate = 0;

  for (const appointment of due) {
    const dedupeKey = `reminder-24h:${appointment.id}:${fromDate(appointment.startAt)}`;

    // Checked BEFORE touching the token, not just left to enqueueNotification's
    // own unique-constraint catch: an interval trigger firing more often than
    // the window is wide (deliberately, so a late tick never leaves a gap —
    // X-4) will sweep the SAME appointment on consecutive runs. Reissuing a
    // token nobody is about to be sent would needlessly kill a link she may
    // already be holding from the FIRST run's message.
    //
    // ponytail: this check-then-act is not race-proof against two genuinely
    // CONCURRENT runs (the gap dispatch.ts already accepts for the same
    // reason — no second trigger exists yet beyond this one scheduled job).
    // Upgrade path if a second trigger ever appears: an advisory lock keyed
    // on `dedupeKey`, same pattern dispatch.ts names for its own claim race.
    const already = await prisma.notificationOutbox.findUnique({ where: { dedupeKey }, select: { id: true } });
    if (already) {
      duplicate++;
      continue;
    }

    const result = await prisma.$transaction(async (tx) => {
      // D-28: reissues rather than reuses. The raw token is never stored —
      // only its hash — so nothing later can recover the one already sent at
      // booking time. The reminder is itself a brand-new outgoing message, so
      // "the newest message's link is the live one" is the SAME rule D-5
      // already applies when a corrected phone number gets a resend; it is
      // not a special case invented here.
      const { token } = await issueManageToken(tx, {
        businessId: appointment.businessId,
        appointmentId: appointment.id,
        endAt: appointment.endAt,
        now,
      });

      return enqueueNotification(tx, {
        businessId: appointment.businessId,
        dedupeKey,
        appointmentId: appointment.id,
        channel: appointment.client?.email ? 'email' : 'sms',
        template: 'appointment.reminder',
        recipient: appointment.client?.email ?? appointment.client?.phone ?? null,
        payload: {
          appointmentId: appointment.id,
          startAt: appointment.startAt.toISOString(),
          // NOTIF-03: confirm/cancel actions ARE the manage page — it already
          // renders whichever of them the appointment's live status permits
          // (A-021), so this link is the whole of "carries the actions".
          manageUrl: `/manage/${token}`,
        },
      });
    });

    if (result.outcome === 'recorded') enqueued++;
    else duplicate++;
  }

  return { due: due.length, enqueued, duplicate };
}
