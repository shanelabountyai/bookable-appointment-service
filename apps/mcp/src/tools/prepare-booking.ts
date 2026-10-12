/**
 * prepare_booking → commit_proposal → `bookAppointment` (PRD §7, §8).
 *
 * The preview asks the engine the exact question the write will ask — the
 * same `buildSlotQuery` with the client as holder, `audience: 'staff'` — and
 * refuses with the engine's own reasons if the instant is not offered. The
 * commit runs `bookAppointment` with the proposal id as `idempotencyKey`, so a
 * commit that is retried after a dropped connection returns the SAME
 * appointment rather than a second one. `mcpActor` puts the person's name on
 * the event and `mcp` in its channel.
 */
import { mcpActor } from '@bookable/core/auth';
import { type Instant, instant, toDate, toLabel } from '@bookable/core/time';
import { SlotNotOffered, bookAppointment } from '@bookable/db/booking';
import { qualifiedForVisit } from '@bookable/db/qualification';
import { buildSlotQuery, computeSlotsIn } from '@bookable/db/scheduling';
import { z } from 'zod';
import { ToolFailure } from '../errors';
import { parseInstant, timeOut } from '../time';
import { clientOf, providerOf, servicesOf } from './ids';
import { defineWrite } from './proposals';

export interface BookingCanonical {
  client_id: string;
  provider_id: string;
  service_ids: string[];
  /** The instant, as ISO with offset — never a wall time (D-4). */
  start: string;
  note: string | null;
  [key: string]: string | string[] | null;
}

export const bookingAction = defineWrite({
  name: 'prepare_booking',
  description:
    'Preview booking a visit for an existing client with a named stylist at a time from find_open_times. Checks the stylist can do every service, the client has no clash, and the time is still free. ' +
    'start is the iso value from find_open_times (or "YYYY-MM-DD HH:MM" in the salon\'s time). Staff rules apply, never an override. For a new client, prepare_new_client first.',
  inputSchema: {
    client_id: z.string().describe('From find_client or prepare_new_client\'s result.'),
    service_ids: z.array(z.string()).min(1).describe('In visit order, from list_services.'),
    provider_id: z.string().describe('From list_providers — a stylist, not "any".'),
    start: z.string().describe('The iso from find_open_times, or "YYYY-MM-DD HH:MM" salon time.'),
    note: z.string().max(500).optional().describe('A booking note for the desk, as the human said it.'),
  },
  outputSchema: {
    appointment_id: z.string(),
    start: z.object({ label: z.string(), iso: z.string() }),
    end: z.object({ label: z.string(), iso: z.string() }),
    status: z.string(),
    deduplicated: z.boolean().describe('True when this commit had already happened and the same appointment was returned.'),
  },
  async prepare(ctx, args, deps) {
    const db = deps.prisma;
    const services = await servicesOf(db, ctx.businessId, args.service_ids);
    const provider = await providerOf(db, ctx.businessId, args.provider_id);
    const client = await clientOf(db, ctx.businessId, args.client_id);
    const start = parseInstant(args.start, 'start', ctx.timezone);

    if (!(await qualifiedForVisit(db, { businessId: ctx.businessId, providerId: provider.id, serviceIds: args.service_ids }))) {
      throw new ToolFailure({
        error: 'NOT_QUALIFIED',
        message: `${provider.displayName} cannot do everything in this visit.`,
        field: 'provider_id',
        next: { tool: 'list_providers', why: 'pass these service_ids to see who can' },
      });
    }

    const slot = await offeredSlot(deps, ctx.businessId, provider.id, args.service_ids, client.id, start, ctx.timezone);
    const canonical: BookingCanonical = {
      client_id: client.id,
      provider_id: provider.id,
      service_ids: [...args.service_ids],
      start: timeOut(start, ctx.timezone).iso,
      note: args.note?.trim() || null,
    };
    const summary = `Book ${client.name ?? 'the client'} — ${services.map((s) => s.name).join(' + ')} with ${provider.displayName}, ${timeOut(slot.start, ctx.timezone).label}–${timeOut(slot.end, ctx.timezone).label.replace(/^.*, /, '')}.`;
    return { canonical, summary };
  },
  async commit(ctx, c, deps, proposalId) {
    const start = parseInstant(c.start, 'start', ctx.timezone);
    const booked = await bookAppointment(deps.prisma, {
      businessId: ctx.businessId,
      providerId: c.provider_id,
      serviceIds: c.service_ids,
      clientId: c.client_id,
      startAt: toDate(start),
      now: deps.now(),
      actor: mcpActor(ctx.staffUserId),
      audience: 'staff',
      idempotencyKey: `mcp:${proposalId}`,
      notes: c.note,
    });
    const s = timeOut(start, ctx.timezone);
    return {
      summary: `booked, ${s.label} (appointment ${booked.id}).`,
      data: {
        appointment_id: booked.id,
        start: s,
        end: timeOut(instant(start + (booked.endAt.getTime() - booked.startAt.getTime())), ctx.timezone),
        status: booked.status,
        deduplicated: booked.deduplicated,
      },
    };
  },
});

/** The engine's answer for this exact instant, or its reasons for refusing — never a guess. */
async function offeredSlot(
  deps: { prisma: Parameters<typeof buildSlotQuery>[0]; now: () => Date },
  businessId: string,
  providerId: string,
  serviceIds: string[],
  holderKey: string,
  start: Instant,
  zone: Parameters<typeof toLabel>[1],
) {
  const day = toLabel(start, zone).day;
  const built = await buildSlotQuery(deps.prisma, { businessId, providerId, serviceIds, day, now: deps.now(), audience: 'staff', holderKey });
  const result = computeSlotsIn(built, { explain: true });
  const slot = result.slots.find((s) => s.start === start);
  if (slot) return slot;
  const excluded = result.excluded.find((e) => e.candidateStart === start);
  if (excluded) throw new SlotNotOffered(excluded.reasons, [...result.slots]);
  // The engine only enumerates candidates inside working windows and on the grid, so an
  // instant it never considered is either outside hours or between grid points.
  const inWindow = result.meta.windowInstants.some((w) => start >= w.start && start < w.end);
  throw new SlotNotOffered([inWindow ? 'not-on-the-grid' : 'outside-working-window'], [...result.slots]);
}
