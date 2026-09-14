/**
 * A-108 / D-51 — WHO WAS NEVER REMINDED, AND WHETHER THE JOB IS RUNNING.
 *
 * `reminderWindow` is a 5-minute band anchored to `now`. Nothing catches it up
 * and, until this item, nothing anywhere recorded that the sweep had ever run
 * — so a deploy, a cold start, a 5xx or a rotated `CRON_SECRET` permanently
 * lost everybody starting inside that band, with no list to work and no screen
 * that could say a word about it.
 *
 * D-51 chose to DERIVE the cohort rather than enqueue a catch-up: the desk is
 * told who was missed and a person decides what to say to them. That is D-46's
 * argument one system over — the reports became right because the desk could
 * tell them the truth, not because the software started guessing — and it is
 * also the only half that works today, since there is no real channel to catch
 * up INTO (D-14, A-053 blocked).
 *
 * WHY THIS ASKS THE APPOINTMENTS AND NOT THE WATERMARK. A stored band
 * `[lastSweptThrough, thisWindowStart)` names how much time went unasked. It
 * does not name a person, it needs arithmetic that a second reader will
 * eventually get wrong, and it is blind in the one case that matters most: a
 * sweep that RAN and whose enqueue failed sits inside every band and still
 * reached nobody. Asking the appointments "who is due inside the lead window
 * and holds no reminder row" answers with names and phone numbers and cannot
 * miss that case. It is why `Business` grew exactly ONE column.
 */
import { REMINDER_LEAD_MS, REMINDER_TEMPLATE, reminderDedupeKey } from '../../core/notifications';
import { REMINDER_ELIGIBLE_STATUSES } from '../../core/scheduling';
import { fromDate, instant, toDate } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface MissedReminder {
  appointmentId: string;
  startAt: Date;
  clientName: string | null;
  /** BOTH, and rendered as both: the desk is going to ring or text this
   *  person, and a row with neither is itself worth seeing. */
  phone: string | null;
  email: string | null;
}

/**
 * The event types that REWRITE `startAt`. Both record both sides in their
 * payload (D-31), but it is their `createdAt` this file wants: the moment the
 * appointment came to be at the time it is at now.
 *
 * A third way to move an appointment belongs in this list — CLAUDE.md's "a
 * STATE CHANGE is never one edit" applies here as directly as anywhere, and
 * the cost of forgetting is a client who is silently never listed.
 */
export const MOVING_EVENT_TYPES = ['rescheduled', 'column_pushed'] as const;

/**
 * Everybody starting inside the next 24 hours whom nobody has reminded OF THE
 * TIME THEY ARE NOW BOOKED FOR.
 *
 * FOUR PREDICATES, and A-117 rewrote the last two because both of them asked
 * about the APPOINTMENT where the sweep asks about the INSTANT:
 *
 *  1. Eligible status — `REMINDER_ELIGIBLE_STATUSES`, the same allow-list the
 *     sweep itself uses (D-7). A cancelled appointment is not a missed
 *     reminder.
 *  2. Starting in `[now, now + 24h)` — inside the lead window, so its reminder
 *     moment has passed. Bounded below at `now` because this is a screen to
 *     ACT on: nobody can be usefully reminded about this morning.
 *  3. AT THIS TIME EARLY ENOUGH TO HAVE BEEN SWEPT — `movedAt <= startAt - 24h`,
 *     where `movedAt` is the latest event that rewrote `startAt`, else
 *     `createdAt`. An appointment made this morning for this afternoon was
 *     never eligible for a 24-hour reminder and never will be; without this,
 *     every same-day booking joins the list permanently and the desk learns to
 *     ignore it. And a visit MOVED into this afternoon is the same sentence
 *     about the same person — it was `createdAt` alone until A-117, which
 *     answered for a time she is no longer coming at.
 *  4. No reminder row FOR THIS START — `reminderDedupeKey(id, startAt)`, the
 *     sweep's own identity (P1-7), and the schema says so at `dedupeKey`. It
 *     was `none: { template }` until A-117: a client reminded for Saturday and
 *     moved to Wednesday holds a Saturday-keyed row, so she counted as told
 *     and dropped off a list she should have been at the top of, while the
 *     Wednesday sweep wrote her a second key. This is what makes the answer
 *     true regardless of WHY: a gap in the sweep, a sweep that threw, a job
 *     nobody ever scheduled, a move nobody swept after.
 *
 * 3 and 4 are applied in TypeScript rather than SQL because each compares a
 * row against a value derived from that same row, which Prisma's filter
 * language cannot say. The candidate set is one day of one salon's book, so
 * the `limit` is applied to the ANSWER rather than in the query — capping the
 * candidates would hide missed people behind reminded ones.
 */
export async function listMissedReminders(
  db: Db,
  args: { businessId: string; now: Date; limit?: number },
): Promise<MissedReminder[]> {
  const nowMs = fromDate(args.now);
  const rows = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      status: { in: [...REMINDER_ELIGIBLE_STATUSES] },
      startAt: { gte: args.now, lt: toDate(instant(nowMs + REMINDER_LEAD_MS)) },
    },
    orderBy: { startAt: 'asc' },
    select: {
      id: true,
      startAt: true,
      createdAt: true,
      client: { select: { name: true, phone: true, email: true } },
      notifications: { where: { template: REMINDER_TEMPLATE }, select: { dedupeKey: true } },
      events: {
        where: { type: { in: [...MOVING_EVENT_TYPES] } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
  });

  return rows
    .filter((row) => {
      const startMs = fromDate(row.startAt);
      const movedAt = row.events[0]?.createdAt ?? row.createdAt;
      if (fromDate(movedAt) > startMs - REMINDER_LEAD_MS) return false;
      const key = reminderDedupeKey(row.id, startMs);
      return !row.notifications.some((n) => n.dedupeKey === key);
    })
    .slice(0, args.limit ?? 100)
    .map((row) => ({
      appointmentId: row.id,
      startAt: row.startAt,
      clientName: row.client?.name ?? null,
      phone: row.client?.phone ?? null,
      email: row.client?.email ?? null,
    }));
}

/**
 * How many of them, for the shell badge — FROM `listMissedReminders` ITSELF,
 * never a second predicate.
 *
 * A-117: the badge was `countUnsentNotifications` alone, which counts OUTBOX
 * rows, and the failure D-51 exists for writes none. The operator skipped one
 * five-minute tick on a 43-appointment cohort: four ten o'clocks were never
 * reminded, the next tick drained everything else, and at 07:00 the badge read
 * 0 over a screen listing four people. A count that cannot see the cohort is
 * the checkpoint-6 class one layer up — a cheaper, weaker answer to the
 * question the screen beside it answers properly.
 *
 * ponytail: this runs the whole derivation to take its length, on every staff
 * page render. One day of one salon's book; if it ever shows up, cache the
 * NUMBER, never ask a cheaper question.
 */
export async function countMissedReminders(
  db: Db,
  args: { businessId: string; now: Date },
): Promise<number> {
  return (await listMissedReminders(db, args)).length;
}

/** When the sweep last ran for this business. NULL means it never has, which
 *  is a different sentence on the screen and not the same as "an hour ago". */
export async function lastReminderSweep(db: Db, businessId: string): Promise<Date | null> {
  const row = await db.business.findUnique({
    where: { id: businessId },
    select: { remindersLastRunAt: true },
  });
  return row?.remindersLastRunAt ?? null;
}
