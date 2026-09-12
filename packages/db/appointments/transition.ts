/**
 * A-012 — moving an appointment through its lifecycle (APPT-01, 05, 06, 07).
 *
 * The ONE place a status is written. Everything about *whether* a move is
 * legal lives in `packages/core/scheduling/transitions.ts`; everything here is
 * the database work of doing it: resolving the cutoff from real rows, writing
 * the status with the actual timestamps that go with it, and appending the
 * event that makes it auditable.
 *
 * The busy set takes care of itself. `blockedStart`/`blockedEnd` are never
 * touched by a transition — the exclusion constraint and the busy-set query
 * are both partial over `ACTIVE_STATUSES` (D-15), so cancelling frees the time
 * by the status change alone and `completed`/`no_show` keep occupying it
 * (D-7). Any code here that adjusted the blocked range would be a second,
 * disagreeing mechanism.
 */
import {
  type AppointmentStatus,
  type TransitionRefusal,
  SLOT_FREEING_STATUSES,
  canTransition,
  isCorrection,
  isVisitMeasurable,
  staffCancellationStatus,
} from '../../core/scheduling';
import { fromDate } from '../../core/time';
import { worstCutoff } from '../../core/settings';
import type { Actor } from '../../core/auth';
import { NoResourceFree, SlotTaken } from '../booking/errors';
import { chairForMove, resourceTypeName } from '../booking/resources';
import { isSlotTakenError } from '../errors';
import { enqueueNotification } from '../notifications';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = PrismaClient;

/** The move is not legal. Carries the machine-readable reason so a route can
 *  map it — 409 for a lost race, 403 for the wrong actor, 422 for a missing
 *  reason — instead of flattening every refusal into one status code. */
export class TransitionRefused extends Error {
  readonly refusal: TransitionRefusal;
  readonly from: AppointmentStatus;
  readonly to: AppointmentStatus;
  constructor(from: AppointmentStatus, to: AppointmentStatus, refusal: TransitionRefusal) {
    super(`Cannot move an appointment from ${from} to ${to}: ${refusal}.`);
    this.name = 'TransitionRefused';
    this.refusal = refusal;
    this.from = from;
    this.to = to;
  }
}

/**
 * Somebody else moved this appointment first.
 *
 * Two people at the front desk tapping "check in" on the same client is an
 * ordinary Saturday, not an exotic race. Carries the status actually found so
 * the screen can say "Priya already checked her in" rather than "conflict".
 */
export class AppointmentMovedFirst extends Error {
  readonly expected: AppointmentStatus;
  readonly actual: AppointmentStatus;
  constructor(expected: AppointmentStatus, actual: AppointmentStatus) {
    super(`Expected the appointment to still be ${expected}, but it is ${actual}.`);
    this.name = 'AppointmentMovedFirst';
    this.expected = expected;
    this.actual = actual;
  }
}

export interface TransitionInput {
  appointmentId: string;
  to: AppointmentStatus;
  actor: Actor;
  /** Injected, never read from the clock here — the cutoff and the
   *  seven-day correction window both depend on it, so a test that cannot
   *  freeze it cannot test either boundary (CLAUDE.md). */
  now: Date;
  /** Required by APPT-06 corrections and by the in-progress walk-out. */
  reason?: string | null;
  /**
   * The status the caller believes it is moving FROM.
   *
   * Optional, and worth passing from any screen that showed the user a status:
   * it turns "the button did nothing surprising" into an explicit
   * `AppointmentMovedFirst`. Omitted, the current row's status is used and the
   * update is still atomic — see the conditional write below.
   */
  expectedFrom?: AppointmentStatus;
  /**
   * A-036 (operator P-5). `false` = "I already rang them, don't text."
   *
   * Only ever consulted for a STAFF move. A client who cancels through her own
   * manage link does not need telling what she just did, and nothing in this
   * product cancels on its own (A-021: no auto-cancel, ever).
   *
   * A-112 (D-53): the two notices this drives read it in OPPOSITE directions,
   * deliberately. A cancellation is opt-OUT (undefined means send). A
   * reinstatement is opt-IN — `true` and nothing else — because the client has
   * just been told the opposite and the desk is usually already on the phone.
   * Both are spelled out at the enqueue sites below, where the argument is.
   */
  notify?: boolean;
  /**
   * A-060 (APPT-06) — THE DESK PRESSES ONE CANCEL BUTTON AND THIS DECIDES.
   *
   * `'derive'`: `to` is ignored and the resolved cutoff picks `cancelled` or
   * `cancelled_late`. `'override'`: the desk deliberately downgrades a late
   * one — "she gave us proper notice", "this one's on us" — which requires a
   * reason and records the overruled classification in the event, so the
   * owner can ask how many were overruled and by whom.
   *
   * STAFF ONLY by construction: the customer's manage link names its own
   * status (A-013) and must keep doing so, because a token holder choosing
   * between two cancellation statuses is the tell TOKEN-03 forbids.
   */
  cancellation?: 'derive' | 'override';
}

export interface TransitionResult {
  id: string;
  from: AppointmentStatus;
  to: AppointmentStatus;
  isCorrection: boolean;
}

export async function transitionAppointment(db: Db, input: TransitionInput): Promise<TransitionResult> {
  try {
    return await runTransition(db, input);
  } catch (error) {
    // A-075. A status change USUALLY moves no ranges, which is why this file
    // has never needed to know about the exclusion constraint. A-069 made one
    // exception: correcting a released `no_show` off that status restores its
    // whole blocked range (the trigger honours `releasedAt` only while the
    // status is `no_show`), and if the freed tail has been sold in the
    // meantime the constraint refuses it — correctly, and until now as a raw
    // SQLSTATE 23P01 landing on the appointment panel, whose entire job is
    // explaining itself.
    //
    // A-112 (D-53) makes it the ORDINARY case rather than the exception, and
    // the whole reason reinstatement can exist at all. `cancelled → booked`
    // puts the appointment back into the constraint's predicate — the two
    // triggers rewrite its blocks and its chair hold from the parent row's new
    // status — so the database, which is the only thing that knows whether the
    // time has been sold since, is what decides. Nothing here checks first;
    // check-then-write is never the mechanism.
    //
    // A-116: WHAT REACHES HERE IS NOW THE STYLIST'S AXIS, or a chair lost in
    // the race between the re-pick inside the transaction and the write. The
    // room being full is answered there, as `NoResourceFree`, and never
    // arrives as this — which is the whole point: "somebody else has that
    // time" said over an empty column is a sentence the desk stops believing.
    //
    // Mapped to the SAME error every other lost race in the codebase raises,
    // so the desk reads one vocabulary for one cause (`scheduling-words.ts`).
    if (isSlotTakenError(error)) throw new SlotTaken([], ['overlaps-booking']);
    throw error;
  }
}

async function runTransition(db: Db, input: TransitionInput): Promise<TransitionResult> {
  return db.$transaction(async (tx) => {
    const appointment = await tx.appointment.findUniqueOrThrow({
      where: { id: input.appointmentId },
      select: {
        id: true,
        businessId: true,
        status: true,
        startAt: true,
        endAt: true,
        checkedInAt: true,
        startedAt: true,
        endedAt: true,
        // A-116. The chair, the holder, and the envelope the trigger already
        // wrote — `blockedStart`/`blockedEnd` are body plus buffers and a
        // transition moves neither, so the destination envelope is the one on
        // the row. Nothing here re-derives the buffer arithmetic.
        clientId: true,
        resourceId: true,
        blockedStart: true,
        blockedEnd: true,
        business: { select: { cancellationCutoffMinutes: true } },
        client: { select: { email: true, phone: true } },
        // Ordered, because `resourceTypeName` asks the FIRST line which chair
        // type the visit needs (RES-01) and an unordered read names whichever
        // row Postgres hands back.
        lines: {
          orderBy: { ordinal: 'asc' },
          select: { serviceId: true, service: { select: { id: true, name: true, cancellationCutoffMinutes: true } } },
        },
      },
    });

    const from = appointment.status;
    if (input.expectedFrom && input.expectedFrom !== from) {
      throw new AppointmentMovedFirst(input.expectedFrom, from);
    }

    // D-19: a service may demand more notice than the business default, and a
    // visit may carry several. The most restrictive one governs — reusing the
    // same `worstCutoff` the settings form validates against, so the rule a
    // customer meets is the rule the owner was shown.
    const cutoff = worstCutoff(
      appointment.business.cancellationCutoffMinutes,
      appointment.lines.map((l) => ({
        id: l.service.id,
        name: l.service.name,
        cancellationCutoffMinutes: l.service.cancellationCutoffMinutes,
      })),
    );

    const context = {
      actor: input.actor.type,
      now: fromDate(input.now),
      startAt: fromDate(appointment.startAt),
      endAt: fromDate(appointment.endAt),
      cancellationCutoffMinutes: cutoff.minutes,
      reason: input.reason,
    };

    // A-060. The classification is the MACHINE'S, made here where the cutoff
    // has just been resolved from real rows — never the front desk's guess and
    // never a second copy of the arithmetic on a screen. `to` is whatever the
    // caller asked for in every other case, so nothing else moves.
    const classified = input.cancellation ? staffCancellationStatus(from, context) : null;
    const to = input.cancellation === 'derive' ? classified! : input.to;

    // What the desk overruled, and only when there was genuinely something to
    // overrule: pressing the escape on an appointment that was on time anyway
    // is an ordinary cancellation, and demanding a reason for it would train
    // the desk to type "." into the box that has to mean something.
    const overruled = input.cancellation === 'override' && classified === 'cancelled_late' ? classified : null;
    if (overruled && !input.reason?.trim()) throw new TransitionRefused(from, to, 'reason-required');

    const decision = canTransition(from, to, context);

    if (!decision.allowed) throw new TransitionRefused(from, to, decision.refusal);

    const freeing = SLOT_FREEING_STATUSES as readonly AppointmentStatus[];

    /**
     * A-116 — A REINSTATEMENT IS A NEW WAY TO START OCCUPYING TIME, SO IT
     * PICKS A CHAIR (RES-03, D-30, D-53).
     *
     * A-034's rule is *the chair follows the move*, and the reinstatement is
     * not a move, so nobody grepped for it: D-53 put the appointment back into
     * the chair `resourceId` still named from before the cancellation, and
     * called that "the conservative direction, and the desk can move it
     * afterwards". Both halves were wrong. `findFreeResource` hands out the
     * lowest-numbered free chair (`resources.ts`), so the chair a cancellation
     * frees is the one the next overlapping booking — on ANY stylist — is
     * given; and a cancelled appointment has no move panel, so the only thing
     * the desk was offered was "book them in somewhere else", which is the new
     * id, the second manage token, the split log and the late cancel that D-53
     * exists to take off her record.
     *
     * So re-pick, with the chooser every other occupancy change uses and the
     * same preference: her own chair when it is still free, any other of the
     * type when it is not. That is a CHOOSER, not a check-then-write — the
     * exclusion constraint still defends the chosen chair against the race,
     * and the provider axis stays the database's call exactly as D-53 says.
     *
     * Derived from `SLOT_FREEING_STATUSES` rather than testing for
     * `cancelled`: the fact is "the time was given back and is being taken
     * again", which is the same predicate the reinstatement notice below
     * asks, and a ninth status must not need a second edit here.
     *
     * NOT the `no_show` correction A-075 guards (`release-time.ts`): `no_show`
     * still occupies (D-7), so it is not in this set, and un-releasing a
     * released one restores a range on a chair she was actually sitting in —
     * the same shape, a different question, and deliberately left alone.
     */
    const reinstating = freeing.includes(from) && !freeing.includes(to);
    const chair =
      reinstating && appointment.resourceId
        ? await chairForMove(tx, {
            businessId: appointment.businessId,
            appointmentId: appointment.id,
            resourceId: appointment.resourceId,
            start: appointment.blockedStart,
            end: appointment.blockedEnd,
            // A-063 — she may be sitting beside her own other visit.
            holder: { key: appointment.clientId, bodyStart: appointment.startAt, bodyEnd: appointment.endAt },
          })
        : null;
    // TWO REFUSALS, WORDED APART. Every chair taken is a fact about the ROOM
    // and the stylist is free; a lost provider race is a fact about the
    // stylist. This file used to collapse both into `overlaps-booking`, so the
    // one screen whose job is explaining itself said "somebody has Dana then"
    // while Dana's column was empty.
    if (reinstating && appointment.resourceId && !chair) {
      throw new NoResourceFree(await resourceTypeName(tx, appointment.lines.map((l) => l.serviceId)));
    }

    // THE WRITE IS CONDITIONAL ON THE STATUS WE DECIDED AGAINST.
    //
    // Not a belt-and-braces re-check: under READ COMMITTED two concurrent
    // transitions can both read `booked` and both write, producing one status
    // and two events that disagree about what happened. Scoping the UPDATE by
    // status makes the database itself the arbiter, the same reflex as the
    // exclusion constraint — never check-then-write as the mechanism.
    const written = await tx.appointment.updateMany({
      where: { id: appointment.id, status: from },
      data: {
        status: to,
        // A-116. Only ever on a reinstatement, and only over a chair she
        // already held: NULL is never written across a chair, because `chair`
        // is only computed when there was one to re-pick.
        ...(chair ? { resourceId: chair } : {}),
        // A-080 (D-47). `now` is a MEASUREMENT of the visit only while the
        // visit is plausibly still happening; past that it is when somebody
        // got round to tapping, which is a different fact. Asked here, where
        // the context already holds both instants, and answered by the one
        // predicate in `core/scheduling` — never re-derived on a screen.
        ...timestampsFor(from, to, input.now, isCorrection(from, to), isVisitMeasurable(context)),
      },
    });

    if (written.count === 0) {
      const actual = await tx.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        select: { status: true },
      });
      throw new AppointmentMovedFirst(from, actual.status);
    }

    const correction = isCorrection(from, to);
    const event = await tx.appointmentEvent.create({
      data: {
        businessId: appointment.businessId,
        appointmentId: appointment.id,
        // A correction is a different fact from a status change — "we got this
        // wrong" rather than "this happened" — and the detail panel renders
        // them differently (APPT-07).
        type: correction ? 'status_corrected' : 'status_changed',
        actor: input.actor.type,
        actorRef: input.actor.ref,
        reason: input.reason?.trim() || null,
        payload: {
          from,
          to,
          // A-060: "we called this one on time, and the machine would not
          // have." The only record that the classification was a human's, so
          // the owner's drill-down can count them and name who.
          ...(overruled ? { overruled } : {}),
          // Kept because the update above may have cleared them: a no-show did
          // not arrive, so its arrival timestamps must not survive the
          // correction, and the log is then the only record they existed.
          ...(correction
            ? {
                clearedCheckedInAt: appointment.checkedInAt?.toISOString() ?? null,
                clearedStartedAt: appointment.startedAt?.toISOString() ?? null,
                clearedEndedAt: appointment.endedAt?.toISOString() ?? null,
              }
            : {}),
        } satisfies Prisma.InputJsonValue,
      },
    });

    // A-036: the other half of "nothing is silently cancelled". The row goes
    // in THIS transaction, so a cancellation that commits without its notice
    // is not a state the database can hold — the same coupling the booking
    // confirmation has had since A-009.
    //
    // Staff only, and derived from the status module rather than hand-typed
    // (CLAUDE.md: a status list is never one edit).
    if (input.actor.type === 'staff' && input.notify !== false && freeing.includes(to)) {
      await enqueueNotification(tx, {
        // A-112 — KEYED ON THE EVENT, NOT ON THE APPOINTMENT.
        //
        // This read `cancelled:${appointment.id}` — "one cancellation of an
        // appointment is one fact" — which was true for exactly as long as
        // `cancelled` was a dead end. D-53's reinstatement makes cancel →
        // reinstate → cancel an ordinary week at the front desk, and the
        // SECOND cancellation would have carried the same key as the first,
        // been swallowed by the outbox as a duplicate, and left a client who
        // really is cancelled with no message and a screen saying she was
        // told. Silent, and on the one path A-036 exists to make impossible.
        //
        // The event row is the cancellation ACT and it is created in this same
        // transaction, so it is the honest unit: one notice per act, and a
        // rolled-back attempt takes its key with it. The double-tap this used
        // to absorb is already refused a layer up by the conditional UPDATE —
        // the second transaction cannot find the status it expects.
        dedupeKey: `cancelled:${event.id}`,
        businessId: appointment.businessId,
        appointmentId: appointment.id,
        channel: appointment.client?.email ? 'email' : 'sms',
        template: 'appointment.cancelled',
        recipient: appointment.client?.email ?? appointment.client?.phone ?? null,
        payload: {
          appointmentId: appointment.id,
          startAt: appointment.startAt.toISOString(),
          // A-019's reason, forwarded. "Salon closed Saturday" is the entire
          // message as far as the client is concerned.
          reason: input.reason?.trim() || null,
        },
      });
    }

    /**
     * A-112 (D-53) — TELLING HER THE CANCELLATION WAS OURS.
     *
     * D-32's checkbox, DEFAULTED THE OTHER WAY. Every other notice in this
     * file is opt-out, because the salon changing a client's appointment
     * without telling her is the failure mode. Here she has already been
     * texted that she is cancelled, and the desk's first move is almost always
     * the phone — a reinstatement is an apology, and an automatic second text
     * arriving before or instead of that conversation is the salon talking
     * over itself. So this one is opt-IN: `notify` must be explicitly true.
     *
     * Derived from the same set as the cancellation above rather than testing
     * for `booked` by hand: the fact is "the time was given back and has been
     * taken again", and a ninth status must not need a second edit here.
     */
    if (input.actor.type === 'staff' && input.notify === true && freeing.includes(from) && !freeing.includes(to)) {
      await enqueueNotification(tx, {
        dedupeKey: `reinstated:${event.id}`,
        businessId: appointment.businessId,
        appointmentId: appointment.id,
        channel: appointment.client?.email ? 'email' : 'sms',
        template: 'appointment.reinstated',
        recipient: appointment.client?.email ?? appointment.client?.phone ?? null,
        payload: {
          appointmentId: appointment.id,
          startAt: appointment.startAt.toISOString(),
          reason: input.reason?.trim() || null,
        },
      });
    }

    return { id: appointment.id, from, to, isCorrection: correction };
  });
}

/**
 * The ACTUAL timestamps (D-7's "actual-vs-scheduled").
 *
 * `startAt`/`endAt` stay as scheduled forever; these record what really
 * happened, which is what makes "she was forty minutes late" answerable and
 * what A-018's running-late column is built on.
 *
 * Correcting to `no_show` CLEARS them, because a client who never arrived
 * cannot have a check-in time — leaving one behind would let a no-show report
 * and an arrival report disagree, and the prior values are preserved in the
 * event payload. Correcting the other way sets nothing: nobody knows when a
 * visit that was mis-marked as a no-show actually ended, and inventing
 * `now` — days later, at correction time — would be a fabricated measurement.
 *
 * `measured` (A-080, D-47) is the same argument generalised: all three of
 * these are measurements, and `now` measures the visit only while the visit is
 * plausibly still happening. Outside that window every one of them stays NULL
 * — the check-in tapped on Monday for Saturday, the `in_progress` row closed
 * out at the till at six, and D-46's Monday `endedAt`, which is the one that
 * was already guarded and the reason the other two were found. `confirmedAt`
 * is deliberately outside it; see the case below.
 */
function timestampsFor(
  from: AppointmentStatus,
  to: AppointmentStatus,
  now: Date,
  correction: boolean,
  measured: boolean,
) {
  // A correction happens DAYS after the fact (up to seven, APPT-06), so `now`
  // is not when anything happened. It may only clear, never stamp.
  if (correction) {
    return to === 'no_show' ? { checkedInAt: null, startedAt: null, endedAt: null } : {};
  }

  switch (to) {
    // NOT one of the three. Confirming is an act performed at `now` — she rang
    // on Thursday to say she is coming — so a late one is a true record of a
    // late confirmation, not a guess about a visit.
    case 'confirmed':
      return { confirmedAt: now };
    case 'checked_in':
      return measured ? { checkedInAt: now } : {};
    case 'in_progress':
      return measured ? { startedAt: now } : {};
    case 'completed':
      // A-076 (D-46). `endedAt` is stamped only when she was actually SEEN to
      // be here — reached from `checked_in` or `in_progress`, which is the
      // ordinary tap at the till the moment she finishes.
      //
      // Reached from `booked` or `confirmed` it is Monday and this is Saturday
      // being closed out: nobody knows when she sat down or when she got up, so
      // both stay NULL. A missing timestamp is honest; `now` here would be a
      // Monday-morning lie in the audit trail, and it would make "she was forty
      // minutes late" — D-7's whole actual-vs-scheduled point — unanswerable
      // for every retrospectively closed visit.
      return measured && (from === 'checked_in' || from === 'in_progress') ? { endedAt: now } : {};
    case 'no_show':
      return { checkedInAt: null, startedAt: null, endedAt: null };
    default:
      return {};
  }
}
