'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import {
  type CallAttemptOutcome,
  type UnconfirmedAppointment,
  clearCallAttempt,
  listUnconfirmedTomorrow,
  recordCallAttempt,
} from '@bookable/db/appointments';
import { staffActor } from '@bookable/core/auth';
import { requireStaff } from '@/lib/auth/session';

/** A-021's call-down list, scoped to the signed-in staff member's business. */
export async function listCallDown(tomorrow: string): Promise<UnconfirmedAppointment[]> {
  const staff = await requireStaff();
  return listUnconfirmedTomorrow(prisma, { businessId: staff.businessId, tomorrow });
}

export interface AttemptState {
  ok?: boolean;
  message?: string;
}

/**
 * A-061 — "tried, no answer" / "left a message".
 *
 * The outcome comes off the pressed BUTTON's own value, so the two are one
 * form and one action rather than two of each. Anything that is not one of
 * the two known outcomes clears the mark instead, which is how the undo
 * arrives without a third server action for a one-column delete.
 */
export async function recordAttempt(_previous: AttemptState, formData: FormData): Promise<AttemptState> {
  const staff = await requireStaff();
  const appointmentId = String(formData.get('appointmentId') ?? '');
  const outcome = String(formData.get('outcome') ?? '');

  if (outcome === 'clear') {
    await clearCallAttempt(prisma, { businessId: staff.businessId, appointmentId });
    revalidatePath('/staff/call-down');
    return { ok: true, message: 'Cleared — she is back on the list.' };
  }

  if (outcome !== 'no_answer' && outcome !== 'left_message') {
    return { ok: false, message: 'That is not one of the two.' };
  }

  const attempt = await recordCallAttempt(prisma, {
    businessId: staff.businessId,
    appointmentId,
    outcome: outcome as CallAttemptOutcome,
    actor: staffActor(staff.id),
  });

  revalidatePath('/staff/call-down');
  // Null means she left `booked` while the desk was dialling — she confirmed
  // through her own link, most likely, which is good news phrased as a
  // refusal rather than an error.
  return attempt
    ? { ok: true, message: 'Noted.' }
    : { ok: false, message: 'She is no longer on this list — reload to see where she went.' };
}
