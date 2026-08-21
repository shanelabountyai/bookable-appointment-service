/**
 * A-043 — WHAT'S OPENED UP (WAIT-02's missing entry point).
 *
 * A client cancels next Thursday's colour on Saturday through her manage link.
 * The notice is correctly staff-only, and the matching machinery
 * (`matchFreedSlot`) is built and good — but it has exactly ONE door: a URL
 * assembled on the cancelled appointment's own detail page. Reaching it
 * therefore requires already knowing WHICH appointment was cancelled, which is
 * the one thing the desk does not know. Three hours of the salon's most
 * valuable service sit unsold for six days while the waitlist entry that fits
 * it sits two screens away.
 *
 * DERIVED ON EVERY READ, NOTHING STORED — the same reflex as AVAIL-05's
 * conflicts (operator R-7) and A-021's call-down. "This slot is open" stops
 * being true the moment somebody books it, and a stored flag would need its
 * own clearing code in every one of those paths.
 *
 * THE LIST IS BOUNDED IN THREE DIRECTIONS, and the tests are mostly about the
 * bounds rather than the contents: `appointmentsInRange` next door has no
 * lower time bound at all, which is safe there (its window is the absence
 * being written) and would be ruinous here — every cancellation the salon has
 * ever taken, forever.
 */
import { SLOT_FREEING_STATUSES } from '../../core/scheduling';
import { fromDate, instant, toDate } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { findAbsences } from '../availability/availability';
import { findBusyAppointments } from '../scheduling/busy-set';

type Db = Prisma.TransactionClient | PrismaClient;

/** How long a cancellation stays news. Past this the slot is not "what just
 *  opened up" any more, it is simply an empty column, and the day grid is
 *  already the screen for that. */
export const FREED_LOOKBACK_DAYS = 14;

const DAY_MS = 86_400_000;

export interface OpenedSlot {
  appointmentId: string;
  providerId: string;
  providerName: string;
  /** The body's start — what the desk reads, and what the ordering is on. */
  startAt: Date;
  /** Buffer-inclusive, because that is the range the exclusion constraint let
   *  go of and the range `matchFreedSlot` measures a service against. */
  blockedStart: Date;
  blockedEnd: Date;
  freedMinutes: number;
  /** `matchFreedSlot` matches one service; the first line is the one the URL
   *  the detail page builds already carries. */
  primaryServiceId: string | null;
  serviceNames: string[];
  status: string;
  /** Who cancelled — on the row for the same reason AVAIL-05's conflicts and
   *  A-021's call-down put it there: "shall we find you another time?" is a
   *  call, and a list you have to click through is a list the desk copies
   *  onto paper. */
  clientName: string | null;
  clientPhone: string | null;
}

/**
 * Future time freed by a recent cancellation and still empty, soonest first.
 *
 * `now` is injected, never read from the clock here — same discipline as
 * `listUnconfirmedTomorrow` and `clientReliability`.
 *
 * Ordered by how soon the time EXPIRES, not by when it was cancelled: a
 * Thursday 2pm dies on Thursday at 2 whether it was freed this morning or a
 * week ago, and the one at the top is the one worth a phone call now.
 */
export async function listOpenedSlots(
  db: Db,
  args: { businessId: string; now: Date; lookbackDays?: number },
): Promise<OpenedSlot[]> {
  const since = toDate(instant(fromDate(args.now) - (args.lookbackDays ?? FREED_LOOKBACK_DAYS) * DAY_MS));

  const candidates = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      // Derived from the status module, never hand-typed: `completed` and
      // `no_show` are terminal and still OCCUPY their time (D-7), so neither
      // freed anything.
      status: { in: [...SLOT_FREEING_STATUSES] },
      // BOUND 1 — still future. Yesterday's cancellation cannot be sold.
      startAt: { gt: args.now },
      // BOUND 2 — recent. There is no `cancelledAt` column, and `updatedAt` on
      // a row in a terminal status is the cancellation in every path that
      // writes one. Its known ceiling: a later note or acknowledgment edit
      // refreshes it, which re-surfaces a slot that is genuinely still open —
      // wrong date, right answer. The opposite error is impossible.
      updatedAt: { gte: since },
      // A cancelled override freed a zero-width range (D-8) — it never held
      // any time to give back, and its `freedMinutes` of 0 matches nothing.
      isOverride: false,
      // Nobody can be booked with a provider who has left (A-041).
      provider: { is: { active: true } },
    },
    orderBy: { startAt: 'asc' },
    select: {
      id: true,
      providerId: true,
      startAt: true,
      blockedStart: true,
      blockedEnd: true,
      status: true,
      provider: { select: { displayName: true } },
      client: { select: { name: true, phone: true } },
      lines: { orderBy: { ordinal: 'asc' }, select: { serviceId: true, service: { select: { name: true } } } },
    },
  });

  // BOUND 3 — still empty. One pair of reads per candidate rather than one
  // query for the lot: `findBusyAppointments` is the only reader that gets
  // D-16's `overriddenFromRange` and D-29's per-block ranges right, and
  // re-implementing that predicate here to save a round trip is exactly the
  // second copy CLAUDE.md keeps out. Bounded by the two bounds above — a
  // salon's fortnight of future cancellations, not a table scan.
  const open = await Promise.all(
    candidates.map(async (row) => {
      const window = { providerId: row.providerId, windowStart: row.blockedStart, windowEnd: row.blockedEnd };
      const [busy, absences] = await Promise.all([
        // The cancelled row itself is not in the busy set: its blocks carry
        // its own status and ACTIVE_STATUSES excludes it.
        findBusyAppointments(db, window),
        // Time off over the freed slot means it did not open up — Dana is off,
        // and that appointment is the conflicts screen's problem, not a thing
        // to sell to the waitlist.
        findAbsences(db, window),
      ]);
      return busy.length === 0 && absences.length === 0 ? row : null;
    }),
  );

  return open.flatMap((row) =>
    row === null
      ? []
      : [
          {
            appointmentId: row.id,
            providerId: row.providerId,
            providerName: row.provider.displayName,
            startAt: row.startAt,
            blockedStart: row.blockedStart,
            blockedEnd: row.blockedEnd,
            freedMinutes: Math.round((fromDate(row.blockedEnd) - fromDate(row.blockedStart)) / 60_000),
            primaryServiceId: row.lines[0]?.serviceId ?? null,
            serviceNames: row.lines.map((l) => l.service.name),
            status: row.status,
            clientName: row.client?.name ?? null,
            clientPhone: row.client?.phone ?? null,
          },
        ],
  );
}
