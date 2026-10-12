/**
 * "Is this exact instant offered?" — asked of the engine the way the write
 * will ask it (same `buildSlotQuery`, same holder, `audience: 'staff'`), with
 * `explain` on so a refusal carries the engine's reasons. Shared by
 * prepare_booking and prepare_reschedule; the latter passes
 * `excludeAppointmentId` so a visit may move within its own footprint.
 */
import { type Instant, type ZoneId, toLabel } from '@bookable/core/time';
import type { PrismaClient } from '@bookable/db';
import { SlotNotOffered } from '@bookable/db/booking';
import { buildSlotQuery, computeSlotsIn } from '@bookable/db/scheduling';

export async function offeredSlot(args: {
  prisma: PrismaClient;
  now: Date;
  businessId: string;
  providerId: string;
  serviceIds: readonly string[];
  holderKey: string | null;
  start: Instant;
  zone: ZoneId;
  excludeAppointmentId?: string;
}) {
  const day = toLabel(args.start, args.zone).day;
  const built = await buildSlotQuery(args.prisma, {
    businessId: args.businessId,
    providerId: args.providerId,
    serviceIds: args.serviceIds,
    day,
    now: args.now,
    audience: 'staff',
    holderKey: args.holderKey,
    ...(args.excludeAppointmentId ? { excludeAppointmentId: args.excludeAppointmentId } : {}),
  });
  const result = computeSlotsIn(built, { explain: true });
  const slot = result.slots.find((s) => s.start === args.start);
  if (slot) return slot;
  const excluded = result.excluded.find((e) => e.candidateStart === args.start);
  if (excluded) throw new SlotNotOffered(excluded.reasons, [...result.slots]);
  // The engine only enumerates candidates inside working windows and on the grid, so an
  // instant it never considered is either outside hours or between grid points.
  const inWindow = result.meta.windowInstants.some((w) => args.start >= w.start && args.start < w.end);
  throw new SlotNotOffered([inWindow ? 'not-on-the-grid' : 'outside-working-window'], [...result.slots]);
}
