'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { TooManyAttempts, authenticateStaff, verifyStaffPin } from '@bookable/db/auth';
import { prisma } from '@bookable/db';
import { actAsStaff, endStaffSession, requireStaff, startStaffSession } from './session';

export interface LoginState {
  error?: string;
}

/**
 * The login action.
 *
 * ONE error message for every failure — unknown email, wrong password,
 * missing field. Distinguishing them turns the form into a directory of who
 * has an account. `authenticateStaff` already equalises the *timing* of those
 * branches; this equalises the *text*.
 */
export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  const GENERIC = 'That email and password do not match.';
  if (!email || !password) return { error: GENERIC };

  // A-050. The lockout is the ONE failure that gets its own words. It cannot
  // enumerate anybody — the limiter is keyed on the typed email and consumed
  // before the row is looked up, so an address that does not exist locks out
  // identically — and a desk typing the right password into a closed door
  // needs to be told the door is closed rather than doubting the password.
  let staff;
  try {
    staff = await authenticateStaff(prisma, email, password);
  } catch (error) {
    if (error instanceof TooManyAttempts) return { error: error.message };
    throw error;
  }
  if (!staff) return { error: GENERIC };

  await startStaffSession(staff.id);
  redirect('/staff');
}

export interface SwitchState {
  error?: string;
  message?: string;
}

/**
 * "Who is at the desk?" (A-037, D-33).
 *
 * NOT a login. The session is already authenticated — `requireStaff()` is the
 * first statement and it redirects if it is not — so this decides only whose
 * name goes on the next mutation. That is why a four-digit PIN is enough here
 * and would not be enough on the sign-in form: this door is already inside the
 * building.
 *
 * The business comes from the SESSION, never from the form, so a posted id
 * cannot put a name from another salon onto this salon's audit log.
 */
export async function switchStaff(_prev: SwitchState, formData: FormData): Promise<SwitchState> {
  const current = await requireStaff();
  const staffUserId = String(formData.get('staffUserId') ?? '');
  const pin = String(formData.get('pin') ?? '');

  // One message for every failure — an unknown id, a wrong PIN, a person with
  // no PIN set. Distinguishing them turns the switcher into a probe for who
  // works here, on a screen anyone standing at reception can read.
  const GENERIC = 'That name and PIN do not match.';
  if (!staffUserId || !pin) return { error: GENERIC };

  let staff;
  try {
    staff = await verifyStaffPin(prisma, { businessId: current.businessId, staffUserId, pin });
  } catch (error) {
    // A-050 — four digits is a walkable keyspace and this form is in a room
    // the public stands in. Per-name, so one stylist's fat finger cannot lock
    // the desk out of everybody else.
    if (error instanceof TooManyAttempts) return { error: error.message };
    throw error;
  }
  if (!staff) return { error: GENERIC };

  await actAsStaff(staff.id);
  revalidatePath('/staff', 'layout');
  return { message: `${staff.name} is at the desk.` };
}

export async function logout(): Promise<void> {
  await endStaffSession();
  redirect('/staff/login');
}
