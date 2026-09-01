'use server';

/**
 * A-057 — "END THIS SERIES HERE" (D-39).
 *
 * The desk half of the argument that overturned D-35: creating six
 * appointments is one action and undoing them was six, so the undo is one now
 * too — one preview, one reason, one button.
 *
 * STAFF ONLY. There is deliberately no customer equivalent: the manage link
 * grants exactly one appointment (TOKEN-01), and "cancel the rest of them
 * while you are at it" from a link in a text message is a bulk action nobody
 * confirmed in front of a person.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import { type EndSeriesRow, endSeriesHere, previewEndSeries } from '@bookable/db/booking';
import { staffActor } from '@bookable/core/auth';
import { requireStaff } from '@/lib/auth/session';
import { readableInstant } from '@/lib/customer-format';

export interface SeriesEndRow {
  appointmentId: string;
  /** Already in the salon's zone, server-side — the browser never sees an
   *  instant here (D-4's habit, kept even where it is only a label). */
  when: string;
  insideCutoff: boolean;
  problem?: string;
}

export interface SeriesEndPreview {
  rows: SeriesEndRow[];
  canEnd: boolean;
}

/** What ending it here would cancel, and which of them count as late. */
export async function previewSeriesEnd(appointmentId: string): Promise<SeriesEndPreview | null> {
  const staff = await requireStaff();
  const plan = await previewEndSeries(prisma, {
    businessId: staff.businessId,
    appointmentId,
    now: new Date(),
  });
  if (!plan) return null;

  const timezone = await salonZone(staff.businessId);
  return { rows: plan.rows.map((row) => shape(row, timezone)), canEnd: plan.canEnd };
}

export interface SeriesEndState {
  ok?: boolean;
  message?: string;
}

export async function endSeries(_previous: SeriesEndState, formData: FormData): Promise<SeriesEndState> {
  const staff = await requireStaff();
  const appointmentId = String(formData.get('appointmentId') ?? '');
  const reason = String(formData.get('reason') ?? '');

  // Required, and not ceremony: this takes several appointments away from one
  // client at once, and "why" is what the desk reads back to her on the phone
  // and what lands on every one of her records.
  if (!reason.trim()) return { ok: false, message: 'Say why — it goes in the log and on the client’s record.' };

  // D-32: unticked means tell her. The box is for the desk that rang her
  // first, so the texts do not contradict the person she just spoke to.
  const notify = formData.get('skipNotice') === null;

  // A-060's escape, for the whole action (checkpoint 5). Ticked means the
  // salon caused this — the stylist is leaving, or the standing slot is
  // moving — and none of it counts against her.
  const onUs = formData.get('onUs') !== null;

  const result = await endSeriesHere(prisma, {
    businessId: staff.businessId,
    appointmentId,
    reason,
    notify,
    onUs,
    actor: staffActor(staff.id),
    now: new Date(),
  });
  if (!result) return { ok: false, message: 'This appointment is not part of a standing booking.' };

  revalidatePath(`/staff/appointments/${appointmentId}`);
  revalidatePath('/staff/day');

  const timezone = await salonZone(staff.businessId);
  // D-26: name what did NOT happen. A message that only counted cancellations
  // would leave the one still in the chair quietly unhandled — which is the
  // half somebody has to act on next.
  const left = result.rows
    .filter((row) => row.problem)
    .map((row) => `${readableInstant(row.startAt, timezone)} (${PROBLEMS[row.problem!] ?? 'left as it was'})`)
    .join(', ');
  // Only when the desk did NOT take responsibility: with `onUs` every
  // occurrence lands `cancelled`, and reporting "3 inside the cancellation
  // window" after choosing "this one's on us" describes the opposite of what
  // was written.
  const late = onUs ? 0 : result.rows.filter((row) => !row.problem && row.insideCutoff).length;

  if (result.ended === 0) {
    return { ok: false, message: `Nothing was cancelled${left ? `: ${left}` : ''}.` };
  }

  return {
    ok: !left,
    message:
      `Cancelled ${result.ended} appointment${result.ended === 1 ? '' : 's'}` +
      (late > 0 ? `, ${late} inside the cancellation window` : '') +
      `. ${result.notified > 0 ? `${result.notified} message${result.notified === 1 ? '' : 's'} sent.` : 'No messages sent.'}` +
      (left ? ` Left as it was: ${left}.` : ''),
  };
}

// ─────────────────────────── internals ───────────────────────────

/** Why an occurrence is staying, in the salon's words. Each one is a different
 *  next action, so they are never collapsed into "could not". */
const PROBLEMS: Record<string, string> = {
  'already-happened': 'already happened',
  'in-the-chair': 'she is in the chair',
  'already-moved': 'somebody else just changed it',
};

function shape(row: EndSeriesRow, timezone: string): SeriesEndRow {
  return {
    appointmentId: row.appointmentId,
    when: readableInstant(row.startAt, timezone),
    insideCutoff: row.insideCutoff,
    ...(row.problem ? { problem: PROBLEMS[row.problem] ?? 'left as it was' } : {}),
  };
}

async function salonZone(businessId: string): Promise<string> {
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { timezone: true },
  });
  return business.timezone;
}
