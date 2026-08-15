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

/**
 * Deactivate or reactivate.
 *
 * Writes `Provider.active` and nothing else. The AVAIL-05 impact preview — the
 * list of stranded appointments with client phone numbers — is A-019; no
 * appointment can exist until A-009, so a preview here would be untested
 * against an empty set (operator S-2).
 */
export async function toggleProviderActive(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireStaff();
  const id = String(formData.get('providerId') ?? '');
  const active = String(formData.get('active')) === 'true';
  await setProviderActive(prisma, id, active);
  revalidatePath('/staff/providers');
  return { ok: true };
}
