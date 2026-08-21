/**
 * A-019 — REASSIGNING AN APPOINTMENT TO ANOTHER PROVIDER (AVAIL-05).
 *
 * "Dana is off sick; give her Saturday to Priya where she is qualified."
 *
 * A SAME-ROW UPDATE, like the reschedule (D-6) and for the same reasons: the
 * appointment keeps its id, so the client's manage link still works and the
 * history does not fork. Only the provider changes — the time does not, which
 * is what makes this different from a reschedule and why the client may not
 * need telling at all.
 *
 * THE CONSTRAINT DOES THE HARD PART. Moving an appointment onto a provider who
 * is already busy at that time is refused by the database (D-2), not by a
 * check here — so a bulk reassign of nine appointments cannot half-succeed
 * into a double-book. Each one is its own transaction ON PURPOSE: the front
 * desk wants "three moved, six could not" rather than an all-or-nothing that
 * fails because of one awkward 2pm.
 */
import type { Actor } from '../../core/auth';
import { ACTIVE_STATUSES } from '../../core/scheduling';
import { isSlotTakenError } from '../errors';
import { enqueueNotification } from '../notifications';
import { qualifiedForVisit } from '../qualification';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

export type ReassignFailure = 'not-qualified' | 'provider-busy' | 'not-active' | 'not-reassignable';

export interface ReassignOutcome {
  appointmentId: string;
  ok: boolean;
  failure?: ReassignFailure;
  /** A-036: whether this move put a message in the outbox. `false` for a
   *  suppressed one and for a no-op move onto the provider already holding it. */
  notified?: boolean;
}

/**
 * A-036 (operator P-5). SILENTLY is the word AVAIL-05 forbids, and until this
 * row a bulk reassign was the one write path that moved a client's appointment
 * and told nobody — three clients handed to a different stylist, each finding
 * out on the day. The row goes in THIS transaction, so a move that commits
 * without its notice is not a state the database can hold.
 *
 * Suppressible because the front desk phones first as often as it texts, and a
 * text that arrives after the call contradicts a person the client just spoke
 * to. Default is to tell her: the unticked box is the silent cancellation.
 */
export async function reassignAppointment(
  prisma: PrismaClient,
  args: {
    businessId: string;
    appointmentId: string;
    toProviderId: string;
    actor: Actor;
    reason?: string | null;
    /** `false` = "I already rang her." Anything else tells her. */
    notify?: boolean;
  },
): Promise<ReassignOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.findFirstOrThrow({
        where: { id: args.appointmentId, businessId: args.businessId },
        select: {
          id: true,
          providerId: true,
          status: true,
          startAt: true,
          client: { select: { email: true, phone: true } },
          lines: { select: { serviceId: true } },
        },
      });

      if (!(ACTIVE_STATUSES as readonly string[]).includes(appointment.status)) {
        // A cancelled or completed appointment is not a problem to solve.
        return { appointmentId: args.appointmentId, ok: false, failure: 'not-reassignable' as const };
      }
      if (appointment.providerId === args.toProviderId) {
        return { appointmentId: args.appointmentId, ok: true };
      }

      const target = await tx.provider.findFirst({
        where: { id: args.toProviderId, businessId: args.businessId },
        select: { active: true, displayName: true },
      });
      if (!target) return { appointmentId: args.appointmentId, ok: false, failure: 'not-active' as const };
      if (!target.active) return { appointmentId: args.appointmentId, ok: false, failure: 'not-active' as const };

      // SVC-02: she has to be able to do the WHOLE visit. "Where qualified" is
      // the operative half of the bulk action's name. The rule lives in ONE
      // module (A-038) because the cross-provider reschedule asks it too.
      const qualified = await qualifiedForVisit(tx, {
        providerId: args.toProviderId,
        serviceIds: appointment.lines.map((l) => l.serviceId),
      });
      if (!qualified) {
        return { appointmentId: args.appointmentId, ok: false, failure: 'not-qualified' as const };
      }

      // The exclusion constraint decides whether the new provider is free —
      // the trigger recomputes the blocked range against the new row and
      // Postgres refuses an overlap. No check-then-write here either.
      await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          providerId: args.toProviderId,
          // The conflict this reassignment resolves is gone, so the
          // acknowledgment about it must not survive.
          conflictAckAt: null,
          conflictAckReason: null,
        },
      });

      await tx.appointmentEvent.create({
        data: {
          businessId: args.businessId,
          appointmentId: appointment.id,
          // APPT-07 names "provider change" as its own kind of event.
          type: 'provider_changed',
          actor: args.actor.type,
          actorRef: args.actor.ref,
          reason: args.reason?.trim() || null,
          payload: {
            fromProviderId: appointment.providerId,
            toProviderId: args.toProviderId,
          } satisfies Prisma.InputJsonValue,
        },
      });

      if (args.notify === false) return { appointmentId: args.appointmentId, ok: true, notified: false };

      await enqueueNotification(tx, {
        businessId: args.businessId,
        // Keyed on the DESTINATION provider, the same shape the reschedule
        // uses for the destination instant: moving her to Priya and then to
        // Sam is two messages, retrying the move to Priya is one.
        dedupeKey: `provider-changed:${appointment.id}:${args.toProviderId}`,
        appointmentId: appointment.id,
        channel: appointment.client?.email ? 'email' : 'sms',
        template: 'appointment.provider_changed',
        recipient: appointment.client?.email ?? appointment.client?.phone ?? null,
        payload: {
          appointmentId: appointment.id,
          startAt: appointment.startAt.toISOString(),
          providerName: target.displayName,
          // The desk's words, forwarded — "Dana is off sick" is the whole
          // message as far as the client is concerned (A-019's reason).
          reason: args.reason?.trim() || null,
        },
      });

      return { appointmentId: args.appointmentId, ok: true, notified: true };
    });
  } catch (error) {
    if (isSlotTakenError(error)) {
      // She is already with somebody at that time. Reported per appointment
      // rather than thrown, so a bulk reassign tells the desk exactly which
      // ones it could not do.
      return { appointmentId: args.appointmentId, ok: false, failure: 'provider-busy' };
    }
    throw error;
  }
}

/** "Reassign Saturday to Priya where qualified." Independently, so one
 *  awkward 2pm cannot roll back the eight that worked. */
export async function reassignMany(
  prisma: PrismaClient,
  args: {
    businessId: string;
    appointmentIds: readonly string[];
    toProviderId: string;
    actor: Actor;
    reason?: string | null;
    notify?: boolean;
  },
): Promise<ReassignOutcome[]> {
  const outcomes: ReassignOutcome[] = [];
  for (const appointmentId of args.appointmentIds) {
    outcomes.push(await reassignAppointment(prisma, { ...args, appointmentId }));
  }
  return outcomes;
}
