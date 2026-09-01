/**
 * THE ROOM'S BUSY SET (A-032, RES-03, D-30).
 *
 * The provider axis asks "is Dana free?" and gets a yes/no per interval. The
 * resource axis asks a CARDINALITY question — "are all four chairs taken?" —
 * and that is the whole reason it needed its own machinery at the database
 * (D-30) and needs its own machinery here.
 *
 * The engine must stay a pure function of intervals and must never learn what
 * a chair is, so this module collapses the cardinality question back into
 * intervals before the engine ever sees it: the spans in which the count of
 * concurrent holds reaches the number of chairs. Those go in as busy intervals
 * of kind `resource-full`, exactly the way D-22's overrun does, and the engine
 * subtracts them without knowing why.
 *
 * WHY THIS EXISTS AT ALL: before A-030 the room could not fill, because a
 * client occupied a chair only while her provider was working — four stylists
 * meant at most four clients. Gap booking broke that on purpose (SEG-04): a
 * colour holds its chair through the developing hour while the stylist takes
 * somebody else, so four stylists can seat eight clients in four chairs. The
 * database has refused the fifth since A-031. Until this module existed, the
 * refusal arrived at SUBMIT, on a time the screen had just offered — the
 * offered-then-refused defect this repo has already caught twice.
 */
import { ACTIVE_STATUSES } from '../../core/scheduling';
import { type Instant, fromDate, instant } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface Span {
  start: Instant;
  end: Instant;
}

/** A hold, with the chair it is on — because after A-063 two holds can be one
 *  chair, and the room's capacity question is about CHAIRS. */
export interface ChairHold extends Span {
  resourceId: string;
}

/**
 * The spans in which every chair is taken — i.e. the room is full and the next
 * client cannot be seated.
 *
 * COUNTS CHAIRS, NOT HOLDS, and that distinction is the whole of checkpoint 5's
 * third finding. A-063 made one client's two appointments share a single chair
 * through the buffers between them, so from that moment "how many holds
 * overlap" and "how many chairs are occupied" stopped being the same number.
 * Counting holds declared a four-chair room full with three chairs in use and
 * refused a real client — which is the exact harm A-063's row set out to
 * remove, still alive on the surface that decides whether a time is OFFERED.
 *
 * Half-open `[start, end)` on both sides, like everything else in this project:
 * a hold ending at 11:00 frees its chair for one starting at 11:00, so the end
 * event is processed BEFORE the start event at the same instant. With `'[]'`
 * the salon would lose a seating at every boundary — the same defect the
 * exclusion constraint would have had.
 *
 * Returns nothing for `capacity <= 0`; a type with no active resources is not
 * "never full", it is ALWAYS full, and the caller handles that case explicitly
 * because it needs the query window to express it.
 */
export function fullSpans(holds: readonly ChairHold[], capacity: number): Span[] {
  if (capacity <= 0) return [];

  const events: { t: number; delta: number; resourceId: string }[] = [];
  for (const h of holds) {
    // A zero-width hold occupies nothing. Overrides hold no chair at all
    // (D-30), so this should not arise — but a hold that did slip through
    // would otherwise open and close a full span at the same instant.
    if (h.end <= h.start) continue;
    events.push({ t: h.start, delta: 1, resourceId: h.resourceId }, { t: h.end, delta: -1, resourceId: h.resourceId });
  }
  // `delta` ascending breaks the tie so -1 lands before +1.
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);

  const spans: Span[] = [];
  // Holds open per chair. A chair counts ONCE however many of one client's
  // holds are sitting on it; `occupied` is how many chairs have at least one.
  const perChair = new Map<string, number>();
  let occupied = 0;
  let openedAt: number | null = null;
  for (const e of events) {
    const before = perChair.get(e.resourceId) ?? 0;
    const after = before + e.delta;
    perChair.set(e.resourceId, after);
    if (before === 0 && after > 0) occupied += 1;
    else if (before > 0 && after === 0) occupied -= 1;

    if (openedAt === null && occupied >= capacity) openedAt = e.t;
    else if (openedAt !== null && occupied < capacity) {
      spans.push({ start: instant(openedAt), end: instant(e.t) });
      openedAt = null;
    }
  }
  return spans;
}

/**
 * Busy intervals for "every chair of this type is taken", over the query
 * window.
 *
 * Reads `AppointmentResourceHold`, which spans each appointment's WHOLE
 * envelope including its gaps (RES-02) — that is the entire difference from
 * `findBusyAppointments`, which reads the per-worked-span blocks. Provider
 * occupancy and chair occupancy are different sets and this is where the
 * difference lives.
 *
 * `excludeAppointmentId` is here for the same reason it is on the busy set: an
 * appointment being moved must not count its own chair against its own
 * destination, or a full room would make every reschedule impossible.
 */
export async function findRoomFullIntervals(
  db: Db,
  args: {
    businessId: string;
    resourceTypeId: string;
    windowStart: Date;
    windowEnd: Date;
    excludeAppointmentId?: string | null;
  },
): Promise<Span[]> {
  // Capacity is ACTIVE resources only. A chair taken out of service reduces the
  // room, and a hold still sitting on it (booked before it was deactivated) is
  // excluded from the count below for the same reason — otherwise a retired
  // chair both shrinks the room and fills it.
  const capacity = await db.resource.count({
    where: { businessId: args.businessId, resourceTypeId: args.resourceTypeId, active: true },
  });

  // A required type with no chairs at all: nothing is bookable, and the whole
  // window is full. Reporting this as an ordinary busy interval keeps the one
  // answer the caller can act on — no slots — instead of an error on a screen
  // that has no way to explain it.
  if (capacity === 0) return [{ start: fromDate(args.windowStart), end: fromDate(args.windowEnd) }];

  const holds = await db.appointmentResourceHold.findMany({
    where: {
      businessId: args.businessId,
      status: { in: [...ACTIVE_STATUSES] },
      resource: { resourceTypeId: args.resourceTypeId, active: true },
      // Instant-overlap, never a date filter — the 23:30 hold running past
      // midnight belongs to both days (the busy-set trap, same shape).
      blockedStart: { lt: args.windowEnd },
      blockedEnd: { gt: args.windowStart },
      ...(args.excludeAppointmentId ? { appointmentId: { not: args.excludeAppointmentId } } : {}),
    },
    select: { blockedStart: true, blockedEnd: true, resourceId: true },
  });

  return fullSpans(
    holds.map((h) => ({
      start: fromDate(h.blockedStart),
      end: fromDate(h.blockedEnd),
      resourceId: h.resourceId,
    })),
    capacity,
  );
}
