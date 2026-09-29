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
import {
  type ClientSummary,
  MergeRefused,
  mergeClients,
  saveClientNotes as writeClientNotes,
  searchClients,
  updateClientContact,
} from '@bookable/db/clients';
import { staffActor } from '@bookable/core/auth';
import { requireStaff } from '@/lib/auth/session';

export interface FormState {
  ok?: boolean;
  message?: string;
  /** OQ-23(a): a stale note save is refused, not applied. Set when it was,
   *  carrying the version id a resubmit needs to go through, and what is
   *  actually on the record now so the form can show both texts. */
  conflict?: { baseVersionId: string | null; currentText: string; currentAuthor: string | null; attemptedText: string };
  /** A-146: the contact edit found another live client with the same
   *  canonical phone + name. Not saved — offered as a merge instead. */
  contactMatch?: { id: string; name: string | null };
}

/** Live search for the merge picker. */
export async function findClients(query: string): Promise<ClientSummary[]> {
  const staff = await requireStaff();
  return searchClients(prisma, staff.businessId, query);
}

export async function saveClientNotes(_previous: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const id = String(formData.get('clientId') ?? '');
  const baseVersionId = String(formData.get('baseVersionId') ?? '') || null;
  const text = String(formData.get('notes') ?? '');

  const result = await writeClientNotes(prisma, {
    businessId: staff.businessId,
    clientId: id,
    text,
    baseVersionId,
    actor: staffActor(staff.id),
  });

  if (!result.ok) {
    if (result.reason === 'not-found') return { ok: false, message: 'Could not save — client not found.' };
    return {
      ok: false,
      message: 'This note changed since the page loaded. Review what is on file, then save again to keep yours.',
      conflict: {
        baseVersionId: result.current?.id ?? null,
        currentText: result.current?.text ?? '',
        currentAuthor: result.current?.actorName ?? null,
        // React resets the form's own fields once the action returns (same
        // as a native form post) — this is what lets the textarea show what
        // she typed instead of losing it to that reset.
        attemptedText: text,
      },
    };
  }

  revalidatePath(`/staff/clients/${id}`);
  return { ok: true, message: 'Note saved.' };
}

export async function saveClientContact(_previous: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const id = String(formData.get('clientId') ?? '');

  const result = await updateClientContact(prisma, staff.businessId, id, {
    name: String(formData.get('name') ?? '').trim() || null,
    phone: String(formData.get('phone') ?? '').trim() || null,
    email: String(formData.get('email') ?? '').trim() || null,
  });

  if (!result.ok) {
    if (result.reason === 'not-found') return { ok: false, message: 'Could not save — client not found.' };
    return {
      ok: false,
      message: `That phone number and name already belong to ${result.match.name ?? 'another record'}. Merge instead, or change one of the fields.`,
      contactMatch: result.match,
    };
  }

  revalidatePath(`/staff/clients/${id}`);
  return { ok: true, message: 'Saved.' };
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
    const result = await mergeClients(prisma, {
      businessId: staff.businessId,
      survivorId,
      losingId,
      actor: staffActor(staff.id),
    });
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
