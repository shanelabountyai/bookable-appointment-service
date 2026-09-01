/**
 * A-069 / D-44 — GIVING A NO-SHOW'S TIME BACK (APPT-03, BOOK-05).
 *
 * A 10:00 colour, ninety minutes. At 10:20 the desk gives up and marks her a
 * no-show — and that time stays blocked for another seventy minutes. A walk-in
 * at 10:25 can then only be booked into it through a BOOK-05 override with a
 * typed reason: a FALSE OVERRIDE MARKER on a slot that is genuinely empty,
 * which is the fastest way to train the desk to dismiss the marker D-8 rests
 * on. It was not on `/staff/opened` either, because nothing had freed it.
 *
 * WHAT THIS IS NOT. It is not D-7 being re-opened. `no_show` stays in
 * `ACTIVE_STATUSES`, stays in the constraint predicate, stays in the busy set,
 * and still occupies its time for the record, for utilization and for the
 * client's twelve-month count. What was missing was a separate ACTION, and
 * this is it — one nullable instant that the blocked-range trigger reads, and
 * nothing else in the product had to learn a new state.
 *
 * NEVER AUTOMATIC (D-44). Releasing at N minutes past resells a slot to a
 * client stuck in traffic eight minutes away, so there is no rule, no setting
 * and no job — a person picks the instant, which is usually the moment they
 * gave up, and that instant is what gets recorded.
 *
 * THE CUT IS THE WHOLE MECHANISM. `releasedAt` feeds `blockedEnd` in the
 * trigger and nothing else; the exclusion constraint, the busy set, the chair
 * holds and the engine all read the ranges the trigger writes, so every one of
 * them follows without knowing this file exists. The one reader that does NOT
 * follow for free is `/staff/opened`, which is derived from status and the
 * event log rather than from ranges — so the event below is what puts the
 * released span on it (A-067's fourth source).
 */
import type { Actor } from '../../core/auth';
import { fromDate, instant, toDate } from '../../core/time';
import { SlotTaken } from '../booking/errors';
import { isSlotTakenError } from '../errors';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

/** The appointment is not a no-show, so there is no dead time to give back.
 *  A `booked` visit whose tail should be sold is A-055's job, not this one. */
export class NotReleasable extends Error {
  readonly status: string;
  constructor(status: string, detail?: string) {
    super(detail ?? `Only a no-show has time to give back — this one is ${status.replace('_', ' ')}.`);
    this.name = 'NotReleasable';
    this.status = status;
  }
}

export interface ReleaseNoShowTimeInput {
  businessId: string;
  appointmentId: string;
  /** The moment the desk gave up. Injected, never `new Date()` in here. */
  releasedAt: Date;
  actor: Actor;
  reason?: string | null;
}

export interface ReleasedTime {
  appointmentId: string;
  releasedAt: Date;
  /** Where the appointment used to let go — the far end of the freed span. */
  fromBlockedEnd: Date;
  /** What the salon just got back, in minutes. The sentence the desk reads. */
  minutes: number;
}

/**
 * Cuts a no-show's blocked range at `releasedAt`, putting the rest of the slot
 * back on the market.
 *
 * ONE-SHOT. Releasing an already-released appointment is refused rather than
 * re-cut: a second, later instant would be a smaller release (the trigger
 * would extend the range again, over time that may already be sold), and a
 * second, earlier one is a correction to a judgement call nobody records. If
 * the desk wants her time back, the correction is to put the no-show back
 * (APPT-06) and start again.
 */
export async function releaseNoShowTime(
  prisma: PrismaClient,
  input: ReleaseNoShowTimeInput,
): Promise<ReleasedTime> {
  try {
    return await prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.findFirst({
        where: { id: input.appointmentId, businessId: input.businessId },
        select: {
          id: true,
          businessId: true,
          status: true,
          startAt: true,
          endAt: true,
          blockedEnd: true,
          releasedAt: true,
        },
      });
      if (!appointment) throw new NotReleasable('missing', 'That appointment is not in this business.');

      // The status list is not hand-typed anywhere else in this file: there is
      // exactly one status that has dead time, by definition of the item.
      if (appointment.status !== 'no_show') throw new NotReleasable(appointment.status);
      if (appointment.releasedAt !== null) {
        throw new NotReleasable(appointment.status, 'This one has already had its time given back.');
      }

      // FLOORED TO THE WHOLE MINUTE, and this is not cosmetic. `releasedAt`
      // becomes `blockedEnd` in the trigger, and
      // `appointment_instants_whole_minutes` requires that to be a whole
      // minute — one stray second turns "back-to-back" into a false conflict
      // or a one-second bookable hole, which is the defect that CHECK was
      // written for. A caller passing `new Date()` is the ordinary case (the
      // desk pressed the button now), so this floors rather than refusing.
      const at = Math.floor(fromDate(input.releasedAt) / 60_000) * 60_000;
      const releasedAt = toDate(instant(at));
      if (at < fromDate(appointment.startAt)) {
        throw new NotReleasable(appointment.status, 'She cannot be released before she was due.');
      }
      if (at >= fromDate(appointment.endAt)) {
        throw new NotReleasable(appointment.status, 'Her time is already over — there is nothing left to give back.');
      }

      const fromBlockedEnd = appointment.blockedEnd;

      // ORDINARY ROW UPDATE, conditional on the release we decided against, so
      // two desks releasing the same no-show at two different instants cannot
      // both write. The trigger does the arithmetic — the blocked range, the
      // per-block ranges (D-29) and the chair hold all re-derive from this one
      // column, which is the reason the change is this small.
      const written = await tx.appointment.updateMany({
        where: { id: appointment.id, releasedAt: null, status: 'no_show' },
        data: { releasedAt },
      });
      if (written.count === 0) {
        throw new NotReleasable(appointment.status, 'This one has already had its time given back.');
      }

      await tx.appointmentEvent.create({
        data: {
          businessId: appointment.businessId,
          appointmentId: appointment.id,
          type: 'time_released',
          actor: input.actor.type,
          actorRef: input.actor.ref,
          reason: input.reason?.trim() || null,
          payload: {
            releasedAt: releasedAt.toISOString(),
            // BOTH SIDES (D-31), and the far one is load-bearing: the trigger
            // has already overwritten `blockedEnd`, so this event is the only
            // record of how much time came back — which is what A-067's list
            // reads to offer it.
            fromBlockedEnd: fromBlockedEnd.toISOString(),
          } satisfies Prisma.InputJsonValue,
        },
      });

      // NOTHING IS SENT. She did not come; telling her that her slot has been
      // resold is not a message any salon sends, and D-41's reasoning about
      // records-versus-messages applies unchanged.
      return {
        appointmentId: appointment.id,
        releasedAt,
        fromBlockedEnd,
        minutes: Math.round((fromDate(fromBlockedEnd) - at) / 60_000),
      };
    });
  } catch (error) {
    // A release only ever SHRINKS a range, so it cannot collide — but the
    // correction back (APPT-06) can, and mapping `23P01` here keeps the one
    // vocabulary this codebase uses for "somebody else has that time now".
    if (isSlotTakenError(error)) throw new SlotTaken([], ['overlaps-booking']);
    throw error;
  }
}
