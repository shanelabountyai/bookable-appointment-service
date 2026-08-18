'use server';

/**
 * A-019's staff actions (AVAIL-05).
 *
 * The one rule every one of these serves: **nothing is silently cancelled,
 * moved or hidden.** Each action is something a person chose, with their name
 * on the event it writes.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import {
  type ConflictingAppointment,
  acknowledgeConflict,
  conflictsForDay,
  futureAppointments,
  reassignMany,
} from '@bookable/db/availability';
import { transitionAppointment } from '@bookable/db/appointments';
import { fromDate, toLabel, zoneId } from '@bookable/core/time';
import { staffActor } from '@bookable/core/auth';
import { requireStaff } from '@/lib/auth/session';

export interface ImpactState {
  ok?: boolean;
  message?: string;
}

export interface ConflictRow {
  id: string;
  when: string;
  providerId: string;
  providerName: string;
  clientName: string | null;
  clientPhone: string | null;
  services: string;
  acknowledged: boolean;
  acknowledgedReason: string | null;
}

/** The day's conflicts, DERIVED on every call (operator R-7) — a stored flag
 *  would go stale and lie on the day it matters. */
export async function listConflicts(day: string): Promise<ConflictRow[]> {
  const staff = await requireStaff();
  const zone = await businessZone(staff.businessId);
  const conflicts = await conflictsForDay(prisma, { businessId: staff.businessId, day });
  return conflicts.map((conflict) => shape(conflict, zone));
}

/** Operator S-2's deactivation preview, moved out of A-025 because no
 *  appointment could exist there to test it against. */
export async function listDeactivationImpact(providerId: string): Promise<ConflictRow[]> {
  const staff = await requireStaff();
  const zone = await businessZone(staff.businessId);
  const stranded = await futureAppointments(prisma, {
    businessId: staff.businessId,
    providerId,
    from: new Date(),
  });
  return stranded.map((conflict) => shape(conflict, zone));
}

/** AVAIL-05's "keep-flagged". */
export async function keepFlagged(_previous: ImpactState, formData: FormData): Promise<ImpactState> {
  const staff = await requireStaff();
  const appointmentId = String(formData.get('appointmentId') ?? '');
  const reason = String(formData.get('reason') ?? '');

  await acknowledgeConflict(prisma, {
    appointmentId,
    businessId: staff.businessId,
    reason,
    actor: staffActor(staff.id),
    now: new Date(),
  });
  revalidatePath('/staff/conflicts');
  return { ok: true, message: 'Kept, and flagged as dealt with.' };
}

/**
 * AVAIL-05's "cancel with notification".
 *
 * The reason is required and it is not ceremony: this is the one action here
 * that takes a client's appointment away, and "why" is what the front desk
 * reads back to her on the phone.
 */
export async function cancelConflicting(_previous: ImpactState, formData: FormData): Promise<ImpactState> {
  const staff = await requireStaff();
  const appointmentId = String(formData.get('appointmentId') ?? '');
  const reason = String(formData.get('reason') ?? '');

  if (!reason.trim()) return { ok: false, message: 'Say why — it goes in the log and on the client’s record.' };

  await transitionAppointment(prisma, {
    appointmentId,
    to: 'cancelled',
    actor: staffActor(staff.id),
    now: new Date(),
    reason,
  });
  revalidatePath('/staff/conflicts');
  return { ok: true, message: 'Cancelled, and recorded.' };
}

/** "Reassign Saturday to Priya where qualified." Partial by design. */
export async function reassignConflicting(_previous: ImpactState, formData: FormData): Promise<ImpactState> {
  const staff = await requireStaff();
  const toProviderId = String(formData.get('toProviderId') ?? '');
  const reason = String(formData.get('reason') ?? '');
  const appointmentIds = formData.getAll('appointmentIds').map(String).filter(Boolean);

  if (appointmentIds.length === 0) return { ok: false, message: 'Choose at least one appointment.' };
  if (!toProviderId) return { ok: false, message: 'Choose who to move them to.' };

  const outcomes = await reassignMany(prisma, {
    businessId: staff.businessId,
    appointmentIds,
    toProviderId,
    actor: staffActor(staff.id),
    reason,
  });

  const moved = outcomes.filter((o) => o.ok).length;
  const stuck = outcomes.filter((o) => !o.ok);
  revalidatePath('/staff/conflicts');

  return {
    ok: stuck.length === 0,
    // Names what did NOT happen, because that is the half somebody has to act
    // on next — a message that only counted successes would leave six clients
    // quietly unhandled.
    message:
      stuck.length === 0
        ? `Moved ${moved}.`
        : `Moved ${moved}. ${stuck.length} could not move: ${[...new Set(stuck.map((s) => readable(s.failure)))].join(', ')}.`,
  };
}

/** Who could take these — active providers other than the one they are on. */
export async function listReassignTargets(excludeProviderId: string): Promise<{ id: string; name: string }[]> {
  const staff = await requireStaff();
  const providers = await prisma.provider.findMany({
    where: { businessId: staff.businessId, active: true, id: { not: excludeProviderId } },
    orderBy: [{ displayOrder: 'asc' }, { displayName: 'asc' }],
    select: { id: true, displayName: true },
  });
  return providers.map((p) => ({ id: p.id, name: p.displayName }));
}

// ─────────────────────────── internals ───────────────────────────

async function businessZone(businessId: string) {
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } });
  return zoneId(business.timezone);
}

function shape(conflict: ConflictingAppointment, zone: ReturnType<typeof zoneId>): ConflictRow {
  const label = toLabel(fromDate(conflict.startAt), zone);
  return {
    id: conflict.id,
    // Formatted server-side in the salon's zone, always.
    when: label.time,
    providerId: conflict.providerId,
    providerName: conflict.providerName,
    clientName: conflict.clientName,
    clientPhone: conflict.clientPhone,
    services: conflict.serviceNames.join(' + '),
    acknowledged: conflict.acknowledgedAt !== null,
    acknowledgedReason: conflict.acknowledgedReason,
  };
}

function readable(failure: string | undefined): string {
  switch (failure) {
    case 'not-qualified':
      return 'not qualified for the service';
    case 'provider-busy':
      return 'she is already booked then';
    case 'not-active':
      return 'that stylist is not active';
    default:
      return 'not movable';
  }
}
