'use server';

/**
 * A-018's staff actions (APPT-03, APPT-04, D-22).
 *
 * Two deliberately different things live here, and the difference is the whole
 * item: the DELTA says "Dana is forty behind" and moves nothing, while the
 * PUSH rewrites `startAt` and tells everybody. Collapsing them would either
 * silently change the time on a confirmation somebody is holding, or leave the
 * website selling slots that no longer exist.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import { type PushPreview, clearRunningLate, previewPush, pushColumn, setRunningLate } from '@bookable/db/day';
import { fromDate, instantFromIso, toDate, toLabel, zoneId } from '@bookable/core/time';
import { staffActor } from '@bookable/core/auth';
import { requireStaff } from '@/lib/auth/session';

export interface DayActionState {
  ok?: boolean;
  message?: string;
}

/** APPT-03: "Dana +38", settable and clearable in one tap. */
export async function setColumnRunningLate(_previous: DayActionState, formData: FormData): Promise<DayActionState> {
  const staff = await requireStaff();
  const providerId = String(formData.get('providerId') ?? '');
  const day = String(formData.get('day') ?? '');
  const raw = String(formData.get('minutes') ?? '').trim();
  const minutes = Number(raw);

  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 8 * 60) {
    // A cap, because the only way to type 400 is by accident and the delta
    // would then hide the entire rest of the day from the booking page.
    return { ok: false, message: 'Enter how many minutes behind, between 0 and 480.' };
  }

  await setRunningLate(prisma, { businessId: staff.businessId, providerId, day, minutes, actor: staffActor(staff.id) });
  revalidatePath('/staff/day');
  return { ok: true, message: minutes === 0 ? 'Back on time.' : `Running ${minutes} minutes behind.` };
}

export async function clearColumnRunningLate(_previous: DayActionState, formData: FormData): Promise<DayActionState> {
  await requireStaff();
  await clearRunningLate(prisma, {
    providerId: String(formData.get('providerId') ?? ''),
    day: String(formData.get('day') ?? ''),
  });
  revalidatePath('/staff/day');
  return { ok: true, message: 'Back on time.' };
}

export interface PreviewShape {
  minutes: number;
  canPush: boolean;
  rows: { appointmentId: string; clientName: string | null; from: string; to: string; problem?: string }[];
}

/** APPT-04's collision preview — what would move, and what cannot. */
export async function previewColumnPush(providerId: string, day: string, fromAt: string, minutes: number): Promise<PreviewShape | null> {
  const staff = await requireStaff();
  if (!Number.isInteger(minutes) || minutes === 0) return null;

  let at: Date;
  try {
    at = toDate(instantFromIso(fromAt));
  } catch {
    return null;
  }

  const preview = await previewPush(prisma, { businessId: staff.businessId, providerId, day, fromAt: at, minutes });
  return shapeFor(preview, staff.businessId);
}

export async function confirmColumnPush(_previous: DayActionState, formData: FormData): Promise<DayActionState> {
  const staff = await requireStaff();
  const providerId = String(formData.get('providerId') ?? '');
  const day = String(formData.get('day') ?? '');
  const minutes = Number(String(formData.get('minutes') ?? ''));
  const reason = String(formData.get('reason') ?? '');

  let at: Date;
  try {
    at = toDate(instantFromIso(String(formData.get('fromAt') ?? '')));
  } catch {
    return { ok: false, message: 'That starting point is not readable.' };
  }

  try {
    const result = await pushColumn(prisma, {
      businessId: staff.businessId,
      providerId,
      day,
      fromAt: at,
      minutes,
      actor: staffActor(staff.id),
      reason,
    });
    revalidatePath('/staff/day');

    // D-26: say what MOVED and, more importantly, what did not. A message
    // that only counted successes would leave the stuck clients quietly
    // unhandled — the same failure this whole workflow exists to prevent.
    const stayed = result.leftBehind
      .map((c) => `${c.clientName ?? 'a walk-in'} (${PROBLEMS[c.problem ?? ''] ?? 'blocked by one that stayed'})`)
      .join(', ');

    if (result.moved === 0) {
      return {
        ok: false,
        message: `Nothing could move: ${stayed}. Shorten the push, or move that one by hand first.`,
      };
    }

    return {
      ok: result.leftBehind.length === 0,
      message:
        `Moved ${result.moved} appointment${result.moved === 1 ? '' : 's'}. ${result.notified} client${result.notified === 1 ? '' : 's'} told.` +
        (stayed ? ` Left where they were: ${stayed}.` : ''),
    };
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, message: 'Choose how many minutes to push by.' };
    throw error;
  }
}

// ─────────────────────────── internals ───────────────────────────

/**
 * Why a client is staying put, in the salon's words (D-10's staff half).
 *
 * A-034 added the third one. "No chair free" is a different next action from
 * the other two — the desk cannot fix it by shortening the push, it has to
 * seat her somewhere or move somebody else — so it must not be folded into the
 * generic "blocked" wording.
 */
const PROBLEMS: Record<string, string> = {
  'past-closing': 'would run past closing',
  'blocked-by-one-that-stays': 'blocked by one that stayed',
  'no-chair-free': 'no chair free at the new time',
};

async function shapeFor(preview: PushPreview, businessId: string): Promise<PreviewShape> {
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } });
  const clock = (at: Date) => toLabel(fromDate(at), zoneId(business.timezone)).time;

  return {
    minutes: preview.minutes,
    canPush: preview.canPush,
    rows: preview.candidates.map((candidate) => ({
      appointmentId: candidate.appointmentId,
      clientName: candidate.clientName,
      // Formatted in the SALON's zone, server-side — the browser never sees
      // an instant here.
      from: clock(candidate.from),
      to: clock(candidate.to),
      ...(candidate.problem ? { problem: candidate.problem } : {}),
    })),
  };
}
