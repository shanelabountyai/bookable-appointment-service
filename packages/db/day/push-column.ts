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
 * closing time, or onto somebody else's. "Refuses silently-lossy shifts"
 * (APPT-04) means the preview names them and the push does not happen — a
 * column that half-moved is worse than one that did not.
 */
import type { Actor } from '../../core/auth';
import { ACTIVE_STATUSES, resolveWindow, wallTime } from '../../core/scheduling';
import { type ZoneId, calendarDay, fromDate, instant, toDate, toLabel, weekdayOf } from '../../core/time';
import { resolveDayWindows } from '../availability';
import { enqueueNotification } from '../notifications';
import { repointManageTokens } from '../appointments';
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
  problem?: 'past-closing' | 'blocked-by-one-that-stays';
}

export interface PushPreview {
  providerId: string;
  day: string;
  minutes: number;
  candidates: PushCandidate[];
  /** True when at least one appointment can actually move. Not "all of them"
   *  (D-26): the push is partial and says what it left. */
  canPush: boolean;
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

  const shift = args.minutes * MIN;

  interface Row {
    appointment: (typeof appointments)[number];
    shiftedStart: number;
    shiftedBlockedEnd: number;
    stayingStart: number;
    stayingBlockedEnd: number;
    problem?: PushCandidate['problem'];
  }

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

  const candidates: PushCandidate[] = rows.map((row) => ({
    appointmentId: row.appointment.id,
    clientName: row.appointment.client?.name ?? null,
    from: row.appointment.startAt,
    to: toDate(instant(row.shiftedStart)),
    ...(row.problem ? { problem: row.problem } : {}),
  }));

  return {
    providerId: args.providerId,
    day: args.day,
    minutes: args.minutes,
    candidates,
    canPush: candidates.some((c) => c.problem === undefined),
  };
}

export interface PushResult {
  moved: number;
  notified: number;
  /** D-26: what stayed put, and why. Named rather than silently dropped —
   *  this is the half the desk has to act on next. */
  leftBehind: PushCandidate[];
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
    if (movable.length === 0) return { moved: 0, notified: 0, leftBehind };

    // THE DEFERRAL, and the only place in this codebase that asks for it.
    // Scoped to this transaction: everywhere else the check stays immediate.
    await tx.$executeRawUnsafe('SET CONSTRAINTS "appointment_no_overlap" DEFERRED');

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
        data: { startAt, endAt, startDay: label.day, startWallTime: label.time },
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
        // message and a retry of the same one is not (P1-7's shape).
        dedupeKey: `running-late:${appointment.id}:${fromDate(startAt)}`,
        appointmentId: appointment.id,
        channel: appointment.client?.email ? 'email' : 'sms',
        template: 'appointment.running_late',
        recipient: appointment.client?.email ?? appointment.client?.phone ?? null,
        payload: {
          appointmentId: appointment.id,
          startAt: startAt.toISOString(),
          previousStartAt: appointment.startAt.toISOString(),
          minutesLate: args.minutes,
        },
      });
      notified += 1;
    }

    return { moved: movable.length, notified, leftBehind };
  }, { timeout: 15_000 });
}
