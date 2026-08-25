'use server';

/**
 * A-055 — CHANGING WHAT SHE IS HAVING, FROM THE DESK (VISIT-01, D-18, D-23).
 *
 * The operator review at the Phase 5 close called this the biggest hole in the
 * product: "the one thing a booked appointment cannot do in this system is
 * become a different appointment." Every workaround the desk had was wrong —
 * cancel-and-rebook writes `cancelled_late` on a client sitting in the chair,
 * a second adjacent appointment is refused by the exclusion constraint the
 * moment the buffers meet, and an override trains everyone to ignore the
 * marker D-8 rests on.
 *
 * STAFF ONLY, and unrestricted the same way booking and moving are (A-017,
 * A-033): `audience: 'staff'` lifts the horizon (D-21) and the lead time
 * (D-25). There is no customer equivalent and there must not be one — "add a
 * colour to the appointment I already have" is a conversation, not a form.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import { VisitAlreadyChanged, VisitNotEditable, changeVisitServices } from '@bookable/db/appointments';
import { BookingRejected, NoResourceFree, SlotNotOffered, SlotTaken } from '@bookable/db/booking';
import { staffActor } from '@bookable/core/auth';
import { requireStaff } from '@/lib/auth/session';
import { readableReason } from '@/lib/scheduling-words';

export interface VisitState {
  ok?: boolean;
  message?: string;
  /** True when the ENGINE refused — so the panel can offer BOOK-05's override,
   *  exactly as the booking panel does. Separate from `reasons` because that
   *  list can legitimately be empty (a time outside every window is never a
   *  candidate at all). */
  canOverride?: boolean;
  reasons?: string[];
}

export async function changeServices(_previous: VisitState, formData: FormData): Promise<VisitState> {
  const staff = await requireStaff();
  const appointmentId = String(formData.get('appointmentId') ?? '');
  // ORDER IS THE APPOINTMENT (VISIT-01): `getAll` preserves the order the
  // panel posted, which is the order the desk chose, which decides which
  // buffers land on the ends.
  const serviceIds = formData.getAll('serviceIds').map(String).filter(Boolean);
  const isOverride = formData.get('isOverride') === 'on';
  const overrideReason = String(formData.get('overrideReason') ?? '');
  const reason = String(formData.get('reason') ?? '');

  if (serviceIds.length === 0) return { ok: false, message: 'She has to be having something.' };

  try {
    const changed = await changeVisitServices(prisma, {
      appointmentId,
      serviceIds,
      now: new Date(),
      actor: staffActor(staff.id),
      audience: 'staff',
      isOverride,
      overrideReason: isOverride ? overrideReason : null,
      reason: reason || null,
    });

    revalidatePath(`/staff/appointments/${appointmentId}`);
    revalidatePath('/staff/day');
    revalidatePath('/staff/opened');

    return { ok: true, message: sentenceFor(changed) };
  } catch (error) {
    // The engine's refusals, in the same words the booking panel uses — one
    // vocabulary for one cause, wherever it happens.
    if (error instanceof SlotTaken) {
      return {
        ok: false,
        message: 'That would run into her next client.',
        canOverride: true,
        reasons: error.reasons.length > 0 ? [...error.reasons] : ['overlaps-booking'],
      };
    }
    if (error instanceof SlotNotOffered) {
      return {
        ok: false,
        message: 'That would not fit.',
        canOverride: true,
        reasons: [...error.reasons],
      };
    }
    if (error instanceof NoResourceFree) {
      return { ok: false, message: 'That would not fit.', canOverride: true, reasons: ['no-resource-free'] };
    }
    // Not engine refusals, and deliberately NOT offered an override: no amount
    // of authority makes a finished appointment editable, and a stylist who
    // cannot do the service is a reschedule-with-provider, not an override.
    if (error instanceof VisitNotEditable) return { ok: false, message: error.message };
    if (error instanceof VisitAlreadyChanged) {
      return { ok: false, message: 'Somebody else changed this one first. Have another look.' };
    }
    if (error instanceof BookingRejected) return { ok: false, message: error.message };
    throw error;
  }
}

/** What the desk reads back — what changed and when she is out, because that
 *  is the sentence she is waiting to be told. */
function sentenceFor(changed: {
  added: string[];
  removed: string[];
  freedMinutes: number;
}): string {
  const parts: string[] = [];
  if (changed.added.length > 0) parts.push(`Added ${changed.added.join(' and ')}`);
  if (changed.removed.length > 0) parts.push(`took off ${changed.removed.join(' and ')}`);
  const what = parts.length > 0 ? `${parts.join(', ')}.` : 'Changed the order.';
  return changed.freedMinutes > 0 ? `${what} ${changed.freedMinutes} minutes back on the book.` : what;
}

/** The engine's words for the panel, so a refusal here reads exactly as the
 *  same refusal reads on the booking screen. */
export async function readableRefusal(reasons: string[]): Promise<string> {
  return reasons.length > 0
    ? `${reasons.map(readableReason).join('; ')}.`
    : 'That time is outside her working hours.';
}
