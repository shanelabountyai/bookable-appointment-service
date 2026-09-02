/**
 * A-076 / D-46 — WHAT IS STILL OPEN (APPT-01, APPT-03, RPT-01).
 *
 * Six o'clock Saturday. Twenty-nine appointments went through. Check-in got
 * tapped most of the time, because the client was standing there. "Complete"
 * got tapped maybe two-thirds of the time, because at the till you are taking
 * money, rebooking her for six weeks and answering the phone. **Eleven
 * appointments are still sitting on `booked` or `checked_in`, forever, and
 * before this file nothing anywhere ever mentioned them again.**
 *
 * WHAT THOSE ELEVEN ROWS DO. `dashboard.ts` counts minutes for `completed` and
 * `no_show` only, so utilization is understated every week and the owner staffs
 * Tuesdays on it. `lapsed.ts` takes each client's most recent COMPLETED visit,
 * so a regular who was in three weeks ago on an unclosed ticket reads as
 * lapsed and gets rung with "we haven't seen you in a while" — and A-073's own
 * row says a wrong definition means the report is never opened again.
 * `reliability.ts` counts by status, so a no-show nobody tapped never fires
 * CLIENT-04's block. Three readers, all wrong, all because of eleven taps.
 *
 * D-46: **NOTHING DERIVES ATTENDANCE FROM SILENCE.** No report changes, no job
 * auto-completes anything. The silence is identical whether she came and
 * nobody tapped or she never came and nobody tapped, and those two have
 * opposite consequences for her twelve-month record. This file is the SCREEN
 * that lets the desk say which, and the reports become right because they are
 * being told the truth rather than because they started guessing.
 *
 * DERIVED, nothing stored — the same reflex as `/staff/opened` and the
 * call-down: an appointment stops being unfinished the moment somebody closes
 * it, so a stored flag would need clearing code in every path that touches a
 * status.
 */
import { PUSHABLE_STATUSES } from '../../core/scheduling';
import { fromDate, instant, toDate } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

const DAY_MS = 86_400_000;

/**
 * How far back the list looks. Long enough to catch a fortnight nobody closed,
 * short enough that the count on the toolbar stays a number the desk acts on
 * rather than a backlog it learns to ignore — the same reasoning
 * `FREED_LOOKBACK_DAYS` uses, and the same failure if it is unbounded.
 *
 * APPT-06's correction window is seven days, so anything older than this is
 * beyond fixing by a mis-tap correction anyway.
 */
export const UNFINISHED_LOOKBACK_DAYS = 21;

/**
 * A-081 (D-48). The bound above is the right DEFAULT and the wrong CEILING.
 *
 * D-46's whole argument is that the reports become right because the desk can
 * tell them the truth — and until now the only surface that lets it went blind
 * at day 22, permanently. Measured on a freshly seeded book: 176 rows past and
 * still open, of which the screen offered the 0 that fell inside three weeks.
 * Every one of those is a row `dashboard.ts`, `lapsed.ts` and `reliability.ts`
 * are wrong about, with no door left to fix it through.
 *
 * So the number is a control ON the screen — the same shape and the same
 * reasoning as `LAPSED_WEEKS` on A-073's report: a salon closing out a
 * fortnight and an owner clearing a year's backlog both want to slide it while
 * looking at the answer, and the default stays 21 so the toolbar badge remains
 * a number the desk acts on rather than a backlog it learns to ignore.
 *
 * Two years, because the ceiling exists to stop a hand-typed URL asking for a
 * table scan, not to express a policy — CLIENT-04's reliability window is
 * twelve months and nothing reads further back than that.
 */
export const UNFINISHED_MAX_LOOKBACK_DAYS = 730;

/**
 * The one predicate, asked by both readers below.
 *
 * `listUnfinished` and `countUnfinished` are the LIST and the BADGE for the
 * same question, and the badge is how the desk learns the list exists. Two
 * copies of this `where` is two definitions of "unfinished" — the shape
 * CLAUDE.md keeps out, and the shape that would now also have to agree about
 * the clamp.
 */
function unfinishedWhere(args: { businessId: string; now: Date; lookbackDays?: number }) {
  const since = toDate(
    instant(fromDate(args.now) - (args.lookbackDays ?? UNFINISHED_LOOKBACK_DAYS) * DAY_MS),
  );
  return {
    businessId: args.businessId,
    status: { in: [...PUSHABLE_STATUSES] },
    // PAST — the appointment's own END, not its start: a visit still running
    // at six o'clock is not unfinished, it is in progress.
    endAt: { lt: args.now, gte: since },
    // A provider who has left cannot be asked what happened (A-041), and her
    // column is not what the desk is closing out tonight.
    provider: { is: { active: true } },
  };
}

/**
 * The clamp, next to the bounds it clamps to — a surface that re-derives it is
 * the second copy again, and `days` arrives off a URL anybody can type.
 */
export function clampLookbackDays(asked: string | undefined): number {
  const n = Number(asked);
  return Number.isFinite(n) && n >= 1 && n <= UNFINISHED_MAX_LOOKBACK_DAYS
    ? Math.floor(n)
    : UNFINISHED_LOOKBACK_DAYS;
}

export interface UnfinishedAppointment {
  id: string;
  startAt: Date;
  /** The business day it happened on, for grouping the list the way the desk
   *  thinks about it: "last Saturday" rather than a run of instants. */
  startDay: string;
  providerName: string;
  clientName: string | null;
  serviceNames: string[];
  /** Where it got to before everybody got busy — `booked`, `confirmed` or
   *  `checked_in`. The desk reads it: one of these means she was seen to
   *  arrive and the other two do not. */
  status: string;
  /** What the visit was worth, from its OWN line prices (D-16). This is the
   *  money the utilization number is missing. */
  valueCents: number;
}

/**
 * Appointments whose time has passed and which nobody ever closed.
 *
 * `now` is injected, never read from the clock here — the same discipline as
 * `listOpenedSlots` and `clientReliability`.
 *
 * The status list is `PUSHABLE_STATUSES`, derived rather than hand-typed, and
 * it is exactly the right list by coincidence of meaning rather than by luck:
 * "could still be moved by a push" and "has not reached an end state" are the
 * same set. `in_progress` is in it — a visit left running since Saturday is as
 * unclosed as one left on `booked`.
 */
export async function listUnfinished(
  db: Db,
  args: { businessId: string; now: Date; lookbackDays?: number },
): Promise<UnfinishedAppointment[]> {
  const rows = await db.appointment.findMany({
    where: unfinishedWhere(args),
    orderBy: { startAt: 'asc' },
    select: {
      id: true,
      startAt: true,
      startDay: true,
      status: true,
      provider: { select: { displayName: true } },
      client: { select: { name: true } },
      lines: { orderBy: { ordinal: 'asc' }, select: { priceCents: true, service: { select: { name: true } } } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    startAt: row.startAt,
    startDay: row.startDay.trim(),
    providerName: row.provider.displayName,
    clientName: row.client?.name ?? null,
    serviceNames: row.lines.map((line) => line.service.name),
    status: row.status,
    valueCents: row.lines.reduce((total, line) => total + line.priceCents, 0),
  }));
}

/** Just the count, for the toolbar badge — the whole point of the item is that
 *  the desk cannot know this list exists unless a number says so, which is what
 *  A-043 established with "Opened up (N)". */
export async function countUnfinished(
  db: Db,
  args: { businessId: string; now: Date; lookbackDays?: number },
): Promise<number> {
  return db.appointment.count({ where: unfinishedWhere(args) });
}
