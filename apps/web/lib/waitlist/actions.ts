'use server';

/**
 * A-023's staff actions (WAIT-01, WAIT-02).
 *
 * Matching itself (`matchFreedSlot`) is read-only and runs straight in the
 * page component, same as every other staff read model — an action wrapper
 * only earns its keep here for the two things that mutate and the live
 * client search a client component needs.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import { type ClientSummary, searchClients } from '@bookable/db/clients';
import { WaitlistEntryRejected, createWaitlistEntry, setWaitlistEntryStatus } from '@bookable/db/waitlist';
import { requireStaff } from '@/lib/auth/session';

export interface FormState {
  ok?: boolean;
  message?: string;
}

/** Live search for the entry form's client picker (same lookup as A-017's
 *  booking flow and A-015's merge picker). */
export async function findClients(query: string): Promise<ClientSummary[]> {
  const staff = await requireStaff();
  return searchClients(prisma, staff.businessId, query);
}

export async function addWaitlistEntry(_previous: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  try {
    const entry = await createWaitlistEntry(prisma, {
      businessId: staff.businessId,
      clientId: String(formData.get('clientId') ?? ''),
      serviceId: String(formData.get('serviceId') ?? ''),
      providerIds: formData.getAll('providerIds').map(String),
      fromDay: String(formData.get('fromDay') ?? ''),
      toDay: String(formData.get('toDay') ?? ''),
      dayParts: formData.getAll('dayParts').map(String),
    });
    revalidatePath('/staff/waitlist');
    return { ok: true, message: `Added ${entry.clientName ?? 'the client'} to the waitlist.` };
  } catch (error) {
    if (error instanceof WaitlistEntryRejected) return { ok: false, message: error.message };
    throw error;
  }
}

/** Closes out an entry — booked elsewhere (`fulfilled`) or no longer wanted
 *  (`cancelled`). One setter for both: CLAUDE.md's status-module rule exists
 *  because a status has MANY readers, and this one has exactly one. */
export async function updateEntryStatus(_previous: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const entryId = String(formData.get('entryId') ?? '');
  const status = String(formData.get('status') ?? '');
  if (status !== 'fulfilled' && status !== 'cancelled') {
    return { ok: false, message: 'Not a status this button can set.' };
  }
  await setWaitlistEntryStatus(prisma, { businessId: staff.businessId, entryId, status });
  revalidatePath('/staff/waitlist');
  return { ok: true, message: status === 'fulfilled' ? 'Marked fulfilled.' : 'Removed.' };
}
