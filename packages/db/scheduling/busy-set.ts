/**
 * THE BUSY-SET QUERY (A-026, D-16).
 *
 * The single highest-risk query in the project after the exclusion constraint
 * itself, and it has two ways to be silently wrong. Both are guarded here and
 * both have a test.
 *
 * 1. IT IS AN INSTANT-OVERLAP PREDICATE, NEVER `WHERE date(startAt) = day`.
 *    A booking that starts 23:30 and runs past midnight belongs to BOTH days.
 *    A date filter drops it from the second one, and the engine — seeing
 *    nothing in the way — cheerfully offers 00:00 to the next customer.
 *
 * 2. IT READS `COALESCE("overriddenFromRange", tstzrange(blocked...))`.
 *    A staff override (D-8) stores a ZERO-WIDTH blocked range so the exclusion
 *    constraint stays absolute without refusing the override. That empty range
 *    overlaps nothing, so a busy set built from `blockedStart/blockedEnd`
 *    alone returns the override as an interval that blocks no time at all —
 *    and the public booking flow then offers the exact slot staff knowingly
 *    double-booked, letting a customer create the accidental conflict Goal 2
 *    promises is impossible. `overriddenFromRange` carries the TRUE range and
 *    this query is the reader D-16 exists for.
 *
 * 3. IT READS `AppointmentBlock`, ONE ROW PER WORKED SPAN, NOT `Appointment`
 *    (D-29, A-030). This is the entire mechanism by which SEG-04 works: a
 *    colour contributes TWO busy intervals with its developing time between
 *    them, so the engine offers that time without knowing segments exist. The
 *    pure engine needed no change at all — a composed visit was already just a
 *    longer service, and a segmented one is just two busy intervals.
 *
 *    An override still reads `overriddenFromRange` from the PARENT: its single
 *    block is zero-width by design (D-8), and the true range lives on the
 *    appointment. That is why this query joins rather than reading blocks alone.
 *
 *    The `id` returned is the APPOINTMENT's, not the block's, so the engine's
 *    `conflictIds` still name something a human can open. A candidate spanning
 *    both halves of one colour therefore names it twice, which is honest.
 *
 * Raw SQL rather than the Prisma query builder because neither `tstzrange`,
 * `&&`, nor `COALESCE` over a range type is expressible through it.
 */
import { ACTIVE_STATUSES } from '../../core/scheduling';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface BusyRow {
  id: string;
  start: Date;
  end: Date;
  kind: 'booking';
}

/**
 * Every appointment occupying any part of [windowStart, windowEnd) for this
 * provider.
 *
 * The status filter is derived from `ACTIVE_STATUSES` — the same single module
 * the exclusion constraint's predicate is derived from (D-15). `completed` and
 * `no_show` still OCCUPY their time; only `cancelled`/`cancelled_late` free
 * it. Hand-typing the list here would be the "a status enum is never one edit"
 * trap that this project structurally prevents everywhere else.
 *
 * `excludeAppointmentId` EXISTS FOR RESCHEDULE (A-014), and it is not an
 * optimisation. The exclusion constraint compares the updated row against
 * OTHER rows, so moving a 60-minute appointment from 09:00 to 09:30 does not
 * false-conflict (spec §4.6) — but the ENGINE, re-run inside that same
 * transaction, sees the row at its old time and refuses the destination as
 * `overlaps-booking`. Without this, an appointment could never be moved to any
 * time within its own duration of where it already is, which is the most
 * common reschedule there is: "can we push it half an hour?"
 */
export async function findBusyAppointments(
  db: Db,
  args: { providerId: string; windowStart: Date; windowEnd: Date; excludeAppointmentId?: string | null },
): Promise<BusyRow[]> {
  const rows = await db.$queryRawUnsafe<{ id: string; start: Date; end: Date }[]>(
    `
    SELECT a."id",
           lower(COALESCE(a."overriddenFromRange", tstzrange(b."blockedStart", b."blockedEnd", '[)'))) AS "start",
           upper(COALESCE(a."overriddenFromRange", tstzrange(b."blockedStart", b."blockedEnd", '[)'))) AS "end"
      FROM "AppointmentBlock" b
      JOIN "Appointment" a ON a."id" = b."appointmentId"
     WHERE b."providerId" = $1
       AND b."status"::text = ANY($4::text[])
       AND ($5::text IS NULL OR b."appointmentId" <> $5)
       AND COALESCE(a."overriddenFromRange", tstzrange(b."blockedStart", b."blockedEnd", '[)'))
           && tstzrange($2::timestamptz, $3::timestamptz, '[)')
     ORDER BY "start"
    `,
    args.providerId,
    args.windowStart,
    args.windowEnd,
    [...ACTIVE_STATUSES],
    args.excludeAppointmentId ?? null,
  );

  // A row whose range is empty on BOTH sides (a zero-width blocked range with
  // no overriddenFromRange) cannot occupy time and is dropped rather than
  // handed to the engine as a zero-length interval — which would subtract
  // nothing and merely look like a bug in the engine instead of here.
  return rows
    .filter((r) => r.start !== null && r.end !== null && r.end > r.start)
    .map((r) => ({ id: r.id, start: r.start, end: r.end, kind: 'booking' as const }));
}
