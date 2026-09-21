/**
 * A-018 — RUNNING LATE (APPT-03, D-22).
 *
 * The Milestone 1 operator review's headline finding, in one sentence: the
 * system could record that an appointment RAN late, but not that the day IS
 * late. At 11:05 with Dana forty minutes behind, the website was still selling
 * her 11:15 while that client sat in the waiting area — so the desk keeps a
 * sticky note, and a shadow calendar kills the product by week two.
 *
 * A STORED DELTA, not a rewrite of `startAt`. Rewriting would change the time
 * on the confirmation the client is already holding, and would make "she was
 * booked for 2 but seen at 2:40" unanswerable afterwards. "Push the column"
 * (`pushColumn`, below) is the separate, explicit, audited action that *does*
 * rewrite it.
 *
 * NOT DERIVED FROM `startedAt`. Check-in discipline collapses exactly when the
 * desk is three deep, which is when the delta matters most — so it is a claim
 * somebody makes, with their name on it.
 */
import type { Actor } from '../../core/auth';
import { type AppointmentStatus, type BusyInterval, STILL_ON_THEIR_WAY_STATUSES, isPushable } from '../../core/scheduling';
import { type Instant, fromDate, instant, toDate } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

const MIN = 60_000;

/** A-059. One "I've already rung her", as stored. */
export interface ToldMark {
  appointmentId: string;
  /** The delta the call was about. Not necessarily the delta now — see
   *  `LateCallRow.stale`. */
  minutesToldAbout: number;
  toldByActor: string;
  actorRef: string | null;
  createdAt: Date;
}

export interface RunningLate {
  id: string;
  providerId: string;
  day: string;
  minutes: number;
  setByActor: string;
  actorRef: string | null;
  /** D-63(1). When the desk made the claim; a push does not move it. */
  claimedAt: Date;
  updatedAt: Date;
  /** A-059. Who the desk has already got to about THIS delta. */
  told: ToldMark[];
}

/**
 * "Dana is 40 behind." One tap, and one tap to clear.
 *
 * Zero or less CLEARS rather than storing a zero: "on time" is the absence of
 * a claim, and a stored zero would leave the day view rendering "+0 min" —
 * which reads as a system that thinks lateness is interesting when it is not.
 */
export async function setRunningLate(
  db: Db,
  args: {
    businessId: string;
    providerId: string;
    day: string;
    minutes: number;
    actor: Actor;
    /** D-63(1). A desk claim passes its instant and is stamped `claimedAt`;
     *  a push (D-43) passes null, because rewriting the number is not a new
     *  claim about the chair. Required, so no caller can forget to say which. */
    now: Date | null;
  },
): Promise<RunningLate | null> {
  if (!Number.isInteger(args.minutes)) {
    throw new RangeError(`Running-late minutes must be a whole number, got: ${args.minutes}`);
  }
  if (args.minutes <= 0) {
    await clearRunningLate(db, args);
    return null;
  }

  const row = await db.providerRunningLate.upsert({
    where: { providerId_day: { providerId: args.providerId, day: args.day } },
    create: {
      businessId: args.businessId,
      providerId: args.providerId,
      day: args.day,
      minutes: args.minutes,
      setByActor: args.actor.type,
      actorRef: args.actor.ref,
      // A push only ever REDUCES an existing row, so it never creates one; the
      // fallback is for completeness, not a path anything takes.
      claimedAt: args.now ?? new Date(),
    },
    update: {
      minutes: args.minutes,
      setByActor: args.actor.type,
      actorRef: args.actor.ref,
      ...(args.now ? { claimedAt: args.now } : {}),
    },
    include: { told: true },
  });

  return toRunningLate(row);
}

export async function clearRunningLate(
  db: Db,
  args: { providerId: string; day: string },
): Promise<void> {
  await db.providerRunningLate.deleteMany({ where: { providerId: args.providerId, day: args.day } });
}

/**
 * D-43 — WHAT A PUSH LEAVES THE DELTA AT.
 *
 * A-018 built the delta and the push in one item as deliberately different
 * mechanisms and never introduced them to each other: the desk sets +40, Dana
 * does not catch up, they push the column +40 — and the delta is still 40. Every
 * chip then projects a delay onto a `startAt` that already has it, the
 * ring-round lists clients to phone about a delay baked into their booked times,
 * and the engine keeps subtracting forty minutes from a column that is now
 * honest.
 *
 * PURE, and called by BOTH the preview and the push, so the number the desk is
 * shown before committing cannot disagree with the number it gets. The write
 * lives inside the push's own transaction — a second write path that "usually"
 * runs afterwards is how this comes back.
 *
 * Three arms, and the two that do nothing are the decision:
 *  - CLEAN push: reduce by the pushed minutes, floored at zero. Zero deletes the
 *    row, exactly as "Back on time" does — "on time" is the absence of a claim.
 *  - PARTIAL push: nothing. The cascade propagates BACKWARDS in time (a stayer
 *    blocks what would shift ONTO it, which starts earlier), so "some moved"
 *    does not mean "the front moved" — reducing would strip the delta from
 *    precisely the clients it is still true of.
 *  - PULL FORWARD (negative, A-059): nothing. Reducing by a negative would RAISE
 *    a lateness claim because the salon got ahead; clearing would be guessing
 *    "she has caught up entirely" from a -10 nudge, and D-22's whole point is
 *    that the claim is somebody's, with their name on it.
 */
export function deltaAfterPush(args: { current: number; minutes: number; leftBehind: number }): number {
  if (args.minutes <= 0 || args.leftBehind > 0) return args.current;
  return Math.max(0, args.current - args.minutes);
}

export async function findRunningLate(
  db: Db,
  args: { businessId: string; day: string },
): Promise<RunningLate[]> {
  const rows = await db.providerRunningLate.findMany({
    where: { businessId: args.businessId, day: args.day },
    include: { told: true },
  });
  return rows.map(toRunningLate);
}

/**
 * The delta as the engine sees it (D-22): a `running-late` BusyInterval
 * spanning from NOW to now + the delta.
 *
 * From `now`, not from the appointment that overran: the claim is "the next
 * forty minutes of this column are already spoken for", which is exactly the
 * thing a paper day-sheet conveys and software usually cannot. The engine
 * excludes those candidates with `provider-running-late` — its own reason, so
 * the day view can say "Dana is behind" rather than "unavailable".
 *
 * Returns nothing when the delta has been worked off, which needs no cleanup
 * job: the interval simply stops covering anything.
 */
export function runningLateInterval(late: RunningLate, now: Date): BusyInterval | null {
  if (late.minutes <= 0) return null;
  const start = fromDate(now);
  const end = instant(start + late.minutes * MIN);
  return { start, end: end as Instant, kind: 'running-late', id: `running-late:${late.providerId}` };
}

function toRunningLate(row: {
  id: string;
  providerId: string;
  day: string;
  minutes: number;
  setByActor: string;
  actorRef: string | null;
  claimedAt: Date;
  updatedAt: Date;
  told?: ToldMark[];
}): RunningLate {
  return {
    id: row.id,
    providerId: row.providerId,
    day: row.day.trim(),
    minutes: row.minutes,
    setByActor: row.setByActor,
    actorRef: row.actorRef,
    claimedAt: row.claimedAt,
    updatedAt: row.updatedAt,
    told: (row.told ?? []).map((t) => ({
      appointmentId: t.appointmentId,
      minutesToldAbout: t.minutesToldAbout,
      toldByActor: t.toldByActor,
      actorRef: t.actorRef,
      createdAt: t.createdAt,
    })),
  };
}

// ─────────────────── A-059: the ring-round the delta implies ───────────────────

/**
 * HOW FAR AHEAD THE LIST LOOKS.
 *
 * Three hours, not the rest of the day. A delta is a claim about how the
 * column is running NOW, and by five o'clock either it has been worked off or
 * the column has been pushed (APPT-04) — so a list running to closing would be
 * mostly names nobody should ring yet, and a list of forty is a list of none.
 *
 * ponytail: a constant, not a business setting. Nobody has asked for a second
 * value, and a knob here would be a settings row that never moves.
 */
export const CALL_AHEAD_MINUTES = 180;

/**
 * D-62 (A-130) — HOW LATE EACH CLIENT IS, NOT HOW LATE THE COLUMN IS.
 *
 * The delta is one claim about the column; the projection used to be that
 * claim added flat to every start. So when the 14:00 cancelled in a column
 * forty behind, the 15:00 and 16:00 were still "likely 15:40/16:40" and still
 * on the ring-round, although the 13:00 in the chair is out by 14:40 and the
 * 15:00 will be seen on time.
 *
 * A CASCADE: the first live appointment still occupying time carries the
 * whole delta; every later one starts at the later of its booked start and the
 * latest projected END before it (envelopes, so buffers are kept). Cancelled
 * and released time is not in the chain, so it is a hole the delay drains
 * into. CAPPED at the delta — an override stacked on a neighbour must not read
 * as later than the claim anybody made.
 *
 * The chain is `isPushable`: whose time the delay can actually move. The
 * stored delta and the engine's interval (D-22, D-43) are untouched — this is
 * a READ of the claim, never a rewrite of it.
 *
 * D-63(1) (A-132) — WHO HEADS IT. D-62 dropped a member when her BOOKED
 * envelope ended, so at 13:56 the client still in the chair left the chain and
 * the 15:00 inherited the whole +40 back — and a no-show, which is always
 * marked after the chair's booked end, could never be a hole at all. So:
 *  - the client IN THE CHAIR (`in_progress`, or `checked_in` past her start —
 *    D-22: "start" is the tap that goes when the desk is three deep) is the
 *    head whatever her booked end, projected to end at booked end + delta.
 *    The latest-starting one, so an `in_progress` somebody forgot at 11:00
 *    cannot seed the afternoon;
 *  - nobody in the chair, and she was checked out at or after the claim: the
 *    chain starts at the checkout (plus her after-buffer) and nobody after her
 *    inherits the delta — the stylist is free from that moment;
 *  - otherwise D-62 as built: the first member still occupying time carries
 *    the whole delta. A claim made with an empty chair lands whole.
 *
 * Returns minutes late per appointment id, 0 included. Nothing absent from
 * the map is late.
 */
export function projectedDelays(args: {
  appointments: readonly {
    id: string;
    status: string;
    startAt: Date;
    endAt: Date;
    occupiesStart: Date;
    occupiesEnd: Date;
    endedAt: Date | null;
  }[];
  late: Pick<RunningLate, 'minutes' | 'claimedAt'> | null;
  now: Date;
}): Map<string, number> {
  const delays = new Map<string, number>();
  const minutes = args.late?.minutes ?? 0;
  if (!args.late || minutes <= 0) return delays;
  const now = args.now.getTime();

  const head = args.appointments
    .filter((a) => a.status === 'in_progress' || (a.status === 'checked_in' && a.startAt.getTime() <= now))
    .sort((a, b) => b.startAt.getTime() - a.startAt.getTime())[0];

  const checkout = head
    ? undefined
    : args.appointments
        .filter(
          (a) =>
            a.status === 'completed' &&
            a.endedAt !== null &&
            a.endedAt.getTime() >= args.late!.claimedAt.getTime() &&
            a.endedAt.getTime() <= now,
        )
        .sort((a, b) => b.endedAt!.getTime() - a.endedAt!.getTime())[0];

  const chain = args.appointments
    .filter((a) => a === head || (isPushable(a.status as AppointmentStatus) && a.occupiesEnd.getTime() > now))
    .sort((a, b) => a.occupiesStart.getTime() - b.occupiesStart.getTime());

  let busyUntil = checkout
    ? fromDate(checkout.endedAt!) + Math.max(0, checkout.occupiesEnd.getTime() - checkout.endAt.getTime())
    : -Infinity;
  for (const a of chain) {
    const start = fromDate(a.occupiesStart);
    const late =
      a === head || busyUntil === -Infinity
        ? minutes
        : Math.min(minutes, Math.max(0, Math.ceil((busyUntil - start) / MIN)));
    delays.set(a.id, late);
    busyUntil = Math.max(busyUntil, fromDate(a.occupiesEnd) + late * MIN);
  }
  return delays;
}

/** One row of "who has to be rung", already decided. */
export interface LateCallRow {
  appointmentId: string;
  /** Null for a walk-in with no record (BOOK-04) — she is still on the list,
   *  because the desk may well have her number on a scrap of paper. */
  clientId: string | null;
  clientName: string | null;
  clientPhone: string | null;
  status: string;
  /** The time on her confirmation. It has not changed and must still be shown:
   *  the delta moves nothing (D-22). */
  scheduled: Date;
  /** What she is actually likely to be seen at — scheduled + the delta, on the
   *  PHYSICAL axis so a projection across a DST transition lands where the
   *  clock will really be. */
  projected: Date;
  /** D-62. HER delay, which is the delta only when nothing ahead of her
   *  absorbed any of it. What a "Told them" tap records. */
  lateMinutes: number;
  /** D-62. She was rung about a delay and there no longer is one — the call
   *  to make now is "come at your booked time". */
  onTime: boolean;
  /** CLIENT-03's pinned note, carried through from the chip. */
  note: string | null;
  told: ToldMark | null;
  /**
   * She was rung about a materially different number. The tick stays — she HAS
   * been spoken to — but a screen that showed it plainly would be telling the
   * desk that a client who was promised twenty minutes knows about fifty.
   */
  stale: boolean;
}

/**
 * Beyond this much drift from what she was told, the call is worth making
 * again. Fifteen minutes because it is the default slot interval and so the
 * smallest unit the book moves in; below it, ringing a client back to shave
 * five minutes off an estimate is the salon fussing.
 *
 * ponytail: a constant, not `business.slotIntervalMinutes`. Reading the
 * setting would tie "is this call worth repeating" to the grid's granularity,
 * which are unrelated questions that happen to share a number today.
 */
const STALE_AFTER_MINUTES = 15;

/**
 * WHO THE DESK STILL HAS TO RING (APPT-03).
 *
 * A pure function over the column the day view already loaded — no query, no
 * clock of its own, `now` passed in like everything else in this project.
 *
 * The filter is deliberately narrow on both axes:
 *  - `STILL_ON_THEIR_WAY_STATUSES`, so nobody in the building is on it. Ringing
 *    a client sitting in the waiting area to say the salon is running late is
 *    the salon announcing it does not know who is in it.
 *  - starting inside the next `CALL_AHEAD_MINUTES`, and not already started.
 *
 * Ordered by scheduled time, because the desk works down it in the order the
 * clients will arrive, and the first name is the most urgent call.
 */
export function lateCallList(args: {
  appointments: readonly {
    id: string;
    startAt: Date;
    occupiesStart: Date;
    occupiesEnd: Date;
    status: string;
    clientId: string | null;
    clientName: string | null;
    clientPhone: string | null;
    clientNotes: string | null;
    /** D-62/D-63. `projectedDelays`, computed once by the column. */
    lateMinutes: number;
  }[];
  now: Date;
  told: readonly ToldMark[];
  horizonMinutes?: number;
}): LateCallRow[] {
  const now = fromDate(args.now);
  const horizon = now + (args.horizonMinutes ?? CALL_AHEAD_MINUTES) * MIN;
  const toldBy = new Map(args.told.map((t) => [t.appointmentId, t]));

  return args.appointments
    .filter((a) => (STILL_ON_THEIR_WAY_STATUSES as readonly string[]).includes(a.status))
    .filter((a) => fromDate(a.startAt) >= now && fromDate(a.startAt) < horizon)
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
    .map((a) => {
      const told = toldBy.get(a.id) ?? null;
      const late = a.lateMinutes;
      const stale = told !== null && Math.abs(late - told.minutesToldAbout) >= STALE_AFTER_MINUTES;
      return {
        appointmentId: a.id,
        clientId: a.clientId,
        clientName: a.clientName,
        clientPhone: a.clientPhone,
        status: a.status,
        scheduled: a.startAt,
        projected: toDate(instant(fromDate(a.startAt) + late * MIN)),
        lateMinutes: late,
        onTime: late === 0,
        note: a.clientNotes,
        told,
        stale,
      };
    })
    // D-62. On time and nobody told her otherwise (or told her a delay too
    // small to be worth undoing): there is no call to make.
    .filter((row) => row.lateMinutes > 0 || row.stale);
}

/**
 * "I've rung her." A tick, with a name and a time on it.
 *
 * SENDS NOTHING, and that is the decision rather than an omission (D-14 still
 * has no driver). A button here that queued a message would put "queued"
 * beside a client's name — A-044's finding was that staff read that as "no
 * need to call her", which is the precise opposite of what this list is for.
 *
 * Returns null when the delta has been cleared out from under the tick: the
 * mark belongs to a claim, so with no claim there is nothing to mark.
 */
export async function markToldAbout(
  db: Db,
  args: {
    businessId: string;
    providerId: string;
    day: string;
    appointmentId: string;
    actor: Actor;
    /** D-62. HER delay as the desk read it off the row. Clamped to
     *  [0, the delta]; absent means the delta, which is her delay whenever
     *  nothing ahead of her has absorbed any of it. */
    minutes?: number;
  },
): Promise<ToldMark | null> {
  const late = await db.providerRunningLate.findUnique({
    where: { providerId_day: { providerId: args.providerId, day: args.day } },
  });
  if (!late || late.businessId !== args.businessId) return null;
  const told =
    args.minutes !== undefined && Number.isInteger(args.minutes)
      ? Math.min(late.minutes, Math.max(0, args.minutes))
      : late.minutes;

  const row = await db.runningLateTold.upsert({
    where: { runningLateId_appointmentId: { runningLateId: late.id, appointmentId: args.appointmentId } },
    create: {
      businessId: args.businessId,
      runningLateId: late.id,
      appointmentId: args.appointmentId,
      // HER delay AS IT IS NOW, so the row records what she was actually told
      // rather than whatever the number becomes later.
      minutesToldAbout: told,
      toldByActor: args.actor.type,
      actorRef: args.actor.ref,
    },
    // Ringing her a second time RE-STAMPS it: the useful fact is the most
    // recent call and the number it was about, not the first one.
    update: { minutesToldAbout: told, toldByActor: args.actor.type, actorRef: args.actor.ref },
  });

  return {
    appointmentId: row.appointmentId,
    minutesToldAbout: row.minutesToldAbout,
    toldByActor: row.toldByActor,
    actorRef: row.actorRef,
    createdAt: row.createdAt,
  };
}

/**
 * Untick. A mis-tap on a shared screen otherwise leaves a client permanently
 * marked as told until the whole delta is cleared, and the desk cannot see
 * which of the two it was — so the tick has to be reversible by the same hand.
 */
export async function unmarkToldAbout(
  db: Db,
  args: { businessId: string; providerId: string; day: string; appointmentId: string },
): Promise<void> {
  const late = await db.providerRunningLate.findUnique({
    where: { providerId_day: { providerId: args.providerId, day: args.day } },
  });
  if (!late || late.businessId !== args.businessId) return;

  await db.runningLateTold.deleteMany({
    where: { runningLateId: late.id, appointmentId: args.appointmentId },
  });
}
