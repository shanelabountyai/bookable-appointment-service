'use server';

import { prisma } from '@bookable/db';
import { type UnconfirmedAppointment, listUnconfirmedTomorrow } from '@bookable/db/appointments';
import { requireStaff } from '@/lib/auth/session';

/** A-021's call-down list, scoped to the signed-in staff member's business. */
export async function listCallDown(tomorrow: string): Promise<UnconfirmedAppointment[]> {
  const staff = await requireStaff();
  return listUnconfirmedTomorrow(prisma, { businessId: staff.businessId, tomorrow });
}
