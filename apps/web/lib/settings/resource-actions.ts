'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import {
  ResourceRejected,
  countFutureHolds,
  createResource,
  createResourceType,
  setResourceActive,
} from '@bookable/db/settings';
import { requireStaff } from '@/lib/auth/session';
import type { FormState } from './actions';

/**
 * A-046 — the writes behind `/staff/resources` (RES-01, D-30).
 *
 * `requireStaff()` first in every one, like every other settings mutation:
 * the room's capacity decides what the public booking flow is offered, so an
 * unauthenticated writer here could close the salon.
 */

/** `retireResource`'s richer return — the same two-step confirm shape the
 *  provider and service deactivations already use, because taking a chair out
 *  of service with clients already in it is the identical decision. */
export interface ResourceToggleState extends FormState {
  confirmHolds?: number;
}

export async function addResourceType(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  try {
    await createResourceType(prisma, staff.businessId, { name: String(formData.get('typeName') ?? '') });
  } catch (error) {
    if (error instanceof ResourceRejected) return { errors: { [error.field]: error.message } };
    throw error;
  }
  revalidatePath('/staff/resources');
  return { ok: true, message: 'Resource type added.' };
}

export async function addResource(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  try {
    await createResource(prisma, staff.businessId, {
      resourceTypeId: String(formData.get('resourceTypeId') ?? ''),
      name: String(formData.get('resourceName') ?? ''),
    });
  } catch (error) {
    if (error instanceof ResourceRejected) return { errors: { [error.field]: error.message } };
    throw error;
  }
  // The day grid renders the room, and the engine's capacity changed — both
  // are stale the instant a chair is added.
  revalidatePath('/staff/resources');
  revalidatePath('/staff/day');
  return { ok: true, message: 'Added.' };
}

/**
 * Take a resource out of service, or put it back.
 *
 * A retirement with clients still in that chair is confirmed rather than
 * refused: the salon that loses a chair to a burst pipe on a Saturday has to
 * be able to say so with nine people booked into it, and D-2's "nothing may
 * refuse" applies to the room exactly as it applies to a stylist's hours. What
 * it must not do is happen SILENTLY — the count is the whole point of the
 * step. The holds themselves are left alone; `findRoomFullIntervals` stops
 * counting the chair for capacity, so the room shrinks from now on and the
 * clients already seated keep their seats.
 */
export async function toggleResourceActive(
  _prev: ResourceToggleState,
  formData: FormData,
): Promise<ResourceToggleState> {
  await requireStaff();
  const resourceId = String(formData.get('resourceId') ?? '');
  const active = String(formData.get('active')) === 'true';
  const confirm = formData.get('confirm') === 'true';

  if (!active && !confirm) {
    const holds = await countFutureHolds(prisma, resourceId, new Date());
    if (holds > 0) {
      return {
        errors: {
          _confirm: `${holds} appointment${holds === 1 ? ' is' : 's are'} still booked into this one. Taking it out of service does not move ${holds === 1 ? 'it' : 'them'} — they keep the chair until they are done, and nothing new is seated here.`,
        },
        confirmHolds: holds,
      };
    }
  }

  await setResourceActive(prisma, resourceId, active);
  revalidatePath('/staff/resources');
  revalidatePath('/staff/day');
  return { ok: true };
}
