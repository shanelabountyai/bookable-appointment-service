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
  TransitionRefused,
  setAppointmentNotes,
  transitionAppointment,
} from '@bookable/db/appointments';
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

  try {
    await transitionAppointment(prisma, {
      appointmentId,
      to,
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

export async function saveVisitNote(_previous: DetailState, formData: FormData): Promise<DetailState> {
  const staff = await requireStaff();
  const appointmentId = String(formData.get('appointmentId') ?? '');

  await setAppointmentNotes(prisma, {
    businessId: staff.businessId,
    appointmentId,
    notes: String(formData.get('notes') ?? ''),
  });

  revalidatePath(`/staff/appointments/${appointmentId}`);
  return { ok: true, message: 'Note saved.' };
}

/** The machine-readable refusal, in the words the front desk uses. */
function refusalWording(error: TransitionRefused): string {
  switch (error.refusal) {
    case 'reason-required':
      return 'That one needs a reason — it is the only record of why.';
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
