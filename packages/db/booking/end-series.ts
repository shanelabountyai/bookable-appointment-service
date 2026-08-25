/**
 * A-057 — "END THIS SERIES HERE" (D-39, overturning D-35's no-bulk-cancel).
 *
 * The structural argument, which is the whole item: **creating six
 * appointments is one action and undoing them is six**, and a product where
 * the undo costs six times the create teaches the desk not to use the create.
 * Mrs Kerr rings on a Saturday to end her standing Tuesday; D-35 sent the desk
 * through six detail pages, so they do two, mean to come back to it, and four
 * 2pm Tuesdays are held for somebody who is never coming — then land as four
 * no-shows on a record that were the salon's fault.
 *
 * WHAT "HERE" MEANS: this occurrence and every one after it. D-35's own
 * objection was "which ones did you mean, the future ones or all of them", and
 * D-39's answer is that there is no third reading — past occurrences already
 * happened and cancelled ones are already cancelled, so both are untouched.
 * Inclusive of the one being viewed, because the other thing this action
 * answers is "move my standing 2pm to 2:30 from now on": end here, rebook from
 * here, and a viewed occurrence left at 2pm would collide with the rebooking.
 *
 * PARTIAL AND SELF-DESCRIBING (D-26), like every other bulk action here. An
 * occurrence that cannot be cancelled in bulk stays in the book and is NAMED,
 * with the reason, in the same preview the desk approves.
 *
 * NOT ONE TRANSACTION, for D-34's reason turned around: wrapping six
 * cancellations in one would make the fifth one's lost race roll back the four
 * that already committed — an all-or-nothing refusal, which is the behaviour
 * D-26 rejected. Each occurrence goes through `transitionAppointment`
 * UNCHANGED, so the status write, the event and the outbox row stay in the one
 * transaction that matters, and there is no second way to cancel anything.
 */
import {
  type AppointmentStatus,
  ACTIVE_STATUSES,
  canEndSeriesAt,
  isInsideCancellationCutoff,
} from '../../core/scheduling';
import { worstCutoff } from '../../core/settings';
import { type Actor } from '../../core/auth';
import { fromDate } from '../../core/time';
import { AppointmentMovedFirst, TransitionRefused, transitionAppointment } from '../appointments/transition';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

/** Why an occurrence in the window is not going to be cancelled. Each one is a
 *  different next action for the desk, so they are never folded into one. */
export type EndSeriesProblem =
  /** Completed or a no-show: it is a fact, not a plan. */
  | 'already-happened'
  /** Checked in or in the chair. Cancelling this one is a walk-out, typed
   *  against the appointment in front of you — not a side effect of a bulk
   *  action (`SERIES_CANCELLABLE_STATUSES`). */
  | 'in-the-chair'
  /** Somebody moved it between the preview and the button. */
  | 'already-moved';

export interface EndSeriesRow {
  appointmentId: string;
  startAt: Date;
  clientName: string | null;
  /**
   * True when this occurrence falls inside its own cancellation cutoff and
   * will therefore be recorded as `cancelled_late` (D-19: the strictest of the
   * business default and every service on the visit). Shown in the preview
   * because the desk is about to say it out loud on the phone — and it differs
   * row by row, which is exactly what made D-35 think this action was
   * impossible rather than that it needed a preview.
   */
  insideCutoff: boolean;
  problem?: EndSeriesProblem;
}

export interface EndSeriesPlan {
  seriesId: string;
  rows: EndSeriesRow[];
  /** True when at least one occurrence can actually be cancelled. */
  canEnd: boolean;
}

interface PlanArgs {
  businessId: string;
  /** The occurrence being viewed — "here". */
  appointmentId: string;
  now: Date;
}

/**
 * What ending it here would do, without doing it.
 *
 * Returns null when this appointment is not part of a series at all, which is
 * the ordinary case and not an error.
 *
 * The action below calls THIS function, so the preview cannot disagree with
 * the outcome — the failure mode a separate "check" function always eventually
 * develops (A-018 learned it first).
 */
export async function previewEndSeries(
  db: Prisma.TransactionClient | PrismaClient,
  args: PlanArgs,
): Promise<EndSeriesPlan | null> {
  const here = await db.appointment.findFirst({
    where: { id: args.appointmentId, businessId: args.businessId },
    select: { seriesId: true, startAt: true, business: { select: { cancellationCutoffMinutes: true } } },
  });
  if (!here?.seriesId) return null;

  const occurrences = await db.appointment.findMany({
    where: {
      seriesId: here.seriesId,
      businessId: args.businessId,
      // FROM HERE, on the instant axis. Already-cancelled occurrences are
      // excluded by the status filter rather than by a second cancel that
      // would write a second event and a second text about the same fact.
      startAt: { gte: here.startAt },
      status: { in: [...ACTIVE_STATUSES] },
    },
    orderBy: { startAt: 'asc' },
    select: {
      id: true,
      status: true,
      startAt: true,
      endAt: true,
      client: { select: { name: true } },
      lines: { select: { service: { select: { id: true, name: true, cancellationCutoffMinutes: true } } } },
    },
  });

  const rows = occurrences.map((occurrence) => {
    const status = occurrence.status as AppointmentStatus;
    // D-19, resolved per occurrence: a series of cut-and-colours may carry a
    // longer notice than the business default, and only some of the remaining
    // weeks are inside it.
    const cutoff = worstCutoff(
      here.business.cancellationCutoffMinutes,
      occurrence.lines.map((l) => ({
        id: l.service.id,
        name: l.service.name,
        cancellationCutoffMinutes: l.service.cancellationCutoffMinutes,
      })),
    );

    return {
      appointmentId: occurrence.id,
      startAt: occurrence.startAt,
      clientName: occurrence.client?.name ?? null,
      insideCutoff: isInsideCancellationCutoff({
        actor: 'staff',
        now: fromDate(args.now),
        startAt: fromDate(occurrence.startAt),
        endAt: fromDate(occurrence.endAt),
        cancellationCutoffMinutes: cutoff.minutes,
      }),
      ...(canEndSeriesAt(status) ? {} : { problem: problemFor(status) }),
    } satisfies EndSeriesRow;
  });

  return { seriesId: here.seriesId, rows, canEnd: rows.some((r) => !r.problem) };
}

export interface EndSeriesResult extends EndSeriesPlan {
  ended: number;
  /** How many clients were actually told. Zero when the desk ticked "I've
   *  already rung them" — reported either way, because "and nobody was told"
   *  is the half of a bulk cancellation somebody has to act on. */
  notified: number;
}

export interface EndSeriesInput extends PlanArgs {
  actor: Actor;
  /** Typed ONCE for the whole action, and it lands on every occurrence's event
   *  and in every client's message — this is what the desk reads back on the
   *  phone. */
  reason: string;
  /** D-32: unticked means tell her. `false` = "I've already rung them". */
  notify?: boolean;
}

export async function endSeriesHere(prisma: PrismaClient, input: EndSeriesInput): Promise<EndSeriesResult | null> {
  const plan = await previewEndSeries(prisma, input);
  if (!plan) return null;

  let ended = 0;
  for (const row of plan.rows) {
    if (row.problem) continue;
    try {
      await transitionAppointment(prisma, {
        appointmentId: row.appointmentId,
        // The cutoff answer from the plan, so the status written is the one
        // the desk was shown. §7 lets staff write either unconditionally, so
        // nothing downstream re-decides this.
        to: row.insideCutoff ? 'cancelled_late' : 'cancelled',
        actor: input.actor,
        now: input.now,
        reason: input.reason,
        ...(input.notify === undefined ? {} : { notify: input.notify }),
      });
      ended += 1;
    } catch (error) {
      // Two people at the front desk on a Saturday is ordinary, not exotic:
      // one occurrence moved under us is not a reason to abandon the other
      // five. Anything else is re-thrown — a bulk action that swallowed a
      // database failure would be the silent loss this item removes.
      if (error instanceof AppointmentMovedFirst || error instanceof TransitionRefused) {
        row.problem = 'already-moved';
        continue;
      }
      throw error;
    }
  }

  return { ...plan, ended, notified: input.notify === false ? 0 : ended };
}

function problemFor(status: AppointmentStatus): EndSeriesProblem {
  return status === 'checked_in' || status === 'in_progress' ? 'in-the-chair' : 'already-happened';
}
