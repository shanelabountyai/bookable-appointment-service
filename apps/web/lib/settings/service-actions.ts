'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import {
  DeactivationRequiresConfirm,
  ServiceRejected,
  createService,
  qualifyProvider,
  setServiceActive,
  unqualifyProvider,
  updateService,
} from '@bookable/db/settings';
import { requireStaff } from '@/lib/auth/session';
export type { FormState } from './actions';
import type { FormState } from './actions';

const toInt = (v: FormDataEntryValue | null): number => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : Number.NaN;
};

const toNullableInt = (v: FormDataEntryValue | null): number | null => {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
};

function serviceInputFrom(formData: FormData) {
  return {
    name: String(formData.get('name') ?? ''),
    durationMinutes: toInt(formData.get('durationMinutes')),
    bufferBeforeMinutes: toInt(formData.get('bufferBeforeMinutes')),
    bufferAfterMinutes: toInt(formData.get('bufferAfterMinutes')),
    priceCents: toInt(formData.get('priceCents')),
    cancellationCutoffMinutes: toNullableInt(formData.get('cancellationCutoffMinutes')),
  };
}

export async function addService(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  try {
    await createService(prisma, staff.businessId, serviceInputFrom(formData));
  } catch (error) {
    if (error instanceof ServiceRejected) return { errors: { [error.field]: error.message } };
    throw error;
  }
  revalidatePath('/staff/services');
  return { ok: true, message: 'Service added.' };
}

export async function editService(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const serviceId = String(formData.get('serviceId') ?? '');
  try {
    await updateService(prisma, staff.businessId, serviceId, serviceInputFrom(formData));
  } catch (error) {
    if (error instanceof ServiceRejected) return { errors: { [error.field]: error.message } };
    throw error;
  }
  revalidatePath('/staff/services');
  return { ok: true, message: 'Service updated.' };
}

/**
 * Deactivate/reactivate (SVC-03). A first attempt with `confirm` unset is
 * refused when future appointments exist; the form resubmits with
 * `confirm=true` once the staff member has seen the count. Nothing can
 * produce that count before A-009, so this path is untested by e2e today —
 * the mechanism is built and unit-tested (packages/db/settings/services.test.ts)
 * so A-009 inherits a working gate rather than an untested one.
 */
export async function toggleServiceActive(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireStaff();
  const serviceId = String(formData.get('serviceId') ?? '');
  const active = String(formData.get('active')) === 'true';
  const confirm = String(formData.get('confirm')) === 'true';
  try {
    await setServiceActive(prisma, serviceId, active, new Date(), confirm);
  } catch (error) {
    if (error instanceof DeactivationRequiresConfirm) {
      return { errors: { _confirm: error.message } };
    }
    throw error;
  }
  revalidatePath('/staff/services');
  return { ok: true };
}

export async function toggleQualification(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const serviceId = String(formData.get('serviceId') ?? '');
  const providerId = String(formData.get('providerId') ?? '');
  const qualified = String(formData.get('qualified')) === 'true';

  if (qualified) {
    const durationOverrideMinutes = toNullableInt(formData.get('durationOverrideMinutes'));
    const priceOverrideCents = toNullableInt(formData.get('priceOverrideCents'));
    try {
      await qualifyProvider(prisma, staff.businessId, serviceId, providerId, {
        durationOverrideMinutes,
        priceOverrideCents,
      });
    } catch (error) {
      if (error instanceof ServiceRejected) return { errors: { [error.field]: error.message } };
      throw error;
    }
  } else {
    const confirm = String(formData.get('confirm')) === 'true';
    try {
      await unqualifyProvider(prisma, serviceId, providerId, new Date(), confirm);
    } catch (error) {
      if (error instanceof DeactivationRequiresConfirm) return { errors: { _confirm: error.message } };
      throw error;
    }
  }
  revalidatePath('/staff/services');
  return { ok: true };
}
