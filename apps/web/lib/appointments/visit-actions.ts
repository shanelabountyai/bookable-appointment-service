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
import {
  ClientAlreadyChanged,
  ClientNotAttachable,
  VisitAlreadyChanged,
  VisitNotEditable,
  changeVisitServices,
  setAppointmentClient,
} from '@bookable/db/appointments';
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

/**
 * A-068 — WHO WAS THIS? (BOOK-04, CLIENT-01, D-17.)
 *
 * The same file as the service change because it is the same kind of action: a
 * correction to a live appointment made at the desk, staff-only, with no
 * customer equivalent and no message to anybody. `schema.prisma` has promised
 * this door since the beginning — the client column is nullable so a walk-in
 * can be booked as nothing but a time, "identity attached later" — and until
 * now the only writer of `clientId` after creation was the client merge.
 */
export interface ClientState {
  ok?: boolean;
  message?: string;
}

export async function setAppointmentClientAction(
  _previous: ClientState,
  formData: FormData,
): Promise<ClientState> {
  const staff = await requireStaff();
  const appointmentId = String(formData.get('appointmentId') ?? '');
  // The detach button carries its own field. An empty `clientId` means the
  // picker holds nobody yet, which is not the same sentence as "this wasn't
  // her" — and the panel's submit is disabled in that state precisely so the
  // two cannot be confused.
  const clientId = formData.get('detach') ? null : String(formData.get('clientId') ?? '').trim() || null;
  const reason = String(formData.get('reason') ?? '');

  try {
    const changed = await setAppointmentClient(prisma, {
      businessId: staff.businessId,
      appointmentId,
      clientId,
      actor: staffActor(staff.id),
      reason: reason || null,
    });

    revalidatePath(`/staff/appointments/${appointmentId}`);
    revalidatePath('/staff/day');
    // A-067's list carries the client's NAME and the tel: link the desk rings
    // — naming a cancelled walk-in is exactly what turns one of those rows
    // from a dead end into a phone call. "A state change is never one edit."
    revalidatePath('/staff/opened');
    // Her record is what the correction was FOR: the twelve-month count, the
    // history, and — on a detach — the count this takes back off somebody.
    for (const id of [changed.from?.id, changed.to?.id]) {
      if (id) revalidatePath(`/staff/clients/${id}`);
    }

    const name = (who: { name: string | null } | null) => who?.name ?? 'a client with no name';
    if (changed.kind === 'attached') return { ok: true, message: `Recorded as ${name(changed.to)}.` };
    if (changed.kind === 'detached') return { ok: true, message: `Taken off ${name(changed.from)}.` };
    return { ok: true, message: `Moved from ${name(changed.from)} to ${name(changed.to)}.` };
  } catch (error) {
    if (error instanceof ClientNotAttachable) return { ok: false, message: error.message };
    if (error instanceof ClientAlreadyChanged) return { ok: false, message: error.message };
    // A-063's chair, and the one arm of this that a human has to act on:
    // taking her off a visit splits a chair she was legally sharing with her
    // own next appointment, and there is no second one free.
    if (error instanceof NoResourceFree) {
      return {
        ok: false,
        message: `${error.message} She is sharing a chair with her own other appointment, and taking this one off her record would need two. Move one of them first.`,
      };
    }
    throw error;
  }
}
