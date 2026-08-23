'use server';

import { revalidatePath } from 'next/cache';
import { staffActor } from '@bookable/core/auth';
import { InvalidAvailability } from '@bookable/core/availability';
import { instantFromIso, toDate } from '@bookable/core/time';
import { prisma } from '@bookable/db';
import {
  type ActorStamp,
  type ConflictingAppointment,
  type HoursChange,
  type HoursScope,
  appointmentsInRange,
  createAdHocBlock,
  createTimeOff,
  createWeeklyWindow,
  deleteDateOverride,
  deleteTimeOff,
  deleteWeeklyWindow,
  recordHoursStranding,
  strandedByHoursChange,
  upsertDateOverride,
} from '@bookable/db/availability';
import { requireStaff } from '@/lib/auth/session';
import type { FormState } from './actions';

export type { FormState } from './actions';

/**
 * What EVERY availability write returns (A-041, widened by A-047).
 *
 * The write always succeeds — D-2 and AVAIL-03: "Dana called in sick" and "I
 * don't work Thursdays any more" must never be refused. This is the sentence
 * that comes back with it. A-041 built the mechanism and wired one caller;
 * the other four returned `{ ok: true }` and said nothing, which is the same
 * silence with better manners.
 */
export interface ImpactState extends FormState {
  strandedCount?: number;
  /** Which day to send the desk to on `/staff/conflicts` — taken from the
   *  EARLIEST stranded appointment's own stored calendar day, so the link
   *  cannot point somewhere the list is empty. */
  conflictsDay?: string;
}

/** A-041's name for it, kept so nothing that already imports it breaks. */
export type AbsenceState = ImpactState;

/** Conflicts → the two fields the form renders. Sorted by `startAt` upstream,
 *  so the first one is the earliest. */
const impactOf = (conflicts: readonly ConflictingAppointment[]): Pick<ImpactState, 'strandedCount' | 'conflictsDay'> =>
  conflicts.length === 0 ? { strandedCount: 0 } : { strandedCount: conflicts.length, conflictsDay: conflicts[0]!.startDay };

/**
 * The whole of A-047, once: re-derive who no longer fits, and record who moved
 * the hours on each of them.
 *
 * AFTER the write, never before — `strandedByHoursChange` asks the precedence
 * chain what the windows ARE, and asking it what they WOULD BE from an unsaved
 * edit is a second implementation of the thing most worth having only one of.
 */
async function hoursImpact(
  businessId: string,
  providerId: string | null,
  scope: HoursScope,
  change: HoursChange,
  actorRef: string,
): Promise<Pick<ImpactState, 'strandedCount' | 'conflictsDay'>> {
  const conflicts = await strandedByHoursChange(prisma, { businessId, providerId, scope, now: new Date() });
  await recordHoursStranding(prisma, { businessId, conflicts, actor: staffActor(actorRef), change });
  return impactOf(conflicts);
}

/** Every availability write is stamped with who made it (operator R-8). */
async function actorStamp(): Promise<{ businessId: string; staffId: string; actor: ActorStamp }> {
  const staff = await requireStaff();
  return { businessId: staff.businessId, staffId: staff.id, actor: { createdByActor: 'staff', actorRef: staff.id } };
}

const str = (fd: FormData, key: string): string => String(fd.get(key) ?? '').trim();

function handle(error: unknown): FormState {
  if (error instanceof InvalidAvailability) return { errors: { [error.field]: error.message } };
  throw error;
}

export async function addWeeklyWindow(_prev: ImpactState, formData: FormData): Promise<ImpactState> {
  const { businessId, staffId, actor } = await actorStamp();
  const providerId = str(formData, 'providerId');
  const weekday = Number(str(formData, 'weekday'));
  const breakOpen = str(formData, 'breakOpen');
  const breakClose = str(formData, 'breakClose');

  try {
    await createWeeklyWindow(
      prisma,
      {
        businessId,
        // An empty providerId means the BUSINESS-level pattern (AVAIL-04).
        providerId: providerId === '' ? null : providerId,
        weekday,
        open: str(formData, 'open'),
        close: str(formData, 'close'),
        endsNextDay: formData.get('endsNextDay') === 'on',
        ...(breakOpen && breakClose ? { breaks: [{ open: breakOpen, close: breakClose }] } : {}),
      },
      actor,
    );
  } catch (error) {
    return handle(error);
  }
  revalidatePath('/staff/availability');
  // Adding hours usually strands nobody — and a BREAK added with them is hours
  // taken away, so "usually" is not "never". Derived rather than argued.
  return {
    ok: true,
    message: 'Hours added.',
    ...(await hoursImpact(businessId, providerId || null, { kind: 'weekday', weekday }, 'weekly_window_added', staffId)),
  };
}

/**
 * "I don't work Thursdays any more" — the worst of the four, and the one
 * nobody listed. It orphans every future Thursday booking, and until A-047 it
 * returned a bare `{ ok: true }`.
 *
 * The row is read BEFORE the delete because its weekday and provider are the
 * scope of the re-derivation and they go with it.
 */
export async function removeWeeklyWindow(_prev: ImpactState, formData: FormData): Promise<ImpactState> {
  const { businessId, staffId } = await actorStamp();
  const id = str(formData, 'windowId');

  const window = await prisma.weeklyWindow.findFirst({
    where: { id, businessId },
    select: { providerId: true, weekday: true },
  });
  if (!window) return { ok: true };

  await deleteWeeklyWindow(prisma, { businessId, id });
  revalidatePath('/staff/availability');
  return {
    ok: true,
    message: 'Hours removed.',
    ...(await hoursImpact(
      businessId,
      window.providerId,
      { kind: 'weekday', weekday: window.weekday },
      'weekly_window_removed',
      staffId,
    )),
  };
}

export async function saveDateOverride(_prev: ImpactState, formData: FormData): Promise<ImpactState> {
  const { businessId, staffId, actor } = await actorStamp();
  const providerId = str(formData, 'providerId');
  const day = str(formData, 'day');
  const isClosed = formData.get('isClosed') === 'on';
  const open = str(formData, 'open');
  const close = str(formData, 'close');

  try {
    await upsertDateOverride(
      prisma,
      {
        businessId,
        providerId: providerId === '' ? null : providerId,
        day,
        isClosed,
        reason: str(formData, 'reason') || null,
        ...(isClosed ? {} : { windows: [{ open, close, endsNextDay: false }] }),
      },
      actor,
    );
  } catch (error) {
    return handle(error);
  }
  revalidatePath('/staff/availability');
  // `isClosed` is "we're shut that day", which strands everything on it. A
  // narrower window strands whatever now falls outside. One derivation covers
  // both, and covers the third case — a WIDER day, which strands nobody.
  return {
    ok: true,
    message: 'Override saved.',
    ...(await hoursImpact(businessId, providerId || null, { kind: 'day', day }, 'override_saved', staffId)),
  };
}

/**
 * Removing an override restores the weekly pattern, which cuts BOTH ways:
 * dropping a "closed for the holiday" frees time and strands nobody, while
 * dropping an "open late on the 14th" strands whoever was booked into the
 * late hours. Same derivation, no per-case reasoning.
 */
export async function removeDateOverride(_prev: ImpactState, formData: FormData): Promise<ImpactState> {
  const { businessId, staffId } = await actorStamp();
  const id = str(formData, 'overrideId');

  const override = await prisma.dateOverride.findFirst({
    where: { id, businessId },
    select: { providerId: true, day: true },
  });
  if (!override) return { ok: true };

  await deleteDateOverride(prisma, { businessId, id });
  revalidatePath('/staff/availability');
  return {
    ok: true,
    message: 'Override removed.',
    ...(await hoursImpact(businessId, override.providerId, { kind: 'day', day: override.day }, 'override_removed', staffId)),
  };
}

/**
 * Time off / ad-hoc block.
 *
 * Takes offset-bearing ISO instants, not `{date, time}` (D-4): a wall-clock
 * pair is undecidable on fall-back day, and this is a payload crossing a
 * form boundary — exactly where that rule bites.
 *
 * Deliberately does NOT check for appointments it covers (D-2/AVAIL-03).
 * "Dana called in sick" must always succeed; surfacing the nine appointments
 * it stranded is A-019's impact preview, not a refusal here.
 */
export async function addAbsence(_prev: AbsenceState, formData: FormData): Promise<AbsenceState> {
  const { businessId, actor } = await actorStamp();
  const providerId = str(formData, 'providerId');
  const kind = str(formData, 'kind');

  let startAt: Date;
  let endAt: Date;
  try {
    startAt = toDate(instantFromIso(str(formData, 'startAt')));
    endAt = toDate(instantFromIso(str(formData, 'endAt')));
  } catch {
    return { errors: { startAt: 'Give a start and end with an explicit timezone offset.' } };
  }

  const input = { businessId, providerId, startAt, endAt, reason: str(formData, 'reason') || null };
  try {
    if (kind === 'ad_hoc_block') await createAdHocBlock(prisma, input, actor);
    else await createTimeOff(prisma, input, actor);
  } catch (error) {
    return handle(error);
  }
  revalidatePath('/staff/availability');

  // AVAIL-05 (operator P-8): the write above already succeeded unconditionally
  // — this is the sentence that comes back, never a gate on the write. The
  // desk (or the owner, editing hours from home on a Sunday) sees the count
  // AND a way to reach the people, not just a "Time off added." that hides it.
  const stranded = await appointmentsInRange(prisma, { businessId, providerId, startAt, endAt });

  return {
    ok: true,
    message: kind === 'ad_hoc_block' ? 'Block added.' : 'Time off added.',
    // A-047 took the day from the stranded appointment's own stored calendar
    // day rather than re-labelling the absence's start instant. Same answer
    // almost always, and the exception is the one that matters: an absence
    // starting at 23:30 stranded a booking that belongs to the NEXT day, and
    // the old link sent the desk to a page where she was not listed.
    ...impactOf(stranded),
  };
}

/**
 * Removing an absence FREES time, so nothing can be stranded by it and there
 * is no sentence to return — `deleteTimeOff` already freshens the
 * acknowledgments that were about it. The business scoping is the A-047 half
 * that applies here: the id comes from a form.
 */
export async function removeTimeOff(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  await deleteTimeOff(prisma, { businessId: staff.businessId, id: str(formData, 'timeOffId') });
  revalidatePath('/staff/availability');
  return { ok: true };
}
