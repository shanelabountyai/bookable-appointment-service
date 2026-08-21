'use server';

/**
 * A-037's roster: who works here, and what the log calls them.
 *
 * IDENTITY, NOT ROLES (the backlog row is explicit, and D-9 is the reason).
 * Nothing here decides what anybody is allowed to do — every staff member can
 * do everything a staff member could do before this item. The only thing that
 * changed is that the log now knows which of them did it. A permissions matrix
 * is a different product decision and does not get smuggled in as a side
 * effect of naming people.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import { InvalidPin, type StaffRow, listStaff, saveStaffMember } from '@bookable/db/auth';
import { requireStaff } from './session';

export interface PeopleState {
  ok?: boolean;
  message?: string;
}

export async function listPeople(): Promise<StaffRow[]> {
  const staff = await requireStaff();
  return listStaff(prisma, staff.businessId);
}

export async function savePerson(_prev: PeopleState, formData: FormData): Promise<PeopleState> {
  const staff = await requireStaff();
  const id = String(formData.get('id') ?? '') || undefined;
  const name = String(formData.get('name') ?? '');
  const pin = String(formData.get('pin') ?? '');

  if (!name.trim()) return { ok: false, message: 'Everybody needs a name — it is what the log says.' };

  try {
    await saveStaffMember(prisma, {
      businessId: staff.businessId,
      id,
      name,
      // Blank leaves an existing PIN alone. Clearing one is the separate
      // "Remove PIN" button, so correcting a spelling cannot silently drop
      // somebody off the switcher.
      pin: pin || undefined,
      clearPin: formData.get('clearPin') !== null,
    });
  } catch (error) {
    if (error instanceof InvalidPin) return { ok: false, message: 'A desk PIN is 4 to 6 digits.' };
    throw error;
  }

  revalidatePath('/staff/people');
  revalidatePath('/staff', 'layout');
  return { ok: true, message: id ? 'Saved.' : `${name.trim()} added.` };
}

/**
 * Off-boarding. DEACTIVATES, never deletes — the name has to survive on every
 * event it ever stamped, or "who moved this appointment" loses its answer the
 * day somebody leaves, which is the one question A-037 exists to keep
 * answerable. Their live sessions end on the next request.
 */
export async function setPersonActive(_prev: PeopleState, formData: FormData): Promise<PeopleState> {
  const staff = await requireStaff();
  const id = String(formData.get('id') ?? '');
  const active = formData.get('active') === 'true';
  const name = String(formData.get('name') ?? '');

  if (id === staff.id && !active) {
    return { ok: false, message: 'You cannot deactivate whoever is currently at the desk.' };
  }

  await saveStaffMember(prisma, { businessId: staff.businessId, id, name, active });
  revalidatePath('/staff/people');
  revalidatePath('/staff', 'layout');
  return { ok: true, message: active ? `${name} is back on the roster.` : `${name} is off the roster.` };
}
