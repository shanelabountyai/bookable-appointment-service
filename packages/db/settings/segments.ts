/**
 * Segment persistence (SEG-01, A-029). `packages/core/settings/segments.ts`
 * decides whether a segment list is legal; this file reads and writes it, and
 * re-runs validation here rather than trusting the caller — same reasoning as
 * the rest of A-006/A-025.
 */
import { type Segment, sumSegmentMinutes, validateSegmentStructure } from '../../core/settings';
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { ServiceRejected } from './services';

type Db = Prisma.TransactionClient | PrismaClient;

export interface SegmentRow extends Segment {
  id: string;
  ordinal: number;
}

const select = { id: true, ordinal: true, durationMinutes: true, isGap: true } as const;

export async function listSegments(db: Db, serviceId: string): Promise<SegmentRow[]> {
  return db.serviceSegment.findMany({
    where: { serviceId, status: 'active' },
    orderBy: { ordinal: 'asc' },
    select,
  });
}

/** Every segmented service in the business, keyed by service id. Services with
 *  no rows are simply absent — a caller reads that as "one implicit segment". */
export async function segmentsByService(db: Db, businessId: string): Promise<Map<string, SegmentRow[]>> {
  const rows = await db.serviceSegment.findMany({
    where: { businessId, status: 'active' },
    orderBy: [{ serviceId: 'asc' }, { ordinal: 'asc' }],
    select: { ...select, serviceId: true },
  });
  const byService = new Map<string, SegmentRow[]>();
  for (const { serviceId, ...row } of rows) {
    const list = byService.get(serviceId);
    if (list) list.push(row);
    else byService.set(serviceId, [row]);
  }
  return byService;
}

/**
 * Replace a service's segments wholesale, and set the service's duration from
 * them. An empty list makes the service unsegmented again, leaving the duration
 * where it is.
 *
 * THE PARTS ARE THE SOURCE OF THE TOTAL for a segmented service, written in one
 * transaction so the sum invariant (SEG-01) holds by construction rather than
 * by anyone remembering. The alternative — validating the proposed parts
 * against the stored duration — deadlocks: the duration guard on `updateService`
 * refuses a total that disagrees with the parts, so a segmented service could
 * never be made longer or shorter by any sequence of edits. A db test caught
 * that; it would otherwise have surfaced as an owner who could not lengthen a
 * colour.
 *
 * Delete-then-insert rather than a diff: nothing references a `ServiceSegment`
 * (D-18 snapshots duration onto the appointment line at booking time), the
 * lists are three rows long, and a diff would be more code for an identical
 * result.
 */
export async function replaceSegments(
  db: Db,
  businessId: string,
  serviceId: string,
  segments: readonly Segment[],
): Promise<SegmentRow[]> {
  const violations = validateSegmentStructure(segments);
  if (violations.length > 0) throw new ServiceRejected(violations[0]!.field, violations[0]!.message);

  await db.serviceSegment.deleteMany({ where: { serviceId } });
  if (segments.length > 0) {
    await db.serviceSegment.createMany({
      data: segments.map((segment, ordinal) => ({
        businessId,
        serviceId,
        ordinal,
        durationMinutes: segment.durationMinutes,
        isGap: segment.isGap,
      })),
    });
    await db.service.update({
      where: { id: serviceId },
      data: { durationMinutes: sumSegmentMinutes(segments) },
    });
  }
  return listSegments(db, serviceId);
}
