'use server';

import { revalidatePath } from 'next/cache';
import { InvalidAvailability } from '@bookable/core/availability';
import { instantFromIso, toDate } from '@bookable/core/time';
import { prisma } from '@bookable/db';
import {
  type ActorStamp,
  createAdHocBlock,
  createTimeOff,
  createWeeklyWindow,
  deleteDateOverride,
  deleteTimeOff,
  deleteWeeklyWindow,
  upsertDateOverride,
} from '@bookable/db/availability';
import { requireStaff } from '@/lib/auth/session';
import type { FormState } from './actions';

export type { FormState } from './actions';

/** Every availability write is stamped with who made it (operator R-8). */
async function actorStamp(): Promise<{ businessId: string; actor: ActorStamp }> {
  const staff = await requireStaff();
  return { businessId: staff.businessId, actor: { createdByActor: 'staff', actorRef: staff.id } };
}

const str = (fd: FormData, key: string): string => String(fd.get(key) ?? '').trim();

function handle(error: unknown): FormState {
  if (error instanceof InvalidAvailability) return { errors: { [error.field]: error.message } };
  throw error;
}

export async function addWeeklyWindow(_prev: FormState, formData: FormData): Promise<FormState> {
  const { businessId, actor } = await actorStamp();
  const providerId = str(formData, 'providerId');
  const breakOpen = str(formData, 'breakOpen');
  const breakClose = str(formData, 'breakClose');

  try {
    await createWeeklyWindow(
      prisma,
      {
        businessId,
        // An empty providerId means the BUSINESS-level pattern (AVAIL-04).
        providerId: providerId === '' ? null : providerId,
        weekday: Number(str(formData, 'weekday')),
        open: str(formData, 'open'),
        close: str(formData, 'close'),
        endsNextDay: formData.get('endsNextDay') === 'on',
        ...(breakOpen && breakClose ? { breaks: [{ open: breakOpen, close: breakClose }] } : {}),
      },
      actor,
    );
  } catch (error) {
    return handle(error);
  }
  revalidatePath('/staff/availability');
  return { ok: true, message: 'Hours added.' };
}

export async function removeWeeklyWindow(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireStaff();
  await deleteWeeklyWindow(prisma, str(formData, 'windowId'));
  revalidatePath('/staff/availability');
  return { ok: true };
}

export async function saveDateOverride(_prev: FormState, formData: FormData): Promise<FormState> {
  const { businessId, actor } = await actorStamp();
  const providerId = str(formData, 'providerId');
  const isClosed = formData.get('isClosed') === 'on';
  const open = str(formData, 'open');
  const close = str(formData, 'close');

  try {
    await upsertDateOverride(
      prisma,
      {
        businessId,
        providerId: providerId === '' ? null : providerId,
        day: str(formData, 'day'),
        isClosed,
        reason: str(formData, 'reason') || null,
        ...(isClosed ? {} : { windows: [{ open, close, endsNextDay: false }] }),
      },
      actor,
    );
  } catch (error) {
    return handle(error);
  }
  revalidatePath('/staff/availability');
  return { ok: true, message: 'Override saved.' };
}

export async function removeDateOverride(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireStaff();
  await deleteDateOverride(prisma, str(formData, 'overrideId'));
  revalidatePath('/staff/availability');
  return { ok: true };
}

/**
 * Time off / ad-hoc block.
 *
 * Takes offset-bearing ISO instants, not `{date, time}` (D-4): a wall-clock
 * pair is undecidable on fall-back day, and this is a payload crossing a
 * form boundary — exactly where that rule bites.
 *
 * Deliberately does NOT check for appointments it covers (D-2/AVAIL-03).
 * "Dana called in sick" must always succeed; surfacing the nine appointments
 * it stranded is A-019's impact preview, not a refusal here.
 */
export async function addAbsence(_prev: FormState, formData: FormData): Promise<FormState> {
  const { businessId, actor } = await actorStamp();
  const providerId = str(formData, 'providerId');
  const kind = str(formData, 'kind');

  let startAt: Date;
  let endAt: Date;
  try {
    startAt = toDate(instantFromIso(str(formData, 'startAt')));
    endAt = toDate(instantFromIso(str(formData, 'endAt')));
  } catch {
    return { errors: { startAt: 'Give a start and end with an explicit timezone offset.' } };
  }

  const input = { businessId, providerId, startAt, endAt, reason: str(formData, 'reason') || null };
  try {
    if (kind === 'ad_hoc_block') await createAdHocBlock(prisma, input, actor);
    else await createTimeOff(prisma, input, actor);
  } catch (error) {
    return handle(error);
  }
  revalidatePath('/staff/availability');
  return { ok: true, message: kind === 'ad_hoc_block' ? 'Block added.' : 'Time off added.' };
}

export async function removeTimeOff(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireStaff();
  await deleteTimeOff(prisma, str(formData, 'timeOffId'));
  revalidatePath('/staff/availability');
  return { ok: true };
}
