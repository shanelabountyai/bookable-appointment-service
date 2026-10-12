/**
 * prepare_cancel and prepare_status_change → commit_proposal →
 * `transitionAppointment`. Both previews ask the transition table with the
 * detail page's context; both commits pass `expectedFrom` so a status that
 * moved between preview and commit is `PROPOSAL_STALE`, never overwritten.
 *
 * Cancellation is `cancellation: 'derive'` — the machine decides `cancelled`
 * vs `cancelled_late` from the cutoff and the clock (A-060), and the preview
 * says which before anybody commits. `tell_client` defaults to true (D-32).
 */
import { mcpActor } from '@bookable/core/auth';
import { type AppointmentStatus, canCancel, canTransition, staffCancellationStatus } from '@bookable/core/scheduling';
import { fromDate } from '@bookable/core/time';
import { TransitionRefused, loadAppointmentDetail, transitionAppointment } from '@bookable/db/appointments';
import { reliabilityFor } from '@bookable/db/clients';
import { toLabel } from '@bookable/core/time';
import { z } from 'zod';
import { notFound } from '../errors';
import { timeOutOf } from '../time';
import { STATUS_ACTIONS } from './get-appointment';
import { defineWrite } from './proposals';

const TO = ['checked_in', 'in_progress', 'completed', 'no_show'] as const;

async function detailOf(deps: { prisma: Parameters<typeof loadAppointmentDetail>[0] }, businessId: string, id: string) {
  const detail = await loadAppointmentDetail(deps.prisma, { businessId, appointmentId: id });
  if (!detail) throw notFound('appointment', 'appointment_id', 'get_day');
  return detail;
}

const contextFor = (detail: Awaited<ReturnType<typeof loadAppointmentDetail>> & object, now: Date, reason: string | null) => ({
  actor: 'staff' as const,
  now: fromDate(now),
  startAt: fromDate(detail.startAt),
  endAt: fromDate(detail.endAt),
  cancellationCutoffMinutes: detail.cancellationCutoffMinutes,
  reason,
});

const describe = (detail: { clientName: string | null; services: { name: string }[]; providerName: string }) =>
  `${detail.clientName ?? 'the walk-in'} — ${detail.services.map((s) => s.name).join(' + ')} with ${detail.providerName}`;

export interface CancelCanonical {
  appointment_id: string;
  reason: string;
  tell_client: boolean;
  expected_from: string;
  [key: string]: string | boolean;
}

export const cancelAction = defineWrite({
  name: 'prepare_cancel',
  description:
    'Preview cancelling an appointment. A reason is required. Whether it counts as a late cancellation is decided by the cutoff and the clock, and the summary says which. ' +
    'tell_client defaults to true: the client is told by text (D-32); pass false only when the human says not to.',
  inputSchema: {
    appointment_id: z.string(),
    reason: z.string().min(1).max(300).describe('Why, as the human said it. Goes in the log and, if tell_client, in the message.'),
    tell_client: z.boolean().optional().describe('Default true.'),
  },
  outputSchema: {
    appointment_id: z.string(),
    status: z.string(),
    client_told: z.boolean(),
  },
  async prepare(ctx, args, deps) {
    const detail = await detailOf(deps, ctx.businessId, args.appointment_id);
    const status = detail.status as AppointmentStatus;
    const reason = args.reason.trim();
    const context = contextFor(detail, deps.now(), reason);
    if (!canCancel(status, context)) {
      const d = canTransition(status, 'cancelled', context);
      throw new TransitionRefused(status, 'cancelled', d.allowed ? 'not-permitted' : d.refusal);
    }
    const as = staffCancellationStatus(status, context);
    const tell = args.tell_client ?? true;
    const canonical: CancelCanonical = { appointment_id: detail.id, reason, tell_client: tell, expected_from: status };
    const first = (detail.clientName ?? '').split(' ')[0] || 'The client';
    const summary =
      `Cancel ${describe(detail)}, ${timeOutOf(detail.startAt, ctx.timezone).label} (${reason}).` +
      (as === 'cancelled_late' ? ' Counts as a late cancellation.' : '') +
      (tell ? ` ${first} will be texted.` : ` ${first} will not be told.`);
    return { canonical, summary };
  },
  async commit(ctx, c, deps) {
    const result = await transitionAppointment(deps.prisma, {
      businessId: ctx.businessId,
      appointmentId: c.appointment_id,
      to: 'cancelled',
      cancellation: 'derive',
      actor: mcpActor(ctx.staffUserId),
      now: deps.now(),
      reason: c.reason,
      notify: c.tell_client,
      expectedFrom: c.expected_from as AppointmentStatus,
    });
    return { summary: `${result.to.replace('_', ' ')}.`, data: { appointment_id: result.id, status: result.to, client_told: c.tell_client } };
  },
});

export interface StatusCanonical {
  appointment_id: string;
  to: (typeof TO)[number];
  expected_from: string;
  [key: string]: string;
}

export const statusChangeAction = defineWrite({
  name: 'prepare_status_change',
  description:
    'Preview moving an appointment along the day: checked_in (arrived), in_progress (in the chair), completed (finished), or no_show. ' +
    'Only moves the transition table allows right now are accepted — get_appointment\'s allowed_actions lists them. Cancelling is prepare_cancel.',
  inputSchema: {
    appointment_id: z.string(),
    to: z.enum(TO),
  },
  outputSchema: {
    appointment_id: z.string(),
    from: z.string(),
    to: z.string(),
  },
  async prepare(ctx, args, deps) {
    const detail = await detailOf(deps, ctx.businessId, args.appointment_id);
    const status = detail.status as AppointmentStatus;
    const decision = canTransition(status, args.to, contextFor(detail, deps.now(), 'placeholder'));
    if (!decision.allowed) throw new TransitionRefused(status, args.to, decision.refusal);

    let summary: string;
    if (args.to === 'no_show') {
      const today = toLabel(fromDate(deps.now()), ctx.timezone).day;
      const count = detail.clientId ? (await reliabilityFor(deps.prisma, { businessId: ctx.businessId, clientId: detail.clientId, today })).noShows + 1 : 1;
      summary = `Mark ${describe(detail)}, ${timeOutOf(detail.startAt, ctx.timezone).label}, as a no-show${detail.clientId ? ` (their ${ordinal(count)} in 12 months)` : ''}.`;
    } else {
      const verb = { checked_in: 'checked in', in_progress: 'in the chair', completed: 'finished' }[args.to];
      summary = `Mark ${describe(detail)} as ${verb}.`;
    }
    const canonical: StatusCanonical = { appointment_id: detail.id, to: args.to, expected_from: status };
    return { canonical, summary };
  },
  async commit(ctx, c, deps) {
    const result = await transitionAppointment(deps.prisma, {
      businessId: ctx.businessId,
      appointmentId: c.appointment_id,
      to: c.to,
      actor: mcpActor(ctx.staffUserId),
      now: deps.now(),
      expectedFrom: c.expected_from as AppointmentStatus,
    });
    return { summary: `${STATUS_ACTIONS[c.to].replace('_', ' ')} — now ${result.to}.`, data: { appointment_id: result.id, from: result.from, to: result.to } };
  },
});

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
