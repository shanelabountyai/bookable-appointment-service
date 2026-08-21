'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import {
  PolicyRejected,
  ProviderRejected,
  createProvider,
  setProviderActive,
  updateBusinessSettings,
  updateProvider,
} from '@bookable/db/settings';
import { type ConflictRow, listDeactivationImpact } from '@/lib/availability/impact-actions';
import { requireStaff } from '@/lib/auth/session';

export interface FormState {
  ok?: boolean;
  /** Keyed by field so the form can put the message next to the input that
   *  caused it — a policy error naming "Colour" is useless floating at the top
   *  of a page with eleven fields. */
  errors?: Record<string, string>;
  message?: string;
}

const toInt = (v: FormDataEntryValue | null): number => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : Number.NaN;
};

/**
 * Save business policy.
 *
 * `requireStaff()` first, in every one of these — a settings mutation reachable
 * without a session is the "the day view is publicly reachable" failure D-9
 * exists to prevent.
 */
export async function saveBusinessSettings(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();

  try {
    await updateBusinessSettings(prisma, staff.businessId, {
      name: String(formData.get('name') ?? ''),
      timezone: String(formData.get('timezone') ?? ''),
      slotIntervalMinutes: toInt(formData.get('slotIntervalMinutes')),
      minimumLeadMinutes: toInt(formData.get('minimumLeadMinutes')),
      cancellationCutoffMinutes: toInt(formData.get('cancellationCutoffMinutes')),
      noShowBlockThreshold: toInt(formData.get('noShowBlockThreshold')),
      bookingHorizonDays: toInt(formData.get('bookingHorizonDays')),
      bufferMayOverlapBreak: formData.get('bufferMayOverlapBreak') === 'on',
      bufferMayExtendPastClose: formData.get('bufferMayExtendPastClose') === 'on',
      ambiguousLocalTime:
        String(formData.get('ambiguousLocalTime')) === 'offer-earlier-only' ? 'offer-earlier-only' : 'offer-both',
    });
  } catch (error) {
    if (error instanceof PolicyRejected) {
      const errors: Record<string, string> = {};
      for (const v of error.violations) errors[v.field] = v.message;
      return { errors };
    }
    throw error;
  }

  revalidatePath('/staff/settings');
  return { ok: true, message: 'Settings saved.' };
}

export async function addProvider(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  try {
    await createProvider(prisma, staff.businessId, { displayName: String(formData.get('displayName') ?? '') });
  } catch (error) {
    if (error instanceof ProviderRejected) return { errors: { [error.field]: error.message } };
    throw error;
  }
  revalidatePath('/staff/providers');
  return { ok: true, message: 'Provider added.' };
}

export async function renameProvider(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireStaff();
  const id = String(formData.get('providerId') ?? '');
  try {
    await updateProvider(prisma, id, { displayName: String(formData.get('displayName') ?? '') });
  } catch (error) {
    if (error instanceof ProviderRejected) return { errors: { [error.field]: error.message } };
    throw error;
  }
  revalidatePath('/staff/providers');
  return { ok: true };
}

/** `toggleProviderActive`'s richer return — AVAIL-05, operator P-8: a
 *  deactivation with a book full of appointments used to warn nobody. */
export interface ProviderToggleState extends FormState {
  stranded?: ConflictRow[];
}

/**
 * Deactivate or reactivate.
 *
 * A DEACTIVATION with future appointments is a two-step confirm, the same
 * shape SVC-03 already uses for a service (`DeactivationRequiresConfirm`) —
 * except this one shows the actual list `listDeactivationImpact` (A-019)
 * already builds, not just a count, because "40 appointments" and "40
 * appointments, here they are with phone numbers" are different amounts of
 * useful. A reactivation, or a deactivation with nothing booked, writes
 * straight through — there is nothing to confirm.
 */
export async function toggleProviderActive(
  _prev: ProviderToggleState,
  formData: FormData,
): Promise<ProviderToggleState> {
  await requireStaff();
  const id = String(formData.get('providerId') ?? '');
  const active = String(formData.get('active')) === 'true';
  const confirm = formData.get('confirm') === 'true';

  if (!active && !confirm) {
    const stranded = await listDeactivationImpact(id);
    if (stranded.length > 0) {
      return {
        errors: {
          _confirm: `${stranded.length} future appointment${stranded.length === 1 ? '' : 's'} ${stranded.length === 1 ? 'is' : 'are'} booked with her.`,
        },
        stranded,
      };
    }
  }

  await setProviderActive(prisma, id, active);
  revalidatePath('/staff/providers');
  return { ok: true };
}
