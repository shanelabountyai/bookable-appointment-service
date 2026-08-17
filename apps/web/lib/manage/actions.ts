'use server';

/**
 * What the manage link GRANTS (TOKEN-01): reschedule and cancel.
 *
 * Confirm is A-021's loop and comes through the same gate when it lands.
 *
 * D-10 applies to every string returned: "appointment", "reschedule",
 * "cancel". No status enum, no entity name, no internal identifier — including
 * in the failure wording, where a leaked `cancelled_late` would be the exact
 * tell TOKEN-03 forbids.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import {
  AppointmentAlreadyMoved,
  RescheduleRefused,
  TransitionRefused,
  rescheduleAppointment,
  rescheduleOptions,
  transitionAppointment,
} from '@bookable/db/appointments';
import { SlotNotOffered, SlotTaken } from '@bookable/db/booking';
import { daysWithAvailability } from '@bookable/db/scheduling';
import { customerTokenActor } from '@bookable/core/auth';
import { addDays, fromDate, instantFromIso, toDate, toLabel, zoneId } from '@bookable/core/time';
import { readableDay } from '@/lib/customer-format';
import { openManageLink } from './token-gate';

export interface CancelState {
  ok?: boolean;
  message?: string;
}

export async function cancelAppointment(_previous: CancelState, formData: FormData): Promise<CancelState> {
  const token = String(formData.get('token') ?? '');
  const gate = await openManageLink(token, new Date());
  if (!gate.ok) {
    return {
      ok: false,
      message:
        gate.reason === 'too-many'
          ? 'Too many requests just now. Please wait a minute and try again.'
          : 'This link is no longer valid. Please call the salon.',
    };
  }

  try {
    await cancelWithLateSplit(gate.grant.appointmentId, gate.grant.tokenId);
  } catch (error) {
    if (error instanceof TransitionRefused) {
      return { ok: false, message: 'That is not something we can change online. Please call the salon.' };
    }
    throw error;
  }

  revalidatePath(`/manage/${token}`);
  return { ok: true, message: 'Your appointment is cancelled.' };
}

/**
 * APPT-05 — a customer inside the cutoff is RECLASSIFIED, not blocked.
 *
 * The state machine refuses a plain cancel inside the cutoff and permits the
 * late one (A-012's decision, made once, there). Refusing outright would just
 * produce a no-show instead: strictly worse for the salon, and it loses the
 * data the split exists to capture. So the ask is "cancel", and the machine's
 * own refusal is what selects the late variant — this file never computes a
 * cutoff of its own, which is the second `if (status === ...)` the whole
 * transitions module exists to prevent.
 *
 * Two calls, not one transaction, and that is safe: the first one changed
 * nothing when it refused.
 */
async function cancelWithLateSplit(appointmentId: string, tokenId: string): Promise<void> {
  const actor = customerTokenActor(tokenId);
  try {
    await transitionAppointment(prisma, { appointmentId, to: 'cancelled', actor, now: new Date() });
  } catch (error) {
    if (error instanceof TransitionRefused && error.refusal === 'inside-cancellation-cutoff') {
      await transitionAppointment(prisma, { appointmentId, to: 'cancelled_late', actor, now: new Date() });
      return;
    }
    throw error;
  }
}

// ─────────────────────────── reschedule (A-014) ───────────────────────────

/** How far ahead the customer's day list looks. Same number as the booking
 *  flow's, and short for the same reason: scrolling ninety Tuesdays is not
 *  choosing, and each day costs a slot computation. */
const DAYS_AHEAD = 28;

export interface OpenDay {
  day: string;
  /** Formatted SERVER-side in the salon's zone — the browser must never derive
   *  it from a date string (D-3). */
  label: string;
}

export interface OfferedTime {
  /** The instant (D-4). On fall-back day "01:30" names two moments, so the
   *  radio's value is never a wall-clock label. */
  at: string;
  label: string;
  /** Shown only when the same label occurs twice that day (FB-5). */
  qualifier?: string;
}

/** The days this appointment could move to. */
export async function listRescheduleDays(token: string): Promise<OpenDay[]> {
  const gate = await openManageLink(token, new Date());
  if (!gate.ok) return [];

  const appointment = await prisma.appointment.findUniqueOrThrow({
    where: { id: gate.grant.appointmentId },
    select: {
      providerId: true,
      businessId: true,
      lines: { orderBy: { ordinal: 'asc' }, select: { serviceId: true } },
      business: { select: { timezone: true } },
    },
  });

  const now = new Date();
  const today = toLabel(fromDate(now), zoneId(appointment.business.timezone)).day;

  const days = await daysWithAvailability(prisma, {
    businessId: appointment.businessId,
    providerId: appointment.providerId,
    serviceIds: appointment.lines.map((l) => l.serviceId),
    now,
    audience: 'public',
    fromDay: today,
    toDay: addDays(today, DAYS_AHEAD),
    // Without this the appointment blocks its own day out of the list.
    excludeAppointmentId: gate.grant.appointmentId,
  });

  return days.map((day) => ({ day, label: readableDay(day) }));
}

/**
 * The times available on one day.
 *
 * Goes through `rescheduleOptions` — the SAME call the write path makes — so
 * the list cannot offer a time the server then refuses. In particular it uses
 * the duration this appointment was booked with (D-18), not the catalogue's
 * current one.
 */
export async function listRescheduleTimes(token: string, day: string): Promise<OfferedTime[]> {
  const gate = await openManageLink(token, new Date());
  if (!gate.ok) return [];

  const result = await rescheduleOptions(prisma, {
    appointmentId: gate.grant.appointmentId,
    day,
    now: new Date(),
    audience: 'public',
  });

  return result.slots.map((slot) => ({
    at: toDate(slot.start).toISOString(),
    label: slot.label.time,
    ...(slot.labelIsAmbiguous ? { qualifier: slot.label.abbreviation } : {}),
  }));
}

export interface RescheduleState {
  ok?: boolean;
  message?: string;
}

export async function rescheduleToTime(
  _previous: RescheduleState,
  formData: FormData,
): Promise<RescheduleState> {
  const token = String(formData.get('token') ?? '');
  const at = String(formData.get('at') ?? '');

  const gate = await openManageLink(token, new Date());
  if (!gate.ok) {
    return {
      ok: false,
      message:
        gate.reason === 'too-many'
          ? 'Too many requests just now. Please wait a minute and try again.'
          : 'This link is no longer valid. Please call the salon.',
    };
  }

  let startAt: Date;
  try {
    startAt = toDate(instantFromIso(at));
  } catch {
    return { ok: false, message: 'Please choose a time.' };
  }

  try {
    await rescheduleAppointment(prisma, {
      appointmentId: gate.grant.appointmentId,
      startAt,
      now: new Date(),
      // D-9: the customer acts as her token, which is what makes the
      // cancellation cutoff apply to her and not to the front desk, and what
      // puts a traceable actor on the event.
      actor: customerTokenActor(gate.grant.tokenId),
      audience: 'public',
    });
  } catch (error) {
    return { ok: false, message: customerWordingFor(error) };
  }

  revalidatePath(`/manage/${token}`);
  return { ok: true, message: 'Your appointment has been moved.' };
}

/**
 * D-10 in one place. Every branch is a sentence a customer can act on, and
 * none of them names a status, an entity or a rule identifier.
 *
 * `RescheduleRefused` inside the cutoff is the one worth wording carefully: it
 * is not "you may not", it is "it is too close now" — and the next step is the
 * phone, which the message has to say or the customer simply leaves.
 */
function customerWordingFor(error: unknown): string {
  if (error instanceof RescheduleRefused) {
    return error.refusal === 'inside-cancellation-cutoff'
      ? 'It is too close to your appointment to change it online. Please call the salon.'
      : 'That is not something we can change online. Please call the salon.';
  }
  if (error instanceof SlotTaken) return 'Sorry — that time has just been taken. Please pick another.';
  if (error instanceof SlotNotOffered) return 'That time is not available. Please pick another.';
  if (error instanceof AppointmentAlreadyMoved) {
    return 'Your appointment has just been changed by the salon. Please reload to see it.';
  }
  throw error;
}
