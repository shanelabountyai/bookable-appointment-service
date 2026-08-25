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
import { type BusyInterval, STILL_ON_THEIR_WAY_STATUSES } from '../../core/scheduling';
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
  args: { businessId: string; providerId: string; day: string; minutes: number; actor: Actor },
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
    },
    update: { minutes: args.minutes, setByActor: args.actor.type, actorRef: args.actor.ref },
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
    status: string;
    clientId: string | null;
    clientName: string | null;
    clientPhone: string | null;
    clientNotes: string | null;
  }[];
  minutes: number;
  now: Date;
  told: readonly ToldMark[];
  horizonMinutes?: number;
}): LateCallRow[] {
  if (args.minutes <= 0) return [];

  const now = fromDate(args.now);
  const horizon = now + (args.horizonMinutes ?? CALL_AHEAD_MINUTES) * MIN;
  const toldBy = new Map(args.told.map((t) => [t.appointmentId, t]));

  return args.appointments
    .filter((a) => (STILL_ON_THEIR_WAY_STATUSES as readonly string[]).includes(a.status))
    .filter((a) => fromDate(a.startAt) >= now && fromDate(a.startAt) < horizon)
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
    .map((a) => {
      const told = toldBy.get(a.id) ?? null;
      return {
        appointmentId: a.id,
        clientId: a.clientId,
        clientName: a.clientName,
        clientPhone: a.clientPhone,
        status: a.status,
        scheduled: a.startAt,
        projected: toDate(instant(fromDate(a.startAt) + args.minutes * MIN)),
        note: a.clientNotes,
        told,
        stale: told !== null && Math.abs(args.minutes - told.minutesToldAbout) >= STALE_AFTER_MINUTES,
      };
    });
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
  args: { businessId: string; providerId: string; day: string; appointmentId: string; actor: Actor },
): Promise<ToldMark | null> {
  const late = await db.providerRunningLate.findUnique({
    where: { providerId_day: { providerId: args.providerId, day: args.day } },
  });
  if (!late || late.businessId !== args.businessId) return null;

  const row = await db.runningLateTold.upsert({
    where: { runningLateId_appointmentId: { runningLateId: late.id, appointmentId: args.appointmentId } },
    create: {
      businessId: args.businessId,
      runningLateId: late.id,
      appointmentId: args.appointmentId,
      // The delta AS IT IS NOW, so the row records what she was actually told
      // rather than whatever the number becomes later.
      minutesToldAbout: late.minutes,
      toldByActor: args.actor.type,
      actorRef: args.actor.ref,
    },
    // Ringing her a second time RE-STAMPS it: the useful fact is the most
    // recent call and the number it was about, not the first one.
    update: { minutesToldAbout: late.minutes, toldByActor: args.actor.type, actorRef: args.actor.ref },
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
