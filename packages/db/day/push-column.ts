/**
 * A-018 — "PUSH THE COLUMN FROM HERE" (APPT-04).
 *
 * The audited action that DOES rewrite `startAt`, as against D-22's delta
 * which deliberately does not. Dana is an hour behind and it is not coming
 * back: everything from 2pm moves thirty minutes later, in one transaction,
 * with the clients told.
 *
 * WHY ONE TRANSACTION WITH THE CONSTRAINT DEFERRED. Shifting three
 * back-to-back appointments moves the first onto the second's old range
 * mid-statement. Every ordering fails somewhere with an immediate check —
 * last-to-first survives a uniform shift but not a swap, and "just order it
 * correctly" is a rule the next person will not know. `SET CONSTRAINTS
 * appointment_no_overlap DEFERRED` moves the check to COMMIT, so the
 * intermediate states are allowed and the FINAL state is still absolutely
 * enforced. The constraint was made `DEFERRABLE INITIALLY IMMEDIATE` at the
 * M1 boundary for exactly this (operator R-2) — immediate everywhere else, so
 * nothing else silently gains the same latitude.
 *
 * WHAT IT REFUSES: a shift that would push an appointment past the provider's
 * closing time, or before she opens, or onto somebody else's. "Refuses
 * silently-lossy shifts" (APPT-04) means the preview names them and the push
 * does not happen — a column that half-moved is worse than one that did not.
 *
 * THE MINUTES MAY BE NEGATIVE (A-059). "She's caught up, pull it back twenty"
 * is an instruction the desk gives, and this function has always accepted it —
 * only zero was ever refused. It was a hidden feature: nothing on the screen
 * said so, the only bound checked was the closing time it moves AWAY from, and
 * the message the client got said "running behind". All three are fixed here
 * and in the control that drives it.
 */
import type { Actor } from '../../core/auth';
import { ACTIVE_STATUSES, resolveWindow, wallTime } from '../../core/scheduling';
import { type ZoneId, calendarDay, fromDate, instant, toDate, toLabel, weekdayOf } from '../../core/time';
import { resolveDayWindows } from '../availability';
import { enqueueNotification } from '../notifications';
import { repointManageTokens } from '../appointments';
import { SlotTaken } from '../booking';
import { isSlotTakenError } from '../errors';
import { deltaAfterPush, setRunningLate } from './running-late';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

const MIN = 60_000;

export interface PushCandidate {
  appointmentId: string;
  clientName: string | null;
  from: Date;
  to: Date;
  /**
   * Why this one cannot move (D-26). It stays where it is and the rest still
   * go — but it is NAMED, which is the whole difference between a partial
   * push and a silently-lossy one.
   */
  problem?: 'past-closing' | 'before-opening' | 'blocked-by-one-that-stays' | 'no-chair-free';
  /**
   * A-034. The chair it will hold AT THE DESTINATION — the same chair when it
   * is still free (the ordinary case), a different one when somebody who is
   * not moving now occupies it. Absent when the appointment holds no chair at
   * all, which a staff override deliberately does not (D-30).
   *
   * Decided HERE rather than in the write loop because A-018's own rule is
   * that the preview runs the check the action executes: a chair chosen during
   * the writes could not be shown, and an appointment with no chair available
   * has to come back as `leftBehind` rather than as an exception (D-26).
   */
  toResourceId?: string;
}

export interface PushPreview {
  providerId: string;
  day: string;
  minutes: number;
  candidates: PushCandidate[];
  /** True when at least one appointment can actually move. Not "all of them"
   *  (D-26): the push is partial and says what it left. */
  canPush: boolean;
  /**
   * D-43 — the delta as it stands, and as this push would leave it.
   *
   * Stated by the PREVIEW and not only by the outcome, because "moves 6, leaves
   * 2, Dana then shows 0 behind" is the sentence the desk needs before it
   * commits: on the two arms that leave the delta standing, these are equal and
   * the screen says so in words. Zero means no claim rather than a stored zero —
   * `setRunningLate` has always treated it that way.
   */
  runningLateMinutes: number;
  runningLateAfter: number;
}

/**
 * What would happen, without doing it.
 *
 * Computed by the same function the push itself calls, so the preview cannot
 * disagree with the outcome — the failure mode a separate "check" function
 * always eventually develops.
 */
export async function previewPush(
  db: Prisma.TransactionClient | PrismaClient,
  args: { businessId: string; providerId: string; day: string; fromAt: Date; minutes: number },
): Promise<PushPreview> {
  const business = await db.business.findUniqueOrThrow({
    where: { id: args.businessId },
    select: { timezone: true },
  });
  const zone = business.timezone as ZoneId;
  const day = calendarDay(args.day);

  const appointments = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      providerId: args.providerId,
      status: { in: [...ACTIVE_STATUSES] },
      // FROM HERE, on the instant axis: everything starting at or after the
      // chosen moment. Not `startDay = day`, which would miss an overnight
      // appointment and move it out from under the client.
      startAt: { gte: args.fromAt },
      startDay: args.day,
    },
    orderBy: { startAt: 'asc' },
    select: {
      id: true,
      startAt: true,
      endAt: true,
      bufferAfterMinutes: true,
      // A-034. The chair, and the envelope its hold actually spans — gaps and
      // both buffers included (RES-02), which is why these are read rather
      // than re-derived from `startAt`/`endAt` here.
      resourceId: true,
      blockedStart: true,
      blockedEnd: true,
      // A-063 (checkpoint 5). The holder, so the planner can ask the two
      // questions the database asks rather than the one it used to.
      clientId: true,
      client: { select: { name: true } },
    },
  });

  // The provider's own closing time for the day, resolved through the same
  // chain and the same axis crossing the engine uses.
  const resolved = await resolveDayWindows(db, {
    businessId: args.businessId,
    providerId: args.providerId,
    day: args.day,
    weekday: weekdayOf(day),
  });
  const windows = resolved.windows.map((w) =>
    resolveWindow(
      {
        open: wallTime(w.open),
        close: wallTime(w.close),
        endsNextDay: w.endsNextDay,
        breaks: w.breaks.map((b) => ({ open: wallTime(b.open), close: wallTime(b.close) })),
      },
      day,
      zone,
    ),
  );
  const lastClose = windows.reduce((latest, w) => (w.span.end > latest ? w.span.end : latest), 0 as number);
  // A-059. The mirror of `lastClose`, and it exists for the same reason: a
  // NEGATIVE push ("she's caught up, pull it back twenty") is a real
  // instruction the field has always accepted, and without this the only bound
  // on it was the closing time it was moving away from. A -180 would seat a
  // client at 07:00 in a salon that opens at nine, and no constraint would
  // refuse it — nothing in this schema knows a working window.
  const firstOpen = windows.reduce(
    (earliest, w) => (earliest === 0 || w.span.start < earliest ? w.span.start : earliest),
    0 as number,
  );

  // D-43. Read INSIDE whatever transaction is running — `pushColumn` calls this
  // function from inside its own, so the number the push acts on is the number
  // the preview promised, with no window between them.
  const late = await db.providerRunningLate.findFirst({
    where: { businessId: args.businessId, providerId: args.providerId, day: args.day },
    select: { minutes: true },
  });
  const runningLateMinutes = late?.minutes ?? 0;

  const shift = args.minutes * MIN;

  interface Row {
    appointment: (typeof appointments)[number];
    shiftedStart: number;
    shiftedBlockedEnd: number;
    stayingStart: number;
    stayingBlockedEnd: number;
    problem?: PushCandidate['problem'];
  }

  /** The chair hold's envelope, before and after the shift (A-034). Distinct
   *  from the provider spans above: a chair is held through the developing
   *  gap the stylist is working somebody else in. */
  const holdBefore = (row: Row) => ({
    start: fromDate(row.appointment.blockedStart),
    end: fromDate(row.appointment.blockedEnd),
  });
  const holdAfter = (row: Row) => ({
    start: fromDate(row.appointment.blockedStart) + shift,
    end: fromDate(row.appointment.blockedEnd) + shift,
  });

  /** The BODY — her actually in the chair, buffers excluded. A-063 split the
   *  one chair invariant into two, and the planner has to ask both: envelopes
   *  may overlap for one holder, bodies never overlap for anyone. */
  const bodyBefore = (row: Row) => ({
    start: fromDate(row.appointment.startAt),
    end: fromDate(row.appointment.endAt),
  });
  const bodyAfter = (row: Row) => ({
    start: fromDate(row.appointment.startAt) + shift,
    end: fromDate(row.appointment.endAt) + shift,
  });
  /** `COALESCE(clientId, 'appt:' || id)` — the same expression the hold-writing
   *  trigger uses. A nullable key would make every unnamed walk-in one holder. */
  const holderOf = (row: Row) => row.appointment.clientId ?? `appt:${row.appointment.id}`;

  const rows: Row[] = appointments.map((appointment) => ({
    appointment,
    shiftedStart: fromDate(appointment.startAt) + shift,
    shiftedBlockedEnd: fromDate(appointment.endAt) + shift + appointment.bufferAfterMinutes * MIN,
    stayingStart: fromDate(appointment.startAt),
    stayingBlockedEnd: fromDate(appointment.endAt) + appointment.bufferAfterMinutes * MIN,
    // Past closing is the loss APPT-04 names. A shift that ends the day after
    // the salon shuts is not a scheduling decision, it is a mistake with a
    // client attached — so this one stays put and is named.
    ...(lastClose > 0 && fromDate(appointment.endAt) + shift + appointment.bufferAfterMinutes * MIN > lastClose
      ? { problem: 'past-closing' as const }
      : firstOpen > 0 && fromDate(appointment.startAt) + shift < firstOpen
        ? // Only reachable on a pull-forward, and named rather than refused for
          // D-26's reason: the three that CAN come forward still should.
          { problem: 'before-opening' as const }
        : {}),
  }));

  /**
   * THE CASCADE (D-26). An appointment left behind still occupies its old
   * time, so anything that would shift ON TOP of it cannot move either — and
   * that propagates backwards until nothing changes.
   *
   * Without this, a partial push would hand the database a genuine overlap and
   * the whole transaction would fail at COMMIT, which is a worse outcome than
   * either refusing or moving less: the desk would see a total failure with no
   * explanation of which pair collided.
   */
  const cascade = () => {
    for (let changed = true; changed; ) {
      changed = false;
      const staying = rows.filter((r) => r.problem);
      for (const row of rows) {
        if (row.problem) continue;
        const collides = staying.some(
          (s) => row.shiftedStart < s.stayingBlockedEnd && s.stayingStart < row.shiftedBlockedEnd,
        );
        if (collides) {
          row.problem = 'blocked-by-one-that-stays';
          changed = true;
        }
      }
    }
  };

  /**
   * THE CHAIRS, AND WHY THEY ARE PLANNED IN A LOOP WITH THE CASCADE (A-034).
   *
   * A chair is a second axis of the same problem, and the two feed each other:
   * an appointment that cannot find a chair stays put, and one that stays put
   * blocks anything that would shift onto its PROVIDER time. So the cascade
   * runs, the chairs are planned against what it decided, and a chair failure
   * sends both round again. Problems are only ever ADDED, so this settles in at
   * most one pass per appointment.
   */
  const chairRows = () =>
    rows.map((row) => ({
      id: row.appointment.id,
      resourceId: row.appointment.resourceId,
      staying: row.problem !== undefined,
      before: holdBefore(row),
      after: holdAfter(row),
      holderKey: holderOf(row),
      bodyBefore: bodyBefore(row),
      bodyAfter: bodyAfter(row),
    }));

  let chairs = new Map<string, string>();
  if (rows.some((r) => r.appointment.resourceId)) {
    const room = await loadRoom(db, {
      businessId: args.businessId,
      excludeAppointmentIds: rows.map((r) => r.appointment.id),
      windowStart: Math.min(...rows.flatMap((r) => [holdBefore(r).start, holdAfter(r).start])),
      windowEnd: Math.max(...rows.flatMap((r) => [holdBefore(r).end, holdAfter(r).end])),
    });

    for (;;) {
      cascade();
      const planned = planChairs(chairRows(), room);
      if (!('blocked' in planned)) {
        chairs = planned.chairs;
        break;
      }
      rows.find((r) => r.appointment.id === planned.blocked)!.problem = 'no-chair-free';
    }
  } else {
    cascade();
  }

  const candidates: PushCandidate[] = rows.map((row) => ({
    appointmentId: row.appointment.id,
    clientName: row.appointment.client?.name ?? null,
    from: row.appointment.startAt,
    to: toDate(instant(row.shiftedStart)),
    ...(row.problem ? { problem: row.problem } : {}),
    ...(chairs.has(row.appointment.id) ? { toResourceId: chairs.get(row.appointment.id)! } : {}),
  }));

  return {
    providerId: args.providerId,
    day: args.day,
    minutes: args.minutes,
    candidates,
    canPush: candidates.some((c) => c.problem === undefined),
    runningLateMinutes,
    runningLateAfter: deltaAfterPush({
      current: runningLateMinutes,
      minutes: args.minutes,
      leftBehind: candidates.filter((c) => c.problem !== undefined).length,
    }),
  };
}

interface Span {
  start: number;
  end: number;
}

interface RoomState {
  /** Every chair's type, INACTIVE ONES INCLUDED — an appointment can still be
   *  holding a chair that was retired after it was booked, and it still has to
   *  be given a chair of the right type at its destination. */
  typeOf: Map<string, string>;
  /** The chairs that can be ASSIGNED, by type, ordered by name — the same
   *  order `findFreeResource` uses, so a push and a booking agree about which
   *  chair is "the first free one". */
  byType: Map<string, string[]>;
  /** Holds belonging to appointments that are not part of this push at all:
   *  the other stylists' clients, whose chairs are simply not available —
   *  except to the SAME holder, which is what A-063 made true of the database
   *  and checkpoint 5 found the planner still did not know. */
  others: (Span & { resourceId: string; holderKey: string; body: Span })[];
}

/** The room, as one read, for the whole push (A-034). */
async function loadRoom(
  db: Prisma.TransactionClient | PrismaClient,
  args: { businessId: string; excludeAppointmentIds: string[]; windowStart: number; windowEnd: number },
): Promise<RoomState> {
  const [resources, holds] = await Promise.all([
    db.resource.findMany({
      where: { businessId: args.businessId },
      orderBy: { name: 'asc' },
      select: { id: true, resourceTypeId: true, active: true },
    }),
    db.appointmentResourceHold.findMany({
      where: {
        businessId: args.businessId,
        status: { in: [...ACTIVE_STATUSES] },
        // Instant-overlap, never a date filter — the same predicate the busy
        // set and the room's busy set use.
        blockedStart: { lt: toDate(instant(args.windowEnd)) },
        blockedEnd: { gt: toDate(instant(args.windowStart)) },
        appointmentId: { notIn: args.excludeAppointmentIds },
      },
      select: {
        resourceId: true,
        blockedStart: true,
        blockedEnd: true,
        holderKey: true,
        bodyStart: true,
        bodyEnd: true,
      },
    }),
  ]);

  const byType = new Map<string, string[]>();
  for (const resource of resources.filter((r) => r.active)) {
    byType.set(resource.resourceTypeId, [...(byType.get(resource.resourceTypeId) ?? []), resource.id]);
  }

  return {
    typeOf: new Map(resources.map((r) => [r.id, r.resourceTypeId])),
    byType,
    others: holds.map((h) => ({
      resourceId: h.resourceId,
      start: fromDate(h.blockedStart),
      end: fromDate(h.blockedEnd),
      holderKey: h.holderKey,
      body: { start: fromDate(h.bodyStart), end: fromDate(h.bodyEnd) },
    })),
  };
}

/**
 * Which chair each moving appointment takes at its destination (A-034).
 *
 * The moving set's OWN current holds are deliberately absent from the busy
 * picture: they are all vacated by this same transaction, so counting them
 * would make a uniform shift look like it needs a whole second room. What DOES
 * count is everybody else's holds and the holds of the appointments this push
 * is leaving behind — those genuinely stay where they are.
 *
 * Keeps the chair she is already in whenever it is still free, which makes an
 * ordinary "we are half an hour behind" change no seating at all.
 *
 * ponytail: greedy first-fit, not a bipartite matching. A uniform shift keeps
 * every existing chair, so greedy cannot do worse than the seating the room
 * already has; a contrived room could still leave one client unseated where a
 * global re-shuffle would fit her, and she comes back as `leftBehind` rather
 * than as a wrong answer. Upgrade to a matching if a real salon ever hits it.
 */
function planChairs(
  rows: {
    id: string;
    resourceId: string | null;
    staying: boolean;
    before: Span;
    after: Span;
    holderKey: string;
    bodyBefore: Span;
    bodyAfter: Span;
  }[],
  room: RoomState,
): { chairs: Map<string, string> } | { blocked: string } {
  interface Held extends Span {
    holderKey: string;
    body: Span;
  }
  const busy = new Map<string, Held[]>();
  const occupy = (resourceId: string, held: Held) =>
    busy.set(resourceId, [...(busy.get(resourceId) ?? []), held]);

  // Half-open on both sides, like every other range in this project: a hold
  // ending at 15:00 frees its chair for one starting at 15:00.
  const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

  /**
   * THE TWO QUESTIONS THE DATABASE ASKS, ASKED IN THE SAME SHAPE (A-063).
   *
   * This used to be one question — "does anything overlap?" — which is the
   * planner A-063 left behind as "strictly stricter than the database, a
   * seating cosmetic". Checkpoint 5 proved it is not cosmetic: a client whose
   * cut and colour share one chair was counted as needing two, and on a full
   * Saturday the push reported `no-chair-free` and left her behind for a chair
   * she was sitting in. A planner stricter than the constraint does not fail
   * safe, it refuses a move the salon needs most when it is busiest.
   *
   * - Envelopes may overlap only for the SAME holder (`holderKey WITH <>`).
   * - Bodies never overlap, whoever the holder is — the stronger of the two.
   */
  const free = (resourceId: string, envelope: Span, body: Span, holderKey: string) =>
    !(busy.get(resourceId) ?? []).some(
      (held) =>
        overlaps(envelope, held) && (held.holderKey !== holderKey || overlaps(body, held.body)),
    );

  for (const hold of room.others) occupy(hold.resourceId, hold);
  for (const row of rows) {
    if (row.staying && row.resourceId) {
      occupy(row.resourceId, { ...row.before, holderKey: row.holderKey, body: row.bodyBefore });
    }
  }

  const chairs = new Map<string, string>();
  for (const row of rows) {
    if (row.staying || !row.resourceId) continue;

    const type = room.typeOf.get(row.resourceId);
    const assignable = type ? (room.byType.get(type) ?? []) : [];
    // Her own chair first — but only if it is still assignable, so a chair
    // retired since she was booked is not carried forward by the preference.
    const options = assignable.includes(row.resourceId) ? [row.resourceId, ...assignable] : assignable;
    const chair = options.find((id) => free(id, row.after, row.bodyAfter, row.holderKey));
    if (!chair) return { blocked: row.id };

    chairs.set(row.id, chair);
    occupy(chair, { ...row.after, holderKey: row.holderKey, body: row.bodyAfter });
  }
  return { chairs };
}

export interface PushResult {
  moved: number;
  notified: number;
  /** D-26: what stayed put, and why. Named rather than silently dropped —
   *  this is the half the desk has to act on next. */
  leftBehind: PushCandidate[];
  /** D-43. The delta before this push and after it — equal on every arm that
   *  leaves it standing (a partial push, a pull-forward, nothing to move), so
   *  the desk is told which happened rather than left to infer it. */
  runningLateMinutes: number;
  runningLateAfter: number;
}

/**
 * Moves them, in one transaction, with the constraint deferred to COMMIT.
 *
 * The clients are told through the outbox (D-14, APPT-04's "running ~30 min
 * behind" notice) inside the same transaction: a column that moved without
 * anybody being told is the silent change Goal 2 forbids.
 */
export async function pushColumn(
  prisma: PrismaClient,
  args: {
    businessId: string;
    providerId: string;
    day: string;
    fromAt: Date;
    minutes: number;
    actor: Actor;
    reason?: string | null;
  },
): Promise<PushResult> {
  if (!Number.isInteger(args.minutes) || args.minutes === 0) {
    throw new RangeError(`A push must be a non-zero whole number of minutes, got: ${args.minutes}`);
  }

  return prisma.$transaction(async (tx) => {
    const preview = await previewPush(tx, args);
    // D-26: move what CAN move. `leftBehind` is returned, not thrown — a push
    // that names its casualties is not the silently-lossy shift APPT-04
    // forbids, and refusing outright left the desk doing by hand exactly what
    // this feature exists to do (demo checkpoint 2, §9).
    const movable = preview.candidates.filter((c) => c.problem === undefined);
    const leftBehind = preview.candidates.filter((c) => c.problem !== undefined);
    const delta = { runningLateMinutes: preview.runningLateMinutes, runningLateAfter: preview.runningLateAfter };
    if (movable.length === 0) return { moved: 0, notified: 0, leftBehind, ...delta };

    // THE DEFERRAL, and the only place in this codebase that asks for it.
    // Scoped to this transaction: everywhere else the check stays immediate.
    //
    // A-034 added the RESOURCE constraint to it, for exactly the reason the
    // provider one was deferred: two back-to-back clients legitimately share a
    // chair — half-open ranges give the 15:00 the chair the 14:00 vacates — and
    // shifting the pair puts the first on top of the second mid-transaction.
    // That was reaching the desk as a raw `23P01` in the middle of a push the
    // preview had just promised.
    // A-063 split the resource invariant in two — envelopes may overlap for one
    // holder, bodies never overlap for anyone — and BOTH halves need deferring
    // for the same reason. Naming constraints one at a time is the same trap as
    // a status enum being "one edit": the body constraint went in immediate and
    // a legitimate push started failing as a raw 23P01 the preview had promised
    // would work. If a third is ever added, it belongs on this list too.
    await tx.$executeRawUnsafe('SET CONSTRAINTS "appointment_block_no_overlap" DEFERRED');
    await tx.$executeRawUnsafe('SET CONSTRAINTS "appointment_resource_no_overlap" DEFERRED');
    await tx.$executeRawUnsafe('SET CONSTRAINTS "appointment_resource_body_no_overlap" DEFERRED');

    const business = await tx.business.findUniqueOrThrow({
      where: { id: args.businessId },
      select: { timezone: true },
    });
    const zone = business.timezone as ZoneId;
    const shift = args.minutes * MIN;

    let notified = 0;
    for (const candidate of movable) {
      const appointment = await tx.appointment.findUniqueOrThrow({
        where: { id: candidate.appointmentId },
        select: { id: true, startAt: true, endAt: true, client: { select: { email: true, phone: true } } },
      });

      const startAt = toDate(instant(fromDate(appointment.startAt) + shift));
      const endAt = toDate(instant(fromDate(appointment.endAt) + shift));
      const label = toLabel(fromDate(startAt), zone);

      await tx.appointment.update({
        where: { id: appointment.id },
        // blockedStart/blockedEnd are recomputed by the A-003 trigger.
        data: {
          startAt,
          endAt,
          startDay: label.day,
          startWallTime: label.time,
          // A-034 — THE CHAIR FOLLOWS THE MOVE (RES-03). The chair the PREVIEW
          // chose, not one picked here: the preview is what promised this
          // outcome, and an appointment that could not be seated never reached
          // this loop (it is in `leftBehind`).
          ...(candidate.toResourceId ? { resourceId: candidate.toResourceId } : {}),
        },
      });

      // TOKEN-02: the customer's link follows the appointment rather than
      // being reissued — she is holding the message it came in.
      await repointManageTokens(tx, appointment.id, endAt);

      await tx.appointmentEvent.create({
        data: {
          businessId: args.businessId,
          appointmentId: appointment.id,
          type: 'column_pushed',
          actor: args.actor.type,
          actorRef: args.actor.ref,
          reason: args.reason?.trim() || null,
          payload: {
            from: appointment.startAt.toISOString(),
            to: startAt.toISOString(),
            minutes: args.minutes,
          } satisfies Prisma.InputJsonValue,
        },
      });

      await enqueueNotification(tx, {
        businessId: args.businessId,
        // Keyed on the DESTINATION instant, so a second push is a second
        // message and a retry of the same one is not (P1-7's shape). The
        // prefix is unchanged across the sign: a push and its immediate
        // undo land on different instants anyway, and two prefixes would let
        // "push 20, pull 20, push 20" send the same message twice.
        dedupeKey: `running-late:${appointment.id}:${fromDate(startAt)}`,
        appointmentId: appointment.id,
        channel: appointment.client?.email ? 'email' : 'sms',
        // A-059. "Running behind" is a lie on a pull-forward, and it is the
        // wording the client reads. The sign of the push decides which of the
        // two things actually happened to her.
        template: args.minutes > 0 ? 'appointment.running_late' : 'appointment.moved_earlier',
        recipient: appointment.client?.email ?? appointment.client?.phone ?? null,
        payload: {
          appointmentId: appointment.id,
          startAt: startAt.toISOString(),
          previousStartAt: appointment.startAt.toISOString(),
          // Signed, and named for what it is rather than for the common case:
          // "minutesLate: -20" is a payload the next reader has to decode.
          minutesShifted: args.minutes,
        },
      });
      notified += 1;
    }

    /**
     * D-43 — THE DELTA THIS PUSH JUST WORKED OFF, IN THE SAME TRANSACTION.
     *
     * Not a follow-up write and not the caller's job: a push that moves the
     * column and leaves "+40 min" standing makes every projected chip
     * double-count it, keeps the ring-round listing clients to phone about a
     * delay now baked into their booked times, and keeps the engine refusing to
     * sell a gap that genuinely exists.
     *
     * `setRunningLate` rather than a bare update, because it is already the one
     * place that knows a delta of zero is a DELETED row rather than a stored
     * zero — and the actor stamp is honest: the push is what changed the claim.
     * The `RunningLateTold` marks that survive a reduction go stale by A-059's
     * existing rule for free; a reduction to zero takes them with the claim they
     * hang off, exactly as "Back on time" always has (D-41).
     */
    if (preview.runningLateAfter !== preview.runningLateMinutes) {
      await setRunningLate(tx, {
        businessId: args.businessId,
        providerId: args.providerId,
        day: args.day,
        minutes: preview.runningLateAfter,
        actor: args.actor,
      });
    }

    return { moved: movable.length, notified, leftBehind, ...delta };
  }, { timeout: 15_000 })
    .catch((error: unknown) => {
      // A-034. The preview runs inside this transaction and plans both axes, so
      // reaching the constraint means somebody COMMITTED between the plan and
      // the COMMIT — a genuine lost race, not a push we should have refused.
      // Before this it was an unmapped `23P01`: a 500 in the middle of a
      // workflow whose whole point is that the desk is told what happened.
      if (isSlotTakenError(error)) throw new SlotTaken([]);
      throw error;
    });
}
