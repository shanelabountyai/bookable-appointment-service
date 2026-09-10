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

/**
 * A-102 — "IS THERE TIME TO GIVE BACK, AND AT WHAT INSTANT?", ASKED IN ONE PLACE.
 *
 * There were two askers and they DISAGREED, which is the offered-then-refused
 * class CLAUDE.md has now caught four times. The write below refuses once the
 * BODY is over (`at >= endAt`) — she was due until 11:00 and it is 11:05,
 * there is nothing left of her visit to sell. The detail panel's offer asked
 * whether the ENVELOPE was over (`blockedEnd > now`), and those two are a
 * whole buffer apart: for fifteen minutes after every no-show ends, the panel
 * drew "Put 12 min back on the market" over a button the write path refused.
 * Neither half is individually wrong and the compiler sees nothing, because
 * `endAt` and `blockedEnd` are the same kind of fact under two names.
 *
 * So the question moves here, the write asks it too, and every read model that
 * OFFERS the release asks the identical thing rather than a near-miss of it.
 *
 * THE MINUTES ARE DELIBERATELY NOT PART OF THIS. "May it be released?" is
 * answered from the body; "how much comes back?" is `blockedEnd - at`, and
 * only the callers that have the envelope can answer it. Folding the two
 * together is how they drifted apart in the first place.
 */
export type Releasable =
  | { releasable: true; at: Date }
  | { releasable: false; why: 'not-a-no-show' | 'already-released' | 'before-start' | 'nothing-left' };

/**
 * `at` is FLOORED TO THE WHOLE MINUTE before anything is decided, and the
 * floored instant comes back on the answer — `releasedAt` becomes `blockedEnd`
 * in the trigger and `appointment_instants_whole_minutes` requires that to be
 * a whole minute. A caller passing `new Date()` is the ordinary case (the desk
 * pressed the button now), so this floors rather than refusing; and it floors
 * on the READ side too, so an offer made at 10:59:59 is the same answer as the
 * write it turns into.
 */
export function releasableAt(
  appointment: { status: string; releasedAt: Date | null; startAt: Date; endAt: Date },
  at: Date,
): Releasable {
  // The status list is not hand-typed anywhere else: there is exactly one
  // status that has dead time, by definition of the item.
  if (appointment.status !== 'no_show') return { releasable: false, why: 'not-a-no-show' };
  if (appointment.releasedAt !== null) return { releasable: false, why: 'already-released' };

  const floored = Math.floor(fromDate(at) / 60_000) * 60_000;
  if (floored < fromDate(appointment.startAt)) return { releasable: false, why: 'before-start' };
  if (floored >= fromDate(appointment.endAt)) return { releasable: false, why: 'nothing-left' };
  return { releasable: true, at: toDate(instant(floored)) };
}

/** The refusals in the desk's words. `not-a-no-show` has none of its own: it
 *  names the status it found, which is `NotReleasable`'s default sentence. */
const REFUSAL_WORDS: Record<Exclude<Releasable, { releasable: true }>['why'], string | undefined> = {
  'not-a-no-show': undefined,
  'already-released': 'This one has already had its time given back.',
  'before-start': 'This cannot be released before it was due.',
  'nothing-left': 'That time is already over — there is nothing left to give back.',
};

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

      // A-102 — THE SAME QUESTION THE OFFER ASKED, not a second copy of it.
      // Asked here against real rows, so the read model above is advisory and
      // never trusted; what changed is that the two now agree by construction.
      const verdict = releasableAt(appointment, input.releasedAt);
      if (!verdict.releasable) throw new NotReleasable(appointment.status, REFUSAL_WORDS[verdict.why]);
      const releasedAt = verdict.at;
      const at = fromDate(releasedAt);

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

/**
 * A-075 / D-45 — SHE WALKED IN AFTER ALL.
 *
 * A-069 called this "a rebooking, not an undo" and left it out. In the salon it
 * is neither. She turns up at 10:35, fifteen minutes after the desk gave up;
 * the desk books her into her own released tail; and the `no_show → completed`
 * correction (APPT-06) is then **permanently refused by the exclusion
 * constraint**, because restoring her blocked range collides with the booking
 * that IS her. She keeps a no-show she did not earn — the exact harm A-055,
 * A-060 and A-068 were each built to prevent, arriving through a fourth door.
 *
 * D-45's answer: **un-release her while the freed tail is still empty.** One
 * guarded `UPDATE` back to `NULL`, and the constraint refuses it the moment
 * anything has been sold — no check-then-write, no window, no reservation. The
 * desk's next step then is the ordinary correction, which now succeeds because
 * the range it needs is hers again.
 *
 * IT IS NOT A HOLD AND IT IS NOT AUTOMATIC. Nothing here reserves the tail
 * while she is on her way, and no rule un-releases anything on its own — D-44's
 * "never automatic" governs both directions, for the same reason: a person
 * decides, and the moment they decide is what gets recorded.
 */
export async function unreleaseNoShowTime(
  prisma: PrismaClient,
  input: { businessId: string; appointmentId: string; actor: Actor; reason?: string | null },
): Promise<ReleasedTime> {
  try {
    return await prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.findFirst({
        where: { id: input.appointmentId, businessId: input.businessId },
        select: { id: true, businessId: true, status: true, endAt: true, releasedAt: true, bufferAfterMinutes: true },
      });
      if (!appointment) throw new NotReleasable('missing', 'That appointment is not in this business.');
      if (appointment.releasedAt === null) {
        throw new NotReleasable(appointment.status, 'That time was never given back, so there is nothing to undo.');
      }
      // The trigger honours `releasedAt` only while the status is `no_show`, so
      // off that status the range is already whole and this would be a no-op
      // that wrote an event saying something happened.
      if (appointment.status !== 'no_show') throw new NotReleasable(appointment.status);

      const releasedAt = appointment.releasedAt;

      // Conditional on the release we are undoing, so two desks cannot both
      // write — the same reflex as every other same-row UPDATE here. The
      // TRIGGER restores the blocked range, the per-block ranges and the chair
      // body from this one column, and the exclusion constraint is what refuses
      // if the tail has been sold. Nothing checks first.
      const written = await tx.appointment.updateMany({
        where: { id: appointment.id, releasedAt, status: 'no_show' },
        data: { releasedAt: null },
      });
      if (written.count === 0) {
        throw new NotReleasable(appointment.status, 'Somebody else has already changed this one.');
      }

      await tx.appointmentEvent.create({
        data: {
          businessId: appointment.businessId,
          appointmentId: appointment.id,
          // ONE type, two sentences, the same shape A-068's `client_changed`
          // uses: this is the release and its undo, not two unrelated facts,
          // and a second type would be a second row in every list that reads
          // the log for one column going back to where it was.
          type: 'time_released',
          actor: input.actor.type,
          actorRef: input.actor.ref,
          reason: input.reason?.trim() || null,
          payload: {
            releasedAt: releasedAt.toISOString(),
            restored: true,
          } satisfies Prisma.InputJsonValue,
        },
      });

      // Nothing is sent, in this direction either.
      const blockedEnd = toDate(instant(fromDate(appointment.endAt) + appointment.bufferAfterMinutes * 60_000));
      return {
        appointmentId: appointment.id,
        releasedAt,
        fromBlockedEnd: blockedEnd,
        minutes: Math.round((fromDate(blockedEnd) - fromDate(releasedAt)) / 60_000),
      };
    });
  } catch (error) {
    // The tail has been sold. The desk is told in words which is exactly the
    // point of D-45 — the alternative was a client wearing a no-show she did
    // not earn, discovered as a crash.
    if (isSlotTakenError(error)) throw new SlotTaken([], ['overlaps-booking']);
    throw error;
  }
}

/**
 * A-102 — THE PERISHABLE SUPPLY THAT IS NOT ON THE PERISHABLE-SUPPLY SCREEN.
 *
 * A 120-minute colour, marked `no_show` at 09:20. `blockedEnd` stays at 11:20,
 * which is correct (D-7 — a no-show occupies its time, for the record, for
 * utilization and for her twelve-month count), and `/staff/opened` shows **0**.
 * That list reads `SLOT_FREEING_STATUSES` and the event log, and an unreleased
 * no-show writes neither — so two hours of a Saturday become visible to the
 * screen that sells them only AFTER a human has already found them and pressed
 * the button. And the button was on one screen while `no_show` is markable on
 * three (`ON_THE_CHIP` puts it on the stylist's own list).
 *
 * D-44 is right that releasing must never be automatic — she may be eight
 * minutes away in traffic. That is an argument against a TIMER, not against a
 * LIST. Nothing here writes anything; it names what a person could still give
 * back, and the giving stays one deliberate tap.
 *
 * WHY THIS IS NOT A FIFTH `freedBy` KIND ON `listOpenedSlots`. Every row on
 * that list is time that IS free, and its last bound is "still empty" —
 * `findBusyAppointments` over the span. This time is NOT free: it is blocked,
 * by this very appointment, which is the whole point. Fed into that list it
 * would be dropped by the bound that makes the list true. Two questions, two
 * lists, one screen.
 *
 * BOUNDED BY CONSTRUCTION, with no lookback constant of its own. A no-show
 * cannot be marked before its start (§7's `before-appointment-start`) and this
 * asks for `endAt > now`, so every row is an appointment that has begun and
 * has not ended: today, always, at most one visit-length wide. `/staff/opened`
 * needs three bounds because a cancellation is news for a fortnight; this one
 * expires on its own.
 */
export interface UnreleasedNoShow {
  appointmentId: string;
  providerId: string;
  providerName: string;
  startAt: Date;
  endAt: Date;
  /** What the salon gets back if somebody presses it now — the ENVELOPE to
   *  `now`, which is the span `releaseNoShowTime` actually frees, buffer and
   *  all. Recomputed on every read: it shrinks by a minute every minute. */
  minutes: number;
  clientName: string | null;
  clientPhone: string | null;
  serviceNames: string[];
}

export async function listUnreleasedNoShows(
  db: Prisma.TransactionClient | PrismaClient,
  args: { businessId: string; now: Date },
): Promise<UnreleasedNoShow[]> {
  const rows = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      status: 'no_show',
      releasedAt: null,
      // The body has not run out. Same edge as `releasableAt` below asks
      // again — this one is only here so the query is not the whole history.
      endAt: { gt: args.now },
    },
    orderBy: { startAt: 'asc' },
    select: {
      id: true,
      providerId: true,
      startAt: true,
      endAt: true,
      blockedEnd: true,
      status: true,
      releasedAt: true,
      provider: { select: { displayName: true } },
      client: { select: { name: true, phone: true } },
      lines: { orderBy: { ordinal: 'asc' }, select: { service: { select: { name: true } } } },
    },
  });

  return rows.flatMap((row) => {
    // THE CHOOSER'S OWN PREDICATE, not an approximation of it: this list is an
    // OFFER, and an offer the write path refuses is the defect A-102 exists to
    // close rather than to repeat one screen along.
    const verdict = releasableAt(row, args.now);
    if (!verdict.releasable) return [];
    const minutes = Math.round((fromDate(row.blockedEnd) - fromDate(verdict.at)) / 60_000);
    // D-8's zero-width override held no range and has nothing to give back —
    // dropped here by arithmetic rather than by an `isOverride` filter,
    // because what disqualifies a row is having no minutes, whatever made it
    // that way.
    if (minutes <= 0) return [];
    return [
      {
        appointmentId: row.id,
        providerId: row.providerId,
        providerName: row.provider.displayName,
        startAt: row.startAt,
        endAt: row.endAt,
        minutes,
        clientName: row.client?.name ?? null,
        clientPhone: row.client?.phone ?? null,
        serviceNames: row.lines.map((l) => l.service.name),
      },
    ];
  });
}
