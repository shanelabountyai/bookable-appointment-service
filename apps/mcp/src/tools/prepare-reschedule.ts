/**
 * prepare_reschedule → commit_proposal → `rescheduleAppointment` (D-6: a
 * same-row UPDATE in one transaction; D-31: the stylist may change, nothing
 * may override). The preview asks `canReschedule` and the engine; the commit
 * runs the real function, which asks them again.
 */
import { mcpActor } from '@bookable/core/auth';
import { type AppointmentStatus, canReschedule } from '@bookable/core/scheduling';
import { fromDate, toDate } from '@bookable/core/time';
import { RescheduleRefused, loadAppointmentDetail, rescheduleAppointment } from '@bookable/db/appointments';
import { qualifiedForVisit } from '@bookable/db/qualification';
import { z } from 'zod';
import { ToolFailure, notFound } from '../errors';
import { parseInstant, timeOut, timeOutOf } from '../time';
import { providerOf } from './ids';
import { offeredSlot } from './offered';
import { defineWrite } from './proposals';

export interface RescheduleCanonical {
  appointment_id: string;
  start: string;
  provider_id: string | null;
  [key: string]: string | null;
}

const timeShape = z.object({ label: z.string(), iso: z.string() });

export const rescheduleAction = defineWrite({
  name: 'prepare_reschedule',
  description:
    'Preview moving an appointment to a new time, optionally to a different stylist (never an override). Checks the appointment can still be moved, the stylist can do the visit, and the new time is free for this client. ' +
    'start is an iso from find_open_times or "YYYY-MM-DD HH:MM" salon time. Get appointment_id from get_day or get_client_history.',
  inputSchema: {
    appointment_id: z.string(),
    start: z.string().describe('The new start: iso from find_open_times, or "YYYY-MM-DD HH:MM" salon time.'),
    provider_id: z.string().optional().describe('A different stylist, from list_providers. Omit to keep the same one.'),
  },
  outputSchema: {
    appointment_id: z.string(),
    from: timeShape,
    to: timeShape,
    end: timeShape,
    provider_id: z.string(),
  },
  async prepare(ctx, args, deps) {
    const db = deps.prisma;
    const detail = await loadAppointmentDetail(db, { businessId: ctx.businessId, appointmentId: args.appointment_id });
    if (!detail) throw notFound('appointment', 'appointment_id', 'get_day');
    const status = detail.status as AppointmentStatus;
    const decision = canReschedule(status, {
      actor: 'staff',
      now: fromDate(deps.now()),
      startAt: fromDate(detail.startAt),
      endAt: fromDate(detail.endAt),
      cancellationCutoffMinutes: detail.cancellationCutoffMinutes,
    });
    if (!decision.allowed) throw new RescheduleRefused(status, decision.refusal);

    const provider = args.provider_id ? await providerOf(db, ctx.businessId, args.provider_id) : { id: detail.providerId, displayName: detail.providerName };
    const serviceIds = detail.services.map((s) => s.serviceId);
    if (provider.id !== detail.providerId && !(await qualifiedForVisit(db, { businessId: ctx.businessId, providerId: provider.id, serviceIds }))) {
      throw new ToolFailure({
        error: 'NOT_QUALIFIED',
        message: `${provider.displayName} cannot do everything in this visit.`,
        field: 'provider_id',
        next: { tool: 'list_providers', why: 'pass this visit\'s service ids to see who can' },
      });
    }

    const start = parseInstant(args.start, 'start', ctx.timezone);
    const slot = await offeredSlot({
      prisma: db,
      now: deps.now(),
      businessId: ctx.businessId,
      providerId: provider.id,
      serviceIds,
      holderKey: detail.clientId,
      start,
      zone: ctx.timezone,
      excludeAppointmentId: detail.id,
    });

    const who = detail.clientName ?? 'the walk-in';
    const from = timeOutOf(detail.startAt, ctx.timezone).label;
    const to = timeOut(slot.start, ctx.timezone).label;
    const stylist = provider.id === detail.providerId ? `with ${detail.providerName}` : `from ${detail.providerName} to ${provider.displayName}`;
    const canonical: RescheduleCanonical = {
      appointment_id: detail.id,
      start: timeOut(start, ctx.timezone).iso,
      provider_id: provider.id === detail.providerId ? null : provider.id,
    };
    return { canonical, summary: `Move ${who} — ${detail.services.map((s) => s.name).join(' + ')} ${stylist}, ${from} → ${to}.` };
  },
  async commit(ctx, c, deps) {
    const start = parseInstant(c.start, 'start', ctx.timezone);
    const moved = await rescheduleAppointment(deps.prisma, {
      businessId: ctx.businessId,
      appointmentId: c.appointment_id,
      startAt: toDate(start),
      now: deps.now(),
      actor: mcpActor(ctx.staffUserId),
      toProviderId: c.provider_id,
      audience: 'staff',
    });
    const row = await deps.prisma.appointment.findUniqueOrThrow({ where: { id: moved.id }, select: { providerId: true } });
    const to = timeOutOf(moved.to, ctx.timezone);
    return {
      summary: `moved to ${to.label}.`,
      data: { appointment_id: moved.id, from: timeOutOf(moved.from, ctx.timezone), to, end: timeOutOf(moved.endAt, ctx.timezone), provider_id: row.providerId },
    };
  },
});
