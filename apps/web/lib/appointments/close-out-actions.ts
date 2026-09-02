'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import { AppointmentMovedFirst, TransitionRefused, transitionAppointment } from '@bookable/db/appointments';
import { SlotTaken } from '@bookable/db/booking';
import { staffActor } from '@bookable/core/auth';
import { requireStaff } from '@/lib/auth/session';

/**
 * A-076 / D-46 — CLOSING OUT WHAT NOBODY CLOSED (APPT-01, APPT-03).
 *
 * Two answers, because two answers are all that apply at six o'clock: *she
 * came* and *she didn't*. Both go through A-012's `transitionAppointment`, so
 * the §7 table decides and nothing here holds an opinion — a second
 * `if (status === …)` on a screen is the rental `VERIFIED` defect starting
 * over.
 *
 * NOTHING IS DERIVED (D-46). The desk says which; the software never infers
 * attendance from silence, because the silence is identical whether she came
 * and nobody tapped or she never came and nobody tapped, and those two have
 * opposite consequences for her twelve-month record.
 */
export interface CloseOutState {
  ok?: boolean;
  message?: string;
}

export async function closeOut(_previous: CloseOutState, formData: FormData): Promise<CloseOutState> {
  const staff = await requireStaff();
  const appointmentId = String(formData.get('appointmentId') ?? '');
  const came = String(formData.get('came') ?? '');

  if (came !== 'yes' && came !== 'no') return { ok: false, message: 'Say whether she came.' };

  try {
    await transitionAppointment(prisma, {
      appointmentId,
      to: came === 'yes' ? 'completed' : 'no_show',
      actor: staffActor(staff.id),
      now: new Date(),
      // `now` is Monday morning and the appointment was Saturday; the write
      // path knows not to stamp an arrival time it cannot know (D-46).
    });
  } catch (error) {
    if (error instanceof AppointmentMovedFirst) {
      return { ok: false, message: `Somebody else got there first — it is ${error.actual.replace('_', ' ')} now.` };
    }
    if (error instanceof TransitionRefused) {
      return { ok: false, message: 'That one cannot be closed from here — open it and see what happened.' };
    }
    if (error instanceof SlotTaken) {
      return { ok: false, message: 'Her time has been sold to somebody else, so that cannot go back on the book.' };
    }
    throw error;
  }

  revalidatePath('/staff/unfinished');
  revalidatePath('/staff/day');
  // The three readers the whole item exists for: utilization, the lapsed
  // round, and her twelve-month record.
  revalidatePath('/staff/dashboard');
  revalidatePath('/staff/dashboard/lapsed');

  return { ok: true, message: came === 'yes' ? 'Closed.' : 'Marked as a no-show.' };
}
