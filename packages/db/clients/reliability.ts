/**
 * A-020 — THE ROLLING COUNTERS (CLIENT-04, OQ-3/D-27).
 *
 * "Rolling 12-month no-show and late-cancel counts with appointment
 * references, surfaced everywhere the client appears." One function answers
 * that for a LIST of clients, because every surface that shows it — the search
 * results, the day grid, the booking panel's picker — shows several clients at
 * once, and a per-client version would have been called in a loop on all three.
 *
 * DERIVED, NEVER STORED. The same reflex as AVAIL-05's conflicts (operator
 * R-7): a stored `noShowCount` is wrong the moment a staff member corrects a
 * mis-tapped no-show back to `completed` (APPT-06), and wrong again silently
 * every day as old ones age out of the window. Counting costs one grouped
 * query over an indexed column.
 *
 * THE WINDOW IS COMPARED ON `startDay`, the denormalized business-zone
 * calendar label (P1-6) — not on `startAt`. A client's 8pm appointment on the
 * last day of the window is inside it in the salon's calendar and outside it
 * in UTC, and the salon's calendar is the one the front desk is arguing about.
 */
import { MISSED_STATUSES, SELF_SERVE_BLOCKING_STATUSES } from '../../core/scheduling';
import { reliabilityWindowStart, selfServeBlocked } from '../../core/clients';
import { calendarDay } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface ClientReliability {
  noShows: number;
  lateCancels: number;
  /** The threshold in force, so a surface can say "3 of 3" rather than just
   *  "blocked" — and so the number the owner set is the number staff read. */
  threshold: number;
  /** CLIENT-04's lever: she can still be booked BY STAFF (D-27), never by the
   *  website. */
  selfServeBlocked: boolean;
  /** First day inside the window, for "since June 2025" on screen. */
  since: string;
}

const NONE: Omit<ClientReliability, 'threshold' | 'since'> = { noShows: 0, lateCancels: 0, selfServeBlocked: false };

/**
 * Counts for however many clients you ask about, in one query.
 *
 * `today` is the SALON's calendar day, passed in — nothing here reads a clock,
 * so a test can sit the window edge exactly on an appointment (CLAUDE.md).
 */
export async function clientReliability(
  db: Db,
  args: { businessId: string; clientIds: readonly string[]; today: string },
): Promise<Map<string, ClientReliability>> {
  const out = new Map<string, ClientReliability>();
  const ids = [...new Set(args.clientIds)];
  if (ids.length === 0) return out;

  const { noShowBlockThreshold: threshold } = await db.business.findUniqueOrThrow({
    where: { id: args.businessId },
    select: { noShowBlockThreshold: true },
  });
  const since = reliabilityWindowStart(calendarDay(args.today));

  const grouped = await db.appointment.groupBy({
    by: ['clientId', 'status'],
    where: {
      businessId: args.businessId,
      clientId: { in: ids },
      status: { in: [...MISSED_STATUSES] },
      // No upper bound, deliberately. A late cancellation is made INSIDE the
      // cutoff, so the appointment it belongs to is usually still in the
      // future when it is counted — capping the window at today would drop
      // exactly the cancellation that just happened, which is the one the
      // front desk is looking at.
      startDay: { gte: since },
    },
    _count: { _all: true },
  });

  for (const id of ids) out.set(id, { ...NONE, threshold, since });

  for (const row of grouped) {
    if (!row.clientId) continue;
    const entry = out.get(row.clientId);
    if (!entry) continue;
    if ((SELF_SERVE_BLOCKING_STATUSES as readonly string[]).includes(row.status)) {
      entry.noShows += row._count._all;
    } else {
      entry.lateCancels += row._count._all;
    }
  }

  for (const entry of out.values()) {
    entry.selfServeBlocked = selfServeBlocked(entry.noShows, threshold);
  }

  return out;
}

/** One client, for the write path and the client record. */
export async function reliabilityFor(
  db: Db,
  args: { businessId: string; clientId: string; today: string },
): Promise<ClientReliability> {
  const counts = await clientReliability(db, {
    businessId: args.businessId,
    clientIds: [args.clientId],
    today: args.today,
  });
  return counts.get(args.clientId)!;
}

export interface MissedAppointment {
  appointmentId: string;
  startAt: Date;
  startDay: string;
  status: string;
  providerName: string;
  services: string[];
}

/**
 * CLIENT-04's "with appointment references" — the counter's own working.
 *
 * A bare number is not something the front desk can act on: "three no-shows"
 * ends the conversation, "three no-shows, and the last one was the Saturday
 * colour in April" starts it. Every one links to the appointment, where the
 * event log says who marked it and why (APPT-07), so a correction is one click
 * from the count that provoked the argument.
 */
export async function missedAppointments(
  db: Db,
  args: { businessId: string; clientId: string; today: string },
): Promise<MissedAppointment[]> {
  const since = reliabilityWindowStart(calendarDay(args.today));

  const rows = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      clientId: args.clientId,
      status: { in: [...MISSED_STATUSES] },
      startDay: { gte: since },
    },
    orderBy: { startAt: 'desc' },
    select: {
      id: true,
      startAt: true,
      startDay: true,
      status: true,
      provider: { select: { displayName: true } },
      lines: { orderBy: { ordinal: 'asc' }, select: { service: { select: { name: true } } } },
    },
  });

  return rows.map((row) => ({
    appointmentId: row.id,
    startAt: row.startAt,
    startDay: row.startDay.trim(),
    status: row.status,
    providerName: row.provider.displayName,
    services: row.lines.map((l) => l.service.name),
  }));
}
