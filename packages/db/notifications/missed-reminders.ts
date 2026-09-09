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
import { REMINDER_LEAD_MS, REMINDER_TEMPLATE } from '../../core/notifications';
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
 * Everybody starting inside the next 24 hours who holds no reminder row.
 *
 * FOUR PREDICATES, and the third is the one without which this screen fills
 * with permanent false rows and stops being read:
 *
 *  1. Eligible status — `REMINDER_ELIGIBLE_STATUSES`, the same allow-list the
 *     sweep itself uses (D-7). A cancelled appointment is not a missed
 *     reminder.
 *  2. Starting in `[now, now + 24h)` — inside the lead window, so its reminder
 *     moment has passed. Bounded below at `now` because this is a screen to
 *     ACT on: nobody can be usefully reminded about this morning.
 *  3. BOOKED EARLY ENOUGH TO HAVE BEEN SWEPT — `createdAt <= startAt - 24h`.
 *     An appointment made this morning for this afternoon was never eligible
 *     for a 24-hour reminder and never will be; without this, every same-day
 *     booking joins the list permanently and the desk learns to ignore it.
 *     Applied in TypeScript rather than SQL because it compares two columns
 *     with arithmetic between them, which Prisma's filter language cannot say
 *     — and the candidate set is one day of one salon's book.
 *  4. No reminder row — `none`, over the outbox relation. This is what makes
 *     the answer true regardless of WHY: a gap in the sweep, a sweep that
 *     threw, a job nobody ever scheduled.
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
      notifications: { none: { template: REMINDER_TEMPLATE } },
    },
    orderBy: { startAt: 'asc' },
    take: args.limit ?? 100,
    select: {
      id: true,
      startAt: true,
      createdAt: true,
      client: { select: { name: true, phone: true, email: true } },
    },
  });

  return rows
    .filter((row) => fromDate(row.createdAt) <= fromDate(row.startAt) - REMINDER_LEAD_MS)
    .map((row) => ({
      appointmentId: row.id,
      startAt: row.startAt,
      clientName: row.client?.name ?? null,
      phone: row.client?.phone ?? null,
      email: row.client?.email ?? null,
    }));
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
