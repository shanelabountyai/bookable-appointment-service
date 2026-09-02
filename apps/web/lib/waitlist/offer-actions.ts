'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import { type CallMarkOutcome, clearCallMark, recordCallMark } from '@bookable/db/clients';
import { staffActor } from '@bookable/core/auth';
import { requireStaff } from '@/lib/auth/session';

/**
 * A-072 — "we have already offered this one to her" (WAIT-02).
 *
 * The same shape as A-061's call-down attempt, deliberately rather than a
 * third invention: the outcome comes off the pressed BUTTON's own value, so
 * the four are one form and one action; anything unrecognised clears the mark,
 * which is how the undo arrives without a second server action for a
 * one-row delete.
 *
 * IT SENDS NOTHING. Not a message, not an outbox row, not a hold on the slot.
 * D-41's reasoning applies unchanged: this is a note about a phone call a
 * human made, and the moment it starts sending anything it becomes OQ-4's
 * soft-hold offer, which is correctly still blocked.
 */
export interface OfferState {
  ok?: boolean;
  message?: string;
}

const OUTCOMES = ['no_answer', 'left_message', 'thinking', 'took_it'] as const;

export async function recordOffer(_previous: OfferState, formData: FormData): Promise<OfferState> {
  const staff = await requireStaff();
  const subject = String(formData.get('subject') ?? '');
  const appointmentId = String(formData.get('appointmentId') ?? '');
  const clientId = String(formData.get('clientId') ?? '');
  const outcome = String(formData.get('outcome') ?? '');

  if (!subject || !clientId) return { ok: false, message: 'That slot is no longer on the screen. Reload.' };

  if (outcome === 'clear') {
    await clearCallMark(prisma, { businessId: staff.businessId, subject, clientId });
    revalidatePath('/staff/waitlist');
    revalidatePath('/staff/opened');
    // A-073 reuses this action for the lapsed list, so it revalidates there
    // too — one writer, and every reader of it told.
    revalidatePath('/staff/dashboard/lapsed');
    return { ok: true, message: 'Cleared — she has not been asked.' };
  }

  if (!(OUTCOMES as readonly string[]).includes(outcome)) {
    return { ok: false, message: 'That is not one of the four.' };
  }

  const mark = await recordCallMark(prisma, {
    businessId: staff.businessId,
    subject,
    appointmentId,
    clientId,
    outcome: outcome as CallMarkOutcome,
    actor: staffActor(staff.id),
  });

  revalidatePath('/staff/waitlist');
  // A-067's list carries the summary, so the OTHER screen has to re-render —
  // the whole defect is two people at one desk reading two different pictures
  // of the same round of phone calls.
  revalidatePath('/staff/opened');
  revalidatePath('/staff/dashboard/lapsed');

  return mark
    ? { ok: true, message: 'Noted.' }
    : { ok: false, message: 'That client or appointment is no longer here. Reload.' };
}
