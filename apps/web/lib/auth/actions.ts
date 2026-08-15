'use server';

import { redirect } from 'next/navigation';
import { authenticateStaff } from '@bookable/db/auth';
import { prisma } from '@bookable/db';
import { endStaffSession, startStaffSession } from './session';

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

  const staff = await authenticateStaff(prisma, email, password);
  if (!staff) return { error: GENERIC };

  await startStaffSession(staff.id);
  redirect('/staff');
}

export async function logout(): Promise<void> {
  await endStaffSession();
  redirect('/staff/login');
}
