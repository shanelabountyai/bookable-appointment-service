'use server';

/**
 * A-033 — MOVING AN APPOINTMENT FROM THE STAFF SIDE (APPT-05, D-6).
 *
 * The write path has existed since A-014 and had exactly ONE caller: the
 * customer's manage link. So the desk's only way to answer "can you push my 3
 * o'clock to 4?" was to cancel and rebook — which A-012 correctly records as
 * `cancelled_late` against a client who did nothing wrong, on five surfaces
 * and in the owner's cancellation tile. This file is the missing caller, not a
 * second mechanism: `rescheduleAppointment` and `rescheduleOptions` are the
 * same functions the customer flow uses.
 *
 * STAFF ARE THE UNRESTRICTED CALLER, the same way they are for booking
 * (A-017): `audience: 'staff'` lifts the horizon (D-21) and the lead time
 * (D-25), and `canReschedule` already exempts them from the cancellation
 * cutoff (APPT-05). Nothing here re-implements any of that — passing the
 * actor is what does it.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import {
  AppointmentAlreadyMoved,
  RescheduleRefused,
  rescheduleAppointment,
  rescheduleOptions,
} from '@bookable/db/appointments';
import { SlotNotOffered, SlotTaken } from '@bookable/db/booking';
import type { TransitionRefusal } from '@bookable/core/scheduling';
import { staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import { requireStaff } from '@/lib/auth/session';
import { readableReason } from '@/lib/scheduling-words';

export interface MoveOption {
  /** The instant, offset-bearing (D-4). The label is never posted back: on
   *  fall-back day two of them read "01:30" and are an hour apart. */
  at: string;
  label: string;
  qualifier?: string;
}

/**
 * The times this appointment could move to on one day.
 *
 * `rescheduleOptions` is THE SAME call the write path makes, which is what
 * stops this screen offering a time the server then refuses — and it uses the
 * duration the client actually agreed to (D-18), not whatever the catalogue
 * says today.
 */
export async function staffMoveOptions(appointmentId: string, day: string): Promise<MoveOption[]> {
  await requireStaff();
  if (!appointmentId || !day) return [];

  const result = await rescheduleOptions(prisma, {
    appointmentId,
    day,
    now: new Date(),
    // No horizon, no lead time. The desk pre-books a year out for a wedding
    // and moves someone into twenty minutes' time; both are ordinary.
    audience: 'staff',
  });

  return result.slots.map((slot) => ({
    at: toDate(slot.start).toISOString(),
    label: slot.label.time,
    ...(slot.labelIsAmbiguous ? { qualifier: slot.label.abbreviation } : {}),
  }));
}

export interface MoveState {
  ok?: boolean;
  message?: string;
}

export async function moveAppointment(_previous: MoveState, formData: FormData): Promise<MoveState> {
  const staff = await requireStaff();
  const appointmentId = String(formData.get('appointmentId') ?? '');
  const at = String(formData.get('at') ?? '');
  const reason = String(formData.get('reason') ?? '');

  let startAt: Date;
  try {
    startAt = toDate(instantFromIso(at));
  } catch {
    return { ok: false, message: 'Pick a time first.' };
  }

  try {
    await rescheduleAppointment(prisma, {
      appointmentId,
      startAt,
      now: new Date(),
      // D-9. The actor is what lifts the cutoff and what puts a name — as far
      // as one credential goes today — on the event the client will be read
      // back from.
      actor: staffActor(staff.id),
      audience: 'staff',
      reason,
    });
  } catch (error) {
    return { ok: false, message: staffWordingFor(error) };
  }

  revalidatePath(`/staff/appointments/${appointmentId}`);
  revalidatePath('/staff/day');
  revalidatePath('/staff/conflicts');
  // TOKEN-02: her existing link still works and now points at the new time —
  // `rescheduleAppointment` re-points it rather than reissuing, so the desk
  // never has to send a fresh one.
  return { ok: true, message: 'Moved. Her existing link still works, and she has been sent the new time.' };
}

/**
 * Staff wording, which is the OPPOSITE of the customer's (D-10).
 *
 * A customer is told the one thing she can act on and nothing about why. The
 * desk needs the reason, in the salon's own words, because the next action
 * depends on it: a time that has gone means pick another, a status that
 * refuses the move means this is not a reschedule at all.
 */
function staffWordingFor(error: unknown): string {
  if (error instanceof SlotTaken) {
    return 'That time went while you were deciding — her appointment is unchanged. Pick another.';
  }
  if (error instanceof AppointmentAlreadyMoved) {
    return 'Somebody else moved this one just now. Reload to see where it went.';
  }
  if (error instanceof SlotNotOffered) {
    if (error.reasons.includes('already-at-that-time')) return 'That is where it already is.';
    // The engine's reasons, as the desk would say them. An unknown reason
    // falls through readable rather than as a raw identifier.
    return `Not offered — ${error.reasons.map(readableReason).join('; ') || 'that time is not available'}.`;
  }
  if (error instanceof RescheduleRefused) {
    return REFUSALS[error.refusal] ?? `This one cannot be moved (${error.from.replace('_', ' ')}).`;
  }
  throw error;
}


/**
 * `TransitionRefusal`, in the salon's words. Partial on purpose: only the
 * refusals a RESCHEDULE can actually produce are worded, and anything else
 * falls through to the status-naming default rather than being invented here.
 *
 * The two that matter are the ones the desk will hit. A finished or cancelled
 * appointment is `not-permitted` — nothing to move. Checked-in and in-progress
 * are also `not-permitted` (they are absent from the transition table), and
 * the fallback names the status, which is the fact the desk needs.
 */
const REFUSALS: Partial<Record<TransitionRefusal, string>> = {
  'not-permitted': 'This one cannot be moved — start a new appointment instead.',
  'actor-not-permitted': 'This one cannot be moved from here.',
  'inside-cancellation-cutoff': 'Too close for the client to move it herself — but you can.',
};
