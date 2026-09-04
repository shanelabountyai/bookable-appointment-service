/**
 * THE ROOM'S BUSY SET (A-032, RES-03, D-30).
 *
 * The provider axis asks "is Dana free?" and gets a yes/no per interval. The
 * resource axis asks a SEATING question — "is there a chair this visit can sit
 * in, start to finish?" — and that is the whole reason it needed its own
 * machinery at the database (D-30) and needs its own machinery here.
 *
 * WHY THIS EXISTS AT ALL: before A-030 the room could not fill, because a
 * client occupied a chair only while her provider was working — four stylists
 * meant at most four clients. Gap booking broke that on purpose (SEG-04): a
 * colour holds its chair through the developing hour while the stylist takes
 * somebody else, so four stylists can seat eight clients in four chairs. The
 * database has refused the fifth since A-031. Until this module existed, the
 * refusal arrived at SUBMIT, on a time the screen had just offered — the
 * offered-then-refused defect this repo keeps catching.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEMO CHECKPOINT 6 (A-082) — WHY THIS IS NO LONGER A CARDINALITY QUESTION.
 *
 * Until A-082 this module answered "are all four chairs occupied at some
 * instant inside the envelope?", collapsed the answer into busy intervals, and
 * handed them to the engine. That question is NECESSARY and NOT SUFFICIENT,
 * and the difference is a real Saturday:
 *
 *     wanted 14:15–14:40      chair 1  ▓▓▓▓ 14:30–15:05
 *                             chair 2  ▓▓▓▓▓▓▓▓ 14:15–14:40
 *                             chair 3  ▓▓▓▓▓▓▓▓ 14:05–16:35
 *                             chair 4  ▓▓▓▓ 13:45–14:20
 *
 * Three chairs are taken at every instant and never four, so the room was
 * never "full" and the time was OFFERED — and there is no single chair free
 * for the whole twenty-five minutes, so `findFreeResource` returned null and
 * the write refused it with `NoResourceFree`. Permanently: not a race, not a
 * near miss. She picks the time, is told to pick another, and it is still
 * there when the list refreshes.
 *
 * A COUNT ASSUMES THE ROOM CAN BE RESHUFFLED. It cannot — a client is in a
 * physical chair and stays in it. So this module now asks the question the
 * CHOOSER asks, in the chooser's own words: is there a chair with no hold
 * that would take it? `canSeat` mirrors `findFreeResource`'s two arms line for
 * line, for the same reason A-063 made those two arms mirror the two exclusion
 * constraints — a read model that PREDICTS a chooser's answer must ask the
 * chooser's question, not a weaker one that happens to imply it.
 *
 * It cannot be an interval set, and that is provable rather than a matter of
 * taste: with the envelope above, the infeasible starts are a 15-minute window
 * and the envelope is 25 minutes long, so no set of intervals the engine
 * subtracts by overlap can name it. Hence a filter over candidate slots
 * (`slot-query.ts`) rather than another `BusyInterval` kind.
 */
import { ACTIVE_STATUSES } from '../../core/scheduling';
import { type Instant, fromDate } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface Span {
  start: Instant;
  end: Instant;
}

/**
 * A span the shared predicate below can compare, whether or not the caller has
 * kept the `Instant` brand. Epoch millis either way — the push carries plain
 * numbers because its spans are `fromDate(x) + shift` — and comparing two
 * numbers is the one operation on this axis that cannot cross to the other:
 * a `WallTime` is a string and never reaches here. (A-084)
 */
interface Range {
  start: number;
  end: number;
}

/**
 * One chair's hold, with everything the chooser's predicate reads.
 *
 * The ENVELOPE (`start`/`end`) is buffers and gaps included (RES-02); the BODY
 * is the visit itself. A-063 made those two different questions — envelopes may
 * overlap for ONE holder, bodies never overlap for anyone — and A-069's release
 * cuts the envelope without touching the body, so neither can be derived from
 * the other here.
 */
export interface ChairHold extends Span {
  resourceId: string;
  /** `clientId`, or `appt:<id>` for a walk-in nobody has keyed. Written by the
   *  hold trigger; never derived a second time. */
  holderKey: string;
  bodyStart: Instant;
  bodyEnd: Instant;
}

/** The room over one query window: which chairs are in service, and what is
 *  already sitting in them. */
export interface Seating {
  resourceTypeId: string;
  /** ACTIVE chairs only. A chair taken out of service shrinks the room; a hold
   *  still sitting on it is excluded below for the same reason, or a retired
   *  chair would both shrink the room and fill it. */
  chairIds: readonly string[];
  holds: readonly ChairHold[];
}

/**
 * ONE HOLD, ONE CHAIR: does it block this visit?
 *
 * THE ONLY COPY OF THE ROOM RULE (A-084). Three places have to answer the same
 * operational question — `findFreeResource` (what the WRITE accepts, a Prisma
 * `where` and so unavoidably a fourth expression of it), `canSeat` below (what
 * the SCREEN offers) and `planChairs` in `day/push-column.ts` (where the push
 * SEATS a moved column, in memory and deliberately not at the database). The
 * last two now call this; the first mirrors it line for line and says so, and
 * `room-rule.test.ts` puts a room in a state and asserts all three AGREE.
 *
 * They were three separate expressions until A-084, and the push's was written
 * as `E && (D || B)` where these are `(E && D) || B`. Those agree only where a
 * body overlap implies an envelope overlap — true, because the hold trigger
 * keeps the body inside the envelope on every branch including A-069's release
 * cut, guarded by a CHECK in a migration three files away and asserted nowhere
 * in TypeScript. Two correct-looking halves agreeing for a reason nobody wrote
 * down is the precondition of checkpoint 6; sharing the predicate removes it.
 *
 * - Envelopes may overlap only for the SAME holder (`holderKey WITH <>`): her
 *   own buffers, her own chair.
 * - Bodies never overlap, whoever the holder is — the stronger of the two.
 *   D-17's mother and daughter are one client record and two people in two
 *   chairs.
 *
 * `holderKey` is who would be sitting in it. `''` is a key no hold can carry
 * (the trigger writes the client id or `appt:<id>`), so an unknown holder makes
 * the first arm match every row — the strict question, which is the right one
 * for an anonymous visitor who has not said who she is yet.
 */
export function seatBlocked(
  hold: Range & { holderKey: string; bodyStart: number; bodyEnd: number },
  envelope: Range,
  body: Range,
  holderKey: string | null,
): boolean {
  return (
    (hold.start < envelope.end && hold.end > envelope.start && hold.holderKey !== (holderKey ?? '')) ||
    (hold.bodyStart < body.end && hold.bodyEnd > body.start)
  );
}

/**
 * Could this visit be seated — is there one chair free for its WHOLE envelope?
 *
 * MIRRORS `findFreeResource`, deliberately and line for line, through the one
 * predicate above. The chooser asking a laxer question than this one means a
 * time is offered and then refused; asking a stricter one means chairs that are
 * genuinely free are never offered, and CLAUDE.md is explicit that a reader
 * stricter than the constraint does not fail safe.
 */
export function canSeat(
  seating: Seating,
  envelope: Span,
  body: Span,
  holderKey: string | null,
): boolean {
  return seating.chairIds.some(
    (chairId) =>
      !seating.holds.some(
        (hold) => hold.resourceId === chairId && seatBlocked(hold, envelope, body, holderKey),
      ),
  );
}

/**
 * The room over the query window.
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
 *
 * A required type with NO active chairs comes back with `chairIds: []`, so
 * `canSeat` is false everywhere and nothing is bookable — the same answer the
 * old whole-window busy interval gave, without a special case.
 */
export async function loadSeating(
  db: Db,
  args: {
    businessId: string;
    resourceTypeId: string;
    windowStart: Date;
    windowEnd: Date;
    excludeAppointmentId?: string | null;
  },
): Promise<Seating> {
  const [chairs, holds] = await Promise.all([
    db.resource.findMany({
      where: { businessId: args.businessId, resourceTypeId: args.resourceTypeId, active: true },
      select: { id: true },
    }),
    db.appointmentResourceHold.findMany({
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
      select: {
        resourceId: true,
        holderKey: true,
        blockedStart: true,
        blockedEnd: true,
        bodyStart: true,
        bodyEnd: true,
      },
    }),
  ]);

  return {
    resourceTypeId: args.resourceTypeId,
    chairIds: chairs.map((c) => c.id),
    holds: holds.map((h) => ({
      resourceId: h.resourceId,
      holderKey: h.holderKey,
      start: fromDate(h.blockedStart),
      end: fromDate(h.blockedEnd),
      bodyStart: fromDate(h.bodyStart),
      bodyEnd: fromDate(h.bodyEnd),
    })),
  };
}
