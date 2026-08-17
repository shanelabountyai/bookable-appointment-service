'use server';

/**
 * A-015's staff actions (CLIENT-01..03).
 *
 * Every one of these starts with `requireStaff()`. A client record is the most
 * PII-dense screen in the app — name, number, history, and a note that may say
 * what someone is allergic to — so "the page checked" is not sufficient: an
 * action is its own entry point.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import { type ClientSummary, MergeRefused, mergeClients, searchClients, setClientNotes } from '@bookable/db/clients';
import { requireStaff } from '@/lib/auth/session';

export interface FormState {
  ok?: boolean;
  message?: string;
}

/** Live search for the merge picker. */
export async function findClients(query: string): Promise<ClientSummary[]> {
  const staff = await requireStaff();
  return searchClients(prisma, staff.businessId, query);
}

export async function saveClientNotes(_previous: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const id = String(formData.get('clientId') ?? '');

  await setClientNotes(prisma, staff.businessId, id, String(formData.get('notes') ?? ''));

  revalidatePath(`/staff/clients/${id}`);
  return { ok: true, message: 'Note saved.' };
}

/**
 * CLIENT-01's merge. The page names which record SURVIVES, because that is the
 * decision staff are making and it is not reversible by a second merge.
 */
export async function mergeClientRecords(_previous: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const survivorId = String(formData.get('survivorId') ?? '');
  const losingId = String(formData.get('losingId') ?? '');

  try {
    const result = await mergeClients(prisma, { businessId: staff.businessId, survivorId, losingId });
    revalidatePath(`/staff/clients/${survivorId}`);
    return {
      ok: true,
      message: `Merged. ${result.appointmentsMoved} appointment${result.appointmentsMoved === 1 ? '' : 's'} moved across, and the old number still finds this record.`,
    };
  } catch (error) {
    if (error instanceof MergeRefused) return { ok: false, message: error.message };
    throw error;
  }
}
