/**
 * A-151 (C10, D-74) — THE CLIENTS THE SALON OWES A REBOOK.
 *
 * Dana is off sick on Saturday and the desk cancels her six clients from the
 * conflicts screen. Four get rebooked on the phone that morning. The other two
 * did not answer, and on Monday nobody remembers who they were — the salon
 * took their appointment away and never gave one back. That is a debt, and
 * this is the list of it.
 *
 * DERIVED, NEVER STORED. A client is on the list when:
 *
 *   * the salon cancelled her appointment — the cancelling event carries
 *     `salonInitiated` (D-74), written only by the conflicts screen. Status
 *     alone cannot say it: that screen's `cancelled` and a panel cancel's are
 *     the same value.
 *   * within the last `weeks` (the lapsed report's window, reused: a debt
 *     older than that has become a lapsed client, and that report owns her).
 *   * NOTHING has been booked for her SINCE, in any status, and nothing active
 *     is ahead of `now`. "Nothing ahead" alone is wrong the day after the debt
 *     is paid: rebooked for Tuesday, in on Tuesday, and on Wednesday she has
 *     nothing ahead and would be back on the list. A rebook she then cancels
 *     herself still paid it — her own cancel is not the salon's debt.
 *
 * ONE ROW PER CLIENT, her most recent salon cancel. Two cancellations are
 * still one phone call.
 */
import { ACTIVE_STATUSES, SLOT_FREEING_STATUSES } from '../../core/scheduling';
import { calendarDay, fromDate, instant, toDate, toLabel, zoneId } from '../../core/time';
import { LAPSED_WEEKS } from '../reports/lapsed';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

const WEEK_MS = 7 * 86_400_000;

/** Events that can put an appointment INTO a cancelled status. */
const STATUS_EVENT_TYPES = ['status_changed', 'status_corrected'];

export interface OwedRebook {
  /** The cancelled appointment — the call mark hangs off it (`owed:<id>`). */
  appointmentId: string;
  clientId: string;
  name: string | null;
  phone: string | null;
  /** When she was supposed to come in. */
  startAt: Date;
  startDay: string;
  providerId: string;
  providerName: string;
  /** Every service, in order (VISIT-01) — the prefill books the same visit. */
  serviceIds: string[];
  serviceNames: string[];
  cancelledAt: Date;
  /** What the desk typed when it cancelled — what to read back to her. */
  reason: string | null;
  /** Where the staff booking search starts: her original day, or today if
   *  that has passed. Never a day the salon cannot sell. */
  rebookFromDay: string;
}

export async function listOwedRebooks(
  db: Db,
  args: { businessId: string; now: Date; weeks?: number },
): Promise<OwedRebook[]> {
  const weeks = args.weeks ?? LAPSED_WEEKS;
  const since = toDate(instant(fromDate(args.now) - weeks * WEEK_MS));

  // DISCOVERY — every salon cancel in the window. Narrow on purpose: the
  // check below decides whether each one still stands.
  const flagged = await db.appointmentEvent.findMany({
    where: {
      businessId: args.businessId,
      type: { in: STATUS_EVENT_TYPES },
      createdAt: { gte: since },
      payload: { path: ['salonInitiated'], equals: true },
    },
    select: { appointmentId: true },
    distinct: ['appointmentId'],
  });
  if (flagged.length === 0) return [];

  const appointments = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      id: { in: flagged.map((e) => e.appointmentId) },
      status: { in: [...SLOT_FREEING_STATUSES] },
      clientId: { not: null },
      // A tombstone is not a person to ring; a merge re-points her rows to
      // the survivor, so this only drops rows the merge could not move.
      client: { mergedIntoClientId: null },
    },
    select: {
      id: true,
      clientId: true,
      startAt: true,
      startDay: true,
      provider: { select: { id: true, displayName: true } },
      client: { select: { name: true, phone: true } },
      lines: { orderBy: { ordinal: 'asc' }, select: { serviceId: true, service: { select: { name: true } } } },
    },
  });
  if (appointments.length === 0) return [];

  // THE CANCEL THAT STANDS is the LATEST status event, and it must be the
  // salon's. Reinstated and then cancelled by her own link is her cancel now.
  // Newest first and FIRST-wins — a plain `new Map(rows.map(...))` keeps the
  // last row, which here is the oldest (A-093).
  const events = await db.appointmentEvent.findMany({
    where: { appointmentId: { in: appointments.map((a) => a.id) }, type: { in: STATUS_EVENT_TYPES } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { appointmentId: true, createdAt: true, reason: true, payload: true },
  });
  const latest = new Map<string, (typeof events)[number]>();
  for (const event of events) if (!latest.has(event.appointmentId)) latest.set(event.appointmentId, event);

  // One debt per client: her most recent salon cancel.
  const byClient = new Map<string, { appointment: (typeof appointments)[number]; cancelledAt: Date; reason: string | null }>();
  for (const appointment of appointments) {
    const event = latest.get(appointment.id);
    const payload = event?.payload as { salonInitiated?: boolean } | null | undefined;
    if (!event || payload?.salonInitiated !== true || event.createdAt < since) continue;
    const current = byClient.get(appointment.clientId!);
    if (!current || current.cancelledAt < event.createdAt) {
      byClient.set(appointment.clientId!, { appointment, cancelledAt: event.createdAt, reason: event.reason });
    }
  }
  if (byClient.size === 0) return [];

  // PAID — anything booked for her since the cancel, or anything active ahead.
  const others = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      clientId: { in: [...byClient.keys()] },
      OR: [
        { createdAt: { gte: since } },
        { status: { in: [...ACTIVE_STATUSES] }, startAt: { gt: args.now } },
      ],
    },
    select: { id: true, clientId: true, createdAt: true, status: true, startAt: true },
  });
  const paid = new Set<string>();
  for (const other of others) {
    const debt = byClient.get(other.clientId!);
    if (!debt || other.id === debt.appointment.id) continue;
    const bookedSince = other.createdAt >= debt.cancelledAt;
    const activeAhead =
      (ACTIVE_STATUSES as readonly string[]).includes(other.status) && other.startAt > args.now;
    if (bookedSince || activeAhead) paid.add(other.clientId!);
  }

  const business = await db.business.findUniqueOrThrow({
    where: { id: args.businessId },
    select: { timezone: true },
  });
  const today = calendarDay(toLabel(fromDate(args.now), zoneId(business.timezone)).day);

  const rows = [...byClient.entries()]
    .filter(([clientId]) => !paid.has(clientId))
    .map(([clientId, { appointment, cancelledAt, reason }]) => {
      const startDay = appointment.startDay.trim();
      return {
        appointmentId: appointment.id,
        clientId,
        name: appointment.client!.name,
        phone: appointment.client!.phone,
        startAt: appointment.startAt,
        startDay,
        providerId: appointment.provider.id,
        providerName: appointment.provider.displayName,
        serviceIds: appointment.lines.map((l) => l.serviceId),
        serviceNames: appointment.lines.map((l) => l.service.name),
        cancelledAt,
        reason,
        rebookFromDay: startDay > today ? startDay : (today as string),
      };
    });

  // Longest owed first: the appointment she should already have had.
  rows.sort((a, b) => fromDate(a.startAt) - fromDate(b.startAt) || a.appointmentId.localeCompare(b.appointmentId));
  return rows;
}
