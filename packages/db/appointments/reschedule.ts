/**
 * A-014 — RESCHEDULE (APPT-05, D-6, D-11, spec §4.6).
 *
 * ONE ROW, ONE `UPDATE`, ONE TRANSACTION. Not a status, not a new row, not
 * cancel-then-book. The spec lists four failure modes for cancel-then-book
 * across two transactions and one of them is unrecoverable: the cancel
 * commits, the destination is taken in the interim, the rebook fails, and the
 * customer now has NO appointment while her original slot has been given away.
 *
 * The refinement worth stating precisely, because someone will try to
 * "simplify" this back: cancel-then-insert is fine INSIDE A SINGLE
 * TRANSACTION. The distinction is not update-vs-insert, it is ONE TRANSACTION
 * VS TWO.
 *
 * Why the same row is also the right primitive rather than merely the safe
 * one: the exclusion constraint compares the updated row against OTHER rows,
 * never against its own previous version, so moving a 60-minute appointment
 * from 09:00 to 09:30 — where old and new ranges overlap by 30 minutes — does
 * not false-conflict. The ENGINE needs telling separately, which is what
 * `excludeAppointmentId` is for.
 *
 * CHANGING THE PROVIDER IS NOW HERE (A-038, D-31), and the machinery the old
 * note in this header said it would need turned out to be needed ANYWAY — see
 * `lockForMove` below. The move that forced it is one the two existing
 * primitives cannot compose: "put her with Priya at 2 instead of 3" fails as a
 * reassign (Priya has her own 3pm) and fails as a reschedule (Dana is off at
 * 2), while the destination is free throughout.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *  - Changing the services. The appointment keeps the duration and the price
 *    it was booked with (D-18's snapshot) — a reschedule moves an appointment,
 *    it does not re-sell it.
 *  - Overriding. Staff moving an appointment somewhere the engine will not
 *    offer is BOOK-05's override (A-017) and "push the column" (A-018), each
 *    with its own audit trail and reason. A silent override here would make
 *    both meaningless.
 */
import {
  type AppointmentStatus,
  type Slot,
  type SlotResult,
  type TransitionRefusal,
  canReschedule,
  computeSlots,
} from '../../core/scheduling';
import { type ZoneId, fromDate, instant, toDate, toLabel } from '../../core/time';
import { worstCutoff } from '../../core/settings';
import type { Actor } from '../../core/auth';
import { BookingRejected, SlotNotOffered, SlotTaken } from '../booking/errors';
import { qualifiedForVisit } from '../qualification';
import { isSlotTakenError } from '../errors';
import { enqueueNotification } from '../notifications';
import { buildSlotQuery } from '../scheduling';
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { repointManageTokens } from './manage-token';

const MIN = 60_000;

/** The move is not permitted — the wrong actor, the wrong status, or inside
 *  the cancellation cutoff. Carries the machine-readable reason so a route can
 *  map it, exactly as `TransitionRefused` does for status changes. */
export class RescheduleRefused extends Error {
  readonly refusal: TransitionRefusal;
  readonly from: AppointmentStatus;
  constructor(from: AppointmentStatus, refusal: TransitionRefusal) {
    super(`Cannot reschedule an appointment that is ${from}: ${refusal}.`);
    this.name = 'RescheduleRefused';
    this.refusal = refusal;
    this.from = from;
  }
}

/** Somebody else moved this appointment while we were deciding. Distinct from
 *  `SlotTaken`: the destination may be perfectly free — it is the SOURCE that
 *  changed under us. */
export class AppointmentAlreadyMoved extends Error {
  constructor() {
    super('This appointment has already been moved by somebody else.');
    this.name = 'AppointmentAlreadyMoved';
  }
}

export interface RescheduleInput {
  appointmentId: string;
  /** The new start, as an INSTANT (D-4). No `{date, time}` pair reaches here:
   *  on fall-back day "01:30" names two moments. */
  startAt: Date;
  /** Injected, never read from the clock here — the cutoff depends on it. */
  now: Date;
  actor: Actor;
  /**
   * A-038 (D-31). The provider this appointment should end up with, when that
   * is changing too. Absent or equal to the current one is the ordinary time
   * move and behaves exactly as before.
   *
   * STAFF ONLY in practice — nothing stops a token actor passing it, so the
   * check is the qualification rule and the transition table, not the caller's
   * good manners.
   */
  toProviderId?: string | null;
  /** Defaults to the RESTRICTED value, so a route that forgets gets the
   *  customer's horizon and no exclusion reasons. */
  audience?: 'public' | 'staff';
  /** Optional on a reschedule and recorded on the event when given ("client
   *  called, running late this week"). */
  reason?: string | null;
}

export interface RescheduledAppointment {
  id: string;
  from: Date;
  to: Date;
  endAt: Date;
}

export async function rescheduleAppointment(
  prisma: PrismaClient,
  input: RescheduleInput,
): Promise<RescheduledAppointment> {
  const audience = input.audience ?? 'public';

  if (fromDate(input.startAt) % MIN !== 0) {
    throw new SlotNotOffered(['not-on-a-whole-minute'], []);
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        const appointment = await loadAppointment(tx, input.appointmentId);

        if (fromDate(appointment.startAt) === fromDate(input.startAt)) {
          // Moving an appointment to where it already is would write an event
          // saying nothing happened and re-point a token that has not moved.
          throw new SlotNotOffered(['already-at-that-time'], []);
        }

        assertMovable(appointment, input);

        const zone = appointment.business.timezone as ZoneId;
        const destinationDay = toLabel(fromDate(input.startAt), zone);
        const toProviderId = input.toProviderId?.trim() || appointment.providerId;
        const sourceDay = toLabel(fromDate(appointment.startAt), zone);

        if (toProviderId !== appointment.providerId) {
          await assertProviderCanTakeIt(tx, appointment, toProviderId);
        }

        await lockForMove(tx, {
          source: `${appointment.providerId}:${sourceDay.day}`,
          destination: `${toProviderId}:${destinationDay.day}`,
        });

        const offered = await findOffered(tx, appointment, input, audience, destinationDay.day, toProviderId);
        const endAt = toDate(instant(fromDate(input.startAt) + bookedDurationMinutes(appointment) * MIN));

        // THE WRITE IS CONDITIONAL ON THE TIME WE DECIDED AGAINST, the same
        // reflex as A-012's status-conditional update and the exclusion
        // constraint itself. Two front-desk taps moving the same appointment
        // to two different times would otherwise both pass their re-checks and
        // both write, leaving one start time and two events that disagree.
        const written = await tx.appointment.updateMany({
          where: { id: appointment.id, startAt: appointment.startAt },
          data: {
            startAt: input.startAt,
            endAt,
            startDay: destinationDay.day,
            startWallTime: destinationDay.time,
            // A-038. One UPDATE moves BOTH axes, which is the entire point:
            // the appointment keeps its id, so her manage link, her history
            // and her event log all follow it across the change.
            providerId: toProviderId,
            // A conflict acknowledged against the OLD provider says nothing
            // about the new one (A-019's `conflictAckAt` is cleared by the
            // bulk reassign for the same reason).
            ...(toProviderId !== appointment.providerId
              ? { conflictAckAt: null, conflictAckReason: null }
              : {}),
            // blockedStart/blockedEnd are recomputed by the A-003 trigger on
            // UPDATE as well as INSERT, so the busy set and the constraint
            // follow the move without this file knowing the buffer arithmetic.
          },
        });
        if (written.count === 0) throw new AppointmentAlreadyMoved();

        // TOKEN-02: the link is RE-POINTED, never reissued. The customer is
        // holding the message she rescheduled from, and it is the one she will
        // open again to cancel — reissuing would kill it at that exact moment,
        // which is spec §4.6's fourth failure mode arriving by another route.
        await repointManageTokens(tx, appointment.id, endAt);

        // TWO EVENTS, ONE TRANSACTION (D-31). APPT-07 names "provider change"
        // as its own kind of event and the log is what the desk reads back, so
        // a move that changed both axes has to say both — collapsing it into
        // one `rescheduled` row would lose the fact that the stylist changed,
        // which is the half the client will ring about.
        if (toProviderId !== appointment.providerId) {
          await tx.appointmentEvent.create({
            data: {
              businessId: appointment.businessId,
              appointmentId: appointment.id,
              type: 'provider_changed',
              actor: input.actor.type,
              actorRef: input.actor.ref,
              reason: input.reason?.trim() || null,
              payload: {
                fromProviderId: appointment.providerId,
                toProviderId,
              } satisfies Prisma.InputJsonValue,
            },
          });
        }

        await tx.appointmentEvent.create({
          data: {
            businessId: appointment.businessId,
            appointmentId: appointment.id,
            // APPT-07 asks for "reschedule with both sides". The row survives,
            // so the old time exists nowhere else once the UPDATE lands — this
            // event IS the history (D-6), which is why the log is append-only.
            type: 'rescheduled',
            actor: input.actor.type,
            actorRef: input.actor.ref,
            reason: input.reason?.trim() || null,
            payload: {
              from: appointment.startAt.toISOString(),
              to: input.startAt.toISOString(),
              fromEndAt: appointment.endAt.toISOString(),
              toEndAt: endAt.toISOString(),
              audience,
              offered: offered !== undefined,
              ...(toProviderId !== appointment.providerId ? { toProviderId } : {}),
            } satisfies Prisma.InputJsonValue,
          },
        });

        await enqueueNotification(tx, {
          businessId: appointment.businessId,
          // Keyed on the DESTINATION instant (P1-7's shape): rescheduling
          // twice is two messages, retrying once is one. Keyed on the
          // appointment alone, the second move would be silent.
          dedupeKey: `reschedule:${appointment.id}:${fromDate(input.startAt)}`,
          appointmentId: appointment.id,
          channel: appointment.client?.email ? 'email' : 'sms',
          template: 'appointment.rescheduled',
          recipient: appointment.client?.email ?? appointment.client?.phone ?? null,
          payload: {
            appointmentId: appointment.id,
            startAt: input.startAt.toISOString(),
            previousStartAt: appointment.startAt.toISOString(),
          },
        });

        return { id: appointment.id, from: appointment.startAt, to: input.startAt, endAt };
      },
      // Above Prisma's 5s default: queue time behind the advisory lock counts
      // against it, and a timeout surfaces as P2028, which looks nothing like
      // a conflict.
      { timeout: 15_000 },
    );
  } catch (error) {
    if (isSlotTakenError(error)) {
      // The constraint refused it — somebody committed between the re-check
      // and the write. No alternatives are recomputed here: unlike a first
      // booking, the customer still HAS her appointment, so the honest answer
      // is "that time went, yours is unchanged".
      throw new SlotTaken([]);
    }
    throw error;
  }
}

// ─────────────────────────── internals ───────────────────────────

async function loadAppointment(db: Prisma.TransactionClient | PrismaClient, id: string) {
  return db.appointment.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      businessId: true,
      providerId: true,
      status: true,
      startAt: true,
      endAt: true,
      client: { select: { email: true, phone: true } },
      business: { select: { timezone: true, cancellationCutoffMinutes: true } },
      lines: {
        orderBy: { ordinal: 'asc' },
        select: {
          serviceId: true,
          durationMinutes: true,
          service: { select: { id: true, name: true, cancellationCutoffMinutes: true } },
        },
      },
    },
  });
}

type LoadedAppointment = Awaited<ReturnType<typeof loadAppointment>>;

/** D-6 + APPT-05, decided by the ONE module that owns the rule. */
function assertMovable(appointment: LoadedAppointment, input: RescheduleInput): void {
  // D-19: a service may demand more notice than the business default, and a
  // visit may carry several. The most restrictive governs — the same
  // `worstCutoff` the settings form validates against and the cancel path
  // uses, so the rule a customer meets is the rule the owner was shown.
  const cutoff = worstCutoff(
    appointment.business.cancellationCutoffMinutes,
    appointment.lines.map((l) => ({
      id: l.service.id,
      name: l.service.name,
      cancellationCutoffMinutes: l.service.cancellationCutoffMinutes,
    })),
  );

  const decision = canReschedule(appointment.status, {
    actor: input.actor.type,
    now: fromDate(input.now),
    startAt: fromDate(appointment.startAt),
    endAt: fromDate(appointment.endAt),
    cancellationCutoffMinutes: cutoff.minutes,
    reason: input.reason,
  });

  if (!decision.allowed) throw new RescheduleRefused(appointment.status, decision.refusal);
}

/**
 * Re-runs the engine INSIDE the transaction against the destination day.
 *
 * The appointment is excluded from its own busy set (see `busy-set.ts`), and
 * the service shape is the one it was BOOKED with rather than whatever the
 * catalogue says today — a duration changed last week must not silently
 * lengthen an appointment somebody already agreed to.
 */
async function findOffered(
  tx: Prisma.TransactionClient,
  appointment: LoadedAppointment,
  input: RescheduleInput,
  audience: 'public' | 'staff',
  day: string,
  providerId: string,
): Promise<Slot | undefined> {
  const result = await slotsForMove(tx, appointment, { day, now: input.now, audience, explain: true, providerId });

  const offered = result.slots.find((s) => s.start === fromDate(input.startAt));
  if (offered) return offered;

  const excluded = result.excluded.find((e) => e.candidateStart === fromDate(input.startAt));
  const reasons = excluded?.reasons ?? [];
  // The same split as the booking path: "somebody just took it" is a
  // different sentence from "that was never on offer", and reporting a lost
  // race as "outside working hours" would be actively misleading.
  const occupied =
    reasons.includes('overlaps-booking') ||
    reasons.includes('overlaps-buffer') ||
    reasons.includes('overlaps-time-off') ||
    reasons.includes('overlaps-block');
  if (occupied) throw new SlotTaken([...result.slots]);
  throw new SlotNotOffered(reasons, [...result.slots]);
}

/**
 * The engine, asked about ONE EXISTING APPOINTMENT on one day.
 *
 * Exported (via `rescheduleOptions`) because the screen that offers a customer
 * her new times and the write path that accepts one must ask the identical
 * question. Two callers assembling this separately is how a UI comes to offer
 * a time the server then refuses — the same reasoning that makes
 * `daysWithAvailability` derive from the engine rather than approximate it.
 */
async function slotsForMove(
  db: Prisma.TransactionClient | PrismaClient,
  appointment: LoadedAppointment,
  args: { day: string; now: Date; audience: 'public' | 'staff'; explain?: boolean; providerId?: string },
): Promise<SlotResult> {
  const { query } = await buildSlotQuery(db, {
    businessId: appointment.businessId,
    // A-038: the DESTINATION provider's windows and busy set, which is what
    // makes "Priya at 2" answerable at all — Dana's calendar has nothing to
    // say about it.
    providerId: args.providerId ?? appointment.providerId,
    serviceIds: appointment.lines.map((l) => l.serviceId),
    day: args.day,
    now: args.now,
    audience: args.audience,
    // The appointment must not block its own destination — see `busy-set.ts`.
    excludeAppointmentId: appointment.id,
  });

  return computeSlots({
    ...query,
    // D-18's snapshot, deliberately overriding what buildSlotQuery derived
    // from the live catalogue. The buffers stay as the query built them:
    // buffers are the salon's operational padding, not something the client
    // agreed to, and A-018's column push is where a stale buffer would
    // actually matter.
    service: { ...query.service, durationMinutes: bookedDurationMinutes(appointment) },
    ...(args.explain ? { explain: true } : {}),
  });
}

/** The times this appointment could move to on a given day. The screen's
 *  source of truth, and the same call the write path makes. */
export async function rescheduleOptions(
  prisma: PrismaClient,
  args: {
    appointmentId: string;
    day: string;
    now: Date;
    audience?: 'public' | 'staff';
    /** A-038 — "what could Priya do with this visit that day?" Defaults to the
     *  provider it is already with, which is every existing caller. */
    providerId?: string | null;
  },
): Promise<SlotResult> {
  const appointment = await loadAppointment(prisma, args.appointmentId);
  return slotsForMove(prisma, appointment, {
    day: args.day,
    now: args.now,
    audience: args.audience ?? 'public',
    providerId: args.providerId?.trim() || appointment.providerId,
  });
}

/** The duration the client actually agreed to, from the snapshotted lines
 *  (D-18) — never re-derived from the current service configuration. */
function bookedDurationMinutes(appointment: LoadedAppointment): number {
  return appointment.lines.reduce((total, line) => total + line.durationMinutes, 0);
}

/**
 * The lock keys for a move, deduplicated and in a TOTAL ORDER.
 *
 * Exported because the ordering IS the deadlock proof, and a property is a
 * deterministic thing to test where "run the swap and see if it deadlocks" is
 * a coin flip — which CLAUDE.md rules out as a race test outright.
 */
export function moveLockKeys(keys: { source: string; destination: string }): string[] {
  return [...new Set([keys.source, keys.destination])].sort();
}

/**
 * BOTH provider-days, IN A CANONICAL ORDER — and the reason is worth stating,
 * because D-31 was recorded believing one lock would do (corrected there).
 *
 * The lock's job (D-24) is to serialize writers whose in-transaction engine
 * re-check must see committed state. By that argument alone the SOURCE
 * provider-day needs no lock: a move only ever vacates it, and freeing time
 * cannot create a conflict. That argument is correct and it is not the whole
 * problem.
 *
 * The problem is the EXCLUSION CONSTRAINT, which does not fail fast against an
 * uncommitted conflicting row — it WAITS on the other transaction. So two
 * desks swapping two clients between two stylists ("give Dana's 2pm to Priya
 * and Priya's 2pm to Dana", one half each) deadlock: each move's new block
 * waits for the other's old block to go away. Postgres resolves that as
 * `40P01`, which is not `23P01`, does not map to `SlotTaken`, and reaches the
 * desk as a 500. This repo has already met that exact failure once, in A-030.
 *
 * Sorting the two keys gives every mover a total order over the locks, so the
 * cycle cannot form. Deduplicated when both sides are the same key, which is
 * every ordinary time move within one day — those still take exactly one lock,
 * and nothing about the common path changed.
 *
 * NOTE this also closes the same latent deadlock for a SAME-PROVIDER move
 * across two days, which has been reachable since A-014: two appointments
 * swapping days on one provider is the identical cycle with the identical
 * cause, and only the destination day was ever locked.
 */
async function lockForMove(
  tx: Prisma.TransactionClient,
  keys: { source: string; destination: string },
): Promise<void> {
  for (const key of moveLockKeys(keys)) {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, key);
  }
}

/**
 * SVC-02 and the active flag, before anything is locked or written.
 *
 * `BookingRejected` rather than a refusal type: this is the caller handing us
 * an impossible pair, not a race and not a rule about the appointment's state.
 * The qualification rule itself lives in one module shared with A-019's bulk
 * reassign — "where qualified" must mean the same thing on both surfaces.
 */
async function assertProviderCanTakeIt(
  tx: Prisma.TransactionClient,
  appointment: LoadedAppointment,
  toProviderId: string,
): Promise<void> {
  const target = await tx.provider.findFirst({
    where: { id: toProviderId, businessId: appointment.businessId },
    select: { active: true },
  });
  if (!target?.active) {
    throw new BookingRejected('toProviderId', 'That provider is not taking appointments.');
  }

  const qualified = await qualifiedForVisit(tx, {
    providerId: toProviderId,
    serviceIds: appointment.lines.map((l) => l.serviceId),
  });
  if (!qualified) {
    throw new BookingRejected('toProviderId', 'She is not set up to do everything in this visit.');
  }
}
