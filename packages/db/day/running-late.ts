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
import type { BusyInterval } from '../../core/scheduling';
import { type Instant, fromDate, instant } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

const MIN = 60_000;

export interface RunningLate {
  providerId: string;
  day: string;
  minutes: number;
  setByActor: string;
  actorRef: string | null;
  updatedAt: Date;
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
  providerId: string;
  day: string;
  minutes: number;
  setByActor: string;
  actorRef: string | null;
  updatedAt: Date;
}): RunningLate {
  return {
    providerId: row.providerId,
    day: row.day.trim(),
    minutes: row.minutes,
    setByActor: row.setByActor,
    actorRef: row.actorRef,
    updatedAt: row.updatedAt,
  };
}
