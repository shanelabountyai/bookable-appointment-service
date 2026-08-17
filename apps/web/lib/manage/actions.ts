'use server';

/**
 * What the manage link GRANTS (TOKEN-01): cancel, and nothing else.
 *
 * Confirm is A-021's loop and reschedule is A-014's same-row update; both come
 * through the same gate when they land. Cancel is here because A-012 already
 * built the decision — this file resolves a token to an appointment and asks
 * the state machine, and there is no third thing it could do.
 *
 * D-10 applies to every string returned: "appointment", "cancel". No status
 * enum, no entity name, no internal identifier — including in the failure
 * wording, where a leaked `cancelled_late` would be the exact tell TOKEN-03
 * forbids.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import { TransitionRefused, transitionAppointment } from '@bookable/db/appointments';
import { customerTokenActor } from '@bookable/core/auth';
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
