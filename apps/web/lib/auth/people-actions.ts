'use server';

/**
 * A-037's roster: who works here, and what the log calls them. A-050 makes it
 * also the place credentials and the one role split are handed out.
 *
 * TWO different guards live on this screen and they are not the same guard:
 *
 *  - A-044's ACCOUNT HOLDER check gates the desk PIN. A PIN decides whose name
 *    goes on the audit trail, so it cannot be issued from a borrowed identity
 *    or the trail forges in thirty seconds.
 *  - A-050's OWNER check gates the email, the password and the role. This is
 *    the privilege-escalation surface: a stylist who could grant herself a
 *    sign-in, or promote herself, would make the role split decorative.
 *
 * Both are checked on the POSTED FIELDS. Hiding an input hides nothing from
 * anybody willing to send the form themselves.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import {
  InvalidCredential,
  InvalidPin,
  type StaffRole,
  type StaffRow,
  listStaff,
  saveStaffMember,
} from '@bookable/db/auth';
import { requireDesk, requireStaff } from './session';

export interface PeopleState {
  ok?: boolean;
  message?: string;
}

/** The roster, plus what this session may hand out — the screen hides the
 *  fields it would only be refused for. The refusals in `savePerson` are the
 *  control; this is the courtesy that stops somebody typing a password twice
 *  before finding out. */
export async function listPeople(): Promise<{ people: StaffRow[]; canSetPins: boolean; canSetCredentials: boolean }> {
  const desk = await requireDesk();
  return {
    people: await listStaff(prisma, desk.staff.businessId),
    canSetPins: desk.isAccountHolder,
    canSetCredentials: desk.staff.role === 'owner',
  };
}

export async function savePerson(_prev: PeopleState, formData: FormData): Promise<PeopleState> {
  const desk = await requireDesk();
  const id = String(formData.get('id') ?? '') || undefined;
  const name = String(formData.get('name') ?? '');
  const pin = String(formData.get('pin') ?? '');
  const clearPin = formData.get('clearPin') !== null;
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const rawRole = String(formData.get('role') ?? '');
  // Only the two the enum has. An unrecognised value is left UNDEFINED rather
  // than coerced to 'staff': a posted typo must not silently demote somebody.
  const role: StaffRole | undefined = rawRole === 'owner' || rawRole === 'staff' ? rawRole : undefined;

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

  // A-050. The escalation guard, and the reason it is separate from the PIN
  // one above: a sign-in and a role are what somebody could give THEMSELVES to
  // stop the split meaning anything. Checked on the posted fields, so the
  // hidden inputs on the screen are a courtesy and this is the control.
  if ((email || password || role) && desk.staff.role !== 'owner') {
    return {
      ok: false,
      message: 'Only an owner can give somebody a sign-in or change what they are. Names and the roster are yours.',
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
      // Same rule for the credential fields: blank leaves what is there. A
      // password box that cleared the password when left empty would sign
      // somebody out of their own salon every time their name was corrected.
      email: email || undefined,
      password: password || undefined,
      role,
    });
  } catch (error) {
    if (error instanceof InvalidPin) return { ok: false, message: 'A desk PIN is 4 to 6 digits.' };
    // Already a sentence written for this screen — a bad password, a password
    // with no email to use it with, or the last-owner refusal.
    if (error instanceof InvalidCredential) return { ok: false, message: error.message };
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

  // A-050. OWNER ONLY, which is a tightening of A-037's behaviour and is
  // deliberate: deactivating somebody ends their live sessions on the next
  // request, so "off the roster" is a credential being taken away — the same
  // authority as handing one out, and the same person's to exercise. Left
  // open, a stylist could put the owner off her own roster.
  if (staff.role !== 'owner') {
    return { ok: false, message: 'Only an owner can take somebody off the roster or put them back on it.' };
  }

  const id = String(formData.get('id') ?? '');
  const active = formData.get('active') === 'true';
  const name = String(formData.get('name') ?? '');

  if (id === staff.id && !active) {
    return { ok: false, message: 'You cannot deactivate whoever is currently at the desk.' };
  }

  try {
    await saveStaffMember(prisma, { businessId: staff.businessId, id, name, active });
  } catch (error) {
    // The last-owner refusal reaches HERE too, and that is the point of it
    // living in `saveStaffMember`: taking the only owner off the roster locks
    // the salon out exactly as demoting her does, and a guard that only knew
    // about the role form would have missed the other half.
    if (error instanceof InvalidCredential) return { ok: false, message: error.message };
    throw error;
  }
  revalidatePath('/staff/people');
  revalidatePath('/staff', 'layout');
  return { ok: true, message: active ? `${name} is back on the roster.` : `${name} is off the roster.` };
}
