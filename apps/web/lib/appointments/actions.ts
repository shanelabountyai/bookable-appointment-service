'use server';

/**
 * A-027's staff actions — the status controls (APPT-01, APPT-06) and the
 * per-visit note (CLIENT-03).
 *
 * Every status change goes through A-012's `transitionAppointment`, which asks
 * the §7 table. Nothing here decides whether a move is legal: a second
 * `if (status === ...)` on a screen is the rental `VERIFIED` defect starting
 * over, and it starts silently.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import {
  AppointmentMovedFirst,
  NotReleasable,
  TransitionRefused,
  releaseNoShowTime,
  setAppointmentNotes,
  transitionAppointment,
} from '@bookable/db/appointments';
import { SlotTaken } from '@bookable/db/booking';
import type { AppointmentStatus } from '@bookable/core/scheduling';
import { staffActor } from '@bookable/core/auth';
import { requireStaff } from '@/lib/auth/session';

export interface DetailState {
  ok?: boolean;
  message?: string;
}

export async function changeStatus(_previous: DetailState, formData: FormData): Promise<DetailState> {
  const staff = await requireStaff();
  const appointmentId = String(formData.get('appointmentId') ?? '');
  const to = String(formData.get('to') ?? '') as AppointmentStatus;
  const expectedFrom = String(formData.get('expectedFrom') ?? '') as AppointmentStatus;
  const reason = String(formData.get('reason') ?? '');
  // A-060. The one Cancel button posts an INTENT, never a status: `derive`
  // lets the cutoff decide, `override` is the desk deliberately letting one
  // off. `to` is absent on both, so this surface cannot classify a
  // cancellation even by accident.
  const cancel = formData.get('cancel');
  const cancellation = cancel === 'derive' || cancel === 'override' ? cancel : undefined;

  try {
    await transitionAppointment(prisma, {
      appointmentId,
      to: cancellation ? 'cancelled' : to,
      cancellation,
      actor: staffActor(staff.id),
      now: new Date(),
      reason,
      // The screen showed a status, so it says which one — turning "the button
      // did nothing surprising" into an explicit answer when somebody else got
      // there first.
      expectedFrom: expectedFrom || undefined,
    });
  } catch (error) {
    if (error instanceof AppointmentMovedFirst) {
      return {
        ok: false,
        message: `Somebody else got there first — it is ${error.actual.replace('_', ' ')} now. Reload to see it.`,
      };
    }
    if (error instanceof TransitionRefused) return { ok: false, message: refusalWording(error) };
    throw error;
  }

  revalidatePath(`/staff/appointments/${appointmentId}`);
  revalidatePath('/staff/day');
  revalidatePath('/staff/call-down');
  return { ok: true, message: 'Done, and recorded.' };
}

/**
 * A-069 / D-44 — GIVING A NO-SHOW'S DEAD TIME BACK (APPT-03, BOOK-05).
 *
 * Beside the status controls rather than on a screen of its own, because the
 * moment the desk marks the no-show is the only moment anybody is thinking
 * about that slot. A screen away is a screen nobody opens, which is the same
 * finding A-043 was built on.
 *
 * NEVER AUTOMATIC (D-44). The instant is `now` because the desk pressed the
 * button now — not a rule that releases at N minutes past, which would resell
 * a slot to a client stuck in traffic eight minutes away.
 */
export async function releaseTime(_previous: DetailState, formData: FormData): Promise<DetailState> {
  const staff = await requireStaff();
  const appointmentId = String(formData.get('appointmentId') ?? '');
  const reason = String(formData.get('reason') ?? '');

  try {
    const released = await releaseNoShowTime(prisma, {
      businessId: staff.businessId,
      appointmentId,
      releasedAt: new Date(),
      actor: staffActor(staff.id),
      reason: reason || null,
    });

    revalidatePath(`/staff/appointments/${appointmentId}`);
    revalidatePath('/staff/day');
    // A-067's list is where the freed span gets sold — the waitlist match and
    // the walk-in door both read it.
    revalidatePath('/staff/opened');

    return { ok: true, message: `${released.minutes} min back on the market. It is on What's opened up.` };
  } catch (error) {
    if (error instanceof NotReleasable) return { ok: false, message: error.message };
    // Only reachable through the correction path, but the vocabulary is shared
    // on purpose — one cause, one sentence, wherever it surfaces.
    if (error instanceof SlotTaken) return { ok: false, message: 'Somebody has already taken that time.' };
    throw error;
  }
}

export async function saveVisitNote(_previous: DetailState, formData: FormData): Promise<DetailState> {
  const staff = await requireStaff();
  const appointmentId = String(formData.get('appointmentId') ?? '');

  await setAppointmentNotes(prisma, {
    businessId: staff.businessId,
    appointmentId,
    notes: String(formData.get('notes') ?? ''),
  });

  revalidatePath(`/staff/appointments/${appointmentId}`);
  // A-070. The note is now written from the stylist's own list and READ on the
  // chip, in her list and on the printed sheet — so the day has to re-render,
  // or the note she just typed is invisible on the screen she typed it from.
  revalidatePath('/staff/day');
  return { ok: true, message: 'Note saved.' };
}

/** The machine-readable refusal, in the words the front desk uses. */
function refusalWording(error: TransitionRefused): string {
  switch (error.refusal) {
    case 'reason-required':
      return 'That one needs a reason — it is the only record of why.';
    case 'inside-cancellation-cutoff':
    case 'outside-cancellation-cutoff':
      return 'The cutoff moved while this screen was open. Reload and try again.';
    case 'before-appointment-start':
      return 'She cannot be a no-show before her appointment has started.';
    case 'correction-window-closed':
      return 'Too long ago to correct — that window is seven days.';
    case 'actor-not-permitted':
      return 'That is not something the front desk can do.';
    case 'same-status':
      return 'It is already that.';
    default:
      return `That move is not allowed from ${error.from.replace('_', ' ')}.`;
  }
}
