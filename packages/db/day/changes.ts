/**
 * A-150 (C9, D-73) — "WHAT CHANGED ON MY COLUMN TODAY".
 *
 * OQ-24 answered (a): a MOVE, a PUSH, a REASSIGNMENT ONTO the column, or a
 * BOOKING INTO it. Never a status tap — a stylist who sees her own check-ins
 * flagged stops reading the marker, and then it cannot tell her the one thing
 * it exists for. The marker names who did it, so her own moves are
 * recognisable without being hidden from the desk.
 *
 * Read from `AppointmentEvent`, which already holds every one of these with
 * its actor (D-9) — no second record of "what changed", because a second
 * record is a second answer.
 */
import type { Actor } from '../../core/auth';
import { instantFromIso, toDate } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * The event types that count. A NEW WRITER OF ONE OF THESE KINDS OF CHANGE
 * (another way to move, push, reassign or book) must be added here, or its
 * change is silently not news — the "a state change is never one edit" rule.
 */
export const CHANGE_TYPES = ['booked', 'override_booked', 'rescheduled', 'column_pushed', 'provider_changed'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface DayChange {
  type: ChangeType;
  at: Date;
  actor: string;
  actorRef: string | null;
  /** Where it was before a move or push; null for a booking or a pure
   *  reassignment. */
  fromStartAt: Date | null;
  /** Whose column it came from, when that changed. */
  fromProviderId: string | null;
}

/**
 * The event rows, newest first, as changes.
 *
 * A reschedule that also changed the stylist writes TWO rows (D-31): a
 * `provider_changed` marked `viaReschedule` and a `rescheduled` carrying both
 * sides. The second already says everything, so the first is dropped here
 * rather than guessed apart by a shared `createdAt` downstream.
 */
export function toDayChanges(
  events: { type: string; createdAt: Date; actor: string; actorRef: string | null; payload: unknown }[],
): DayChange[] {
  return events.flatMap((e) => {
    if (!(CHANGE_TYPES as readonly string[]).includes(e.type)) return [];
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === 'provider_changed' && p.viaReschedule === true) return [];
    const moved = e.type === 'rescheduled' || e.type === 'column_pushed';
    return [
      {
        type: e.type as ChangeType,
        at: e.createdAt,
        actor: e.actor,
        actorRef: e.actorRef,
        fromStartAt: moved && typeof p.from === 'string' ? toDate(instantFromIso(p.from)) : null,
        fromProviderId: typeof p.fromProviderId === 'string' ? p.fromProviderId : null,
      },
    ];
  });
}

/**
 * The Print button's write. `providerId` null is the whole salon's sheet.
 * SEC-08: a providerId from another business is refused, not recorded.
 */
export async function recordSheetPrint(
  db: Db,
  args: { businessId: string; day: string; providerId: string | null; actor: Actor; now: Date },
): Promise<Date> {
  if (args.providerId) {
    const provider = await db.provider.findFirst({
      where: { id: args.providerId, businessId: args.businessId },
      select: { id: true },
    });
    if (!provider) throw new Error('That provider is not on this book.');
  }
  const row = await db.daySheetPrint.create({
    data: {
      businessId: args.businessId,
      day: args.day,
      providerId: args.providerId,
      actor: args.actor.type,
      actorRef: args.actor.ref,
      printedAt: args.now,
    },
    select: { printedAt: true },
  });
  return row.printedAt;
}

/**
 * When each column's paper was last made: the later of the whole-salon sheet
 * and her own. A key absent from the map has never been printed.
 */
export async function lastPrintedByProvider(
  db: Db,
  args: { businessId: string; day: string; providerIds: string[] },
): Promise<Map<string, Date>> {
  const rows = await db.daySheetPrint.groupBy({
    by: ['providerId'],
    where: { businessId: args.businessId, day: args.day },
    _max: { printedAt: true },
  });
  const everyone = rows.find((r) => r.providerId === null)?._max.printedAt ?? null;
  const own = new Map(rows.flatMap((r) => (r.providerId && r._max.printedAt ? [[r.providerId, r._max.printedAt]] : [])));
  return new Map(
    args.providerIds.flatMap((id) => {
      const candidates = [everyone, own.get(id) ?? null].filter((d): d is Date => d !== null);
      if (candidates.length === 0) return [];
      return [[id, candidates.reduce((a, b) => (a > b ? a : b))]];
    }),
  );
}
