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
import { requireDesk, requireStaff } from './session';

export interface PeopleState {
  ok?: boolean;
  message?: string;
}

/** The roster, plus whether this session may hand out PINs — the screen hides
 *  the fields it would only be refused for. The refusal in `savePerson` is the
 *  control; this is the courtesy that stops somebody typing a PIN twice before
 *  finding out. */
export async function listPeople(): Promise<{ people: StaffRow[]; canSetPins: boolean }> {
  const desk = await requireDesk();
  return { people: await listStaff(prisma, desk.staff.businessId), canSetPins: desk.isAccountHolder };
}

export async function savePerson(_prev: PeopleState, formData: FormData): Promise<PeopleState> {
  const desk = await requireDesk();
  const id = String(formData.get('id') ?? '') || undefined;
  const name = String(formData.get('name') ?? '');
  const pin = String(formData.get('pin') ?? '');
  const clearPin = formData.get('clearPin') !== null;

  if (!name.trim()) return { ok: false, message: 'Everybody needs a name — it is what the log says.' };

  // A-044. Checked on the POSTED FIELDS, not on what the screen chose to draw:
  // hiding an input hides nothing from anybody willing to send the form
  // themselves, and this action is the only place the refusal is real.
  if ((pin || clearPin) && !desk.isAccountHolder) {
    return {
      ok: false,
      message:
        'Only the account this terminal signed in with can set a desk PIN. ' +
        'Everything else on this screen is yours to change.',
    };
  }

  try {
    await saveStaffMember(prisma, {
      businessId: desk.staff.businessId,
      id,
      name,
      // Blank leaves an existing PIN alone. Clearing one is the separate
      // "Remove PIN" button, so correcting a spelling cannot silently drop
      // somebody off the switcher.
      pin: pin || undefined,
      clearPin,
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
