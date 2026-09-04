/**
 * A-024 — the owner dashboard (RPT-01, RPT-02, RPT-03).
 *
 * One week, one business, every tile computed here and rendered at the
 * surface. RPT-03 (reschedules excluded from the cancellation rate) needs no
 * code of its own: reschedule is a same-row UPDATE (D-6), so a moved
 * appointment simply isn't counted at its OLD week anymore — nothing to
 * exclude, because nothing to find, the same free lunch A-022's reminder job
 * got from the same decision.
 */
import { availableMinutesForDay, utilizationFraction, weekOf } from '../../core/reports';
import { type CalendarDay, type ZoneId, addDays, calendarDay, fromDate, startOfDay, toDate, wallTime, weekdayOf, zoneId } from '../../core/time';
import { type AppointmentStatus, CONSUMED_STATUSES } from '../../core/scheduling';
import { findAbsences, resolveDayWindows } from '../availability';
import { countOverruledCancellations } from './overruled';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface ProviderCount {
  providerId: string;
  providerName: string;
  count: number;
}

export interface ProviderUtilization {
  providerId: string;
  providerName: string;
  /** RPT-02's fraction, 0..1. `null` is "n/a" — a zero denominator, never
   *  rendered as 0%. */
  utilization: number | null;
}

export interface DashboardSummary {
  fromDay: string;
  toDay: string;
  /** Every appointment scheduled to occur that week, whatever happened to it
   *  since — the gross count "cancels" and "no-shows" are drawn from. */
  bookings: number;
  /** A-060: `overruled` is a subset of `normal` — cancellations the machine
   *  classified as late and a human deliberately downgraded. Counted here so
   *  the tile can say it out loud, because an escape nobody can see the size
   *  of stops being an escape and becomes the new default. */
  cancels: { normal: number; late: number; overruled: number };
  noShowsByProvider: ProviderCount[];
  utilizationByProvider: ProviderUtilization[];
}

/**
 * `anyDayInWeek` names any day; the summary covers the whole Monday-Sunday
 * week it falls in (`weekOf`). Passing a bare day rather than pre-computed
 * bounds keeps "which week" a one-value URL param at the surface.
 */
export async function dashboardSummary(
  db: Db,
  args: { businessId: string; anyDayInWeek: string },
): Promise<DashboardSummary> {
  const { fromDay, toDay } = weekOf(calendarDay(args.anyDayInWeek));

  const business = await db.business.findUniqueOrThrow({ where: { id: args.businessId }, select: { timezone: true } });
  const zone = zoneId(business.timezone);
  const providers = await db.provider.findMany({
    where: { businessId: args.businessId, active: true },
    orderBy: { displayOrder: 'asc' },
    select: { id: true, displayName: true },
  });

  const byStatus = await db.appointment.groupBy({
    by: ['status'],
    where: { businessId: args.businessId, startDay: { gte: fromDay, lte: toDay } },
    _count: { _all: true },
  });
  const countOf = (status: AppointmentStatus) => byStatus.find((r) => r.status === status)?._count._all ?? 0;

  const noShowRows = await db.appointment.groupBy({
    by: ['providerId'],
    where: { businessId: args.businessId, startDay: { gte: fromDay, lte: toDay }, status: 'no_show' },
    _count: { _all: true },
  });

  // The numerator: one query for every provider's completed/no-show minutes
  // this week, summed in JS — a groupBy cannot sum a computed expression, and
  // the row count here is small enough that fetching it plainly costs nothing
  // a raw SQL aggregate would meaningfully save.
  const occupied = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      startDay: { gte: fromDay, lte: toDay },
      // A-086. The list is `CONSUMED_STATUSES`, never re-typed here: the tile
      // and the drill-down link it opens have to be the same set of rows.
      status: { in: [...CONSUMED_STATUSES] },
    },
    select: { providerId: true, startAt: true, endAt: true },
  });
  const occupiedMinutesByProvider = new Map<string, number>();
  for (const row of occupied) {
    const minutes = (fromDate(row.endAt) - fromDate(row.startAt)) / 60_000;
    occupiedMinutesByProvider.set(row.providerId, (occupiedMinutesByProvider.get(row.providerId) ?? 0) + minutes);
  }

  const availableMinutesByProvider = new Map<string, number>();
  for (const provider of providers) {
    let total = 0;
    let day = calendarDay(fromDay);
    const last = calendarDay(toDay);
    while (day <= last) {
      total += await availableMinutesForProviderDay(db, { businessId: args.businessId, providerId: provider.id, day, zone });
      day = addDays(day, 1);
    }
    availableMinutesByProvider.set(provider.id, total);
  }

  return {
    fromDay,
    toDay,
    bookings: byStatus.reduce((total, r) => total + r._count._all, 0),
    cancels: {
      normal: countOf('cancelled'),
      late: countOf('cancelled_late'),
      overruled: await countOverruledCancellations(db, { businessId: args.businessId, fromDay, toDay }),
    },
    noShowsByProvider: providers
      .map((p) => ({
        providerId: p.id,
        providerName: p.displayName,
        count: noShowRows.find((r) => r.providerId === p.id)?._count._all ?? 0,
      }))
      .filter((p) => p.count > 0),
    utilizationByProvider: providers.map((p) => ({
      providerId: p.id,
      providerName: p.displayName,
      utilization: utilizationFraction(occupiedMinutesByProvider.get(p.id) ?? 0, availableMinutesByProvider.get(p.id) ?? 0),
    })),
  };
}

async function availableMinutesForProviderDay(
  db: Db,
  args: { businessId: string; providerId: string; day: CalendarDay; zone: ZoneId },
): Promise<number> {
  const resolved = await resolveDayWindows(db, {
    businessId: args.businessId,
    providerId: args.providerId,
    day: args.day,
    weekday: weekdayOf(args.day),
  });
  if (resolved.windows.length === 0) return 0;

  const windowStart = toDate(startOfDay(args.day, args.zone));
  const windowEnd = toDate(startOfDay(addDays(args.day, 1), args.zone));
  const absences = await findAbsences(db, { providerId: args.providerId, windowStart, windowEnd });

  return availableMinutesForDay(
    resolved.windows.map((w) => ({
      open: wallTime(w.open),
      close: wallTime(w.close),
      endsNextDay: w.endsNextDay,
      breaks: w.breaks.map((b) => ({ open: wallTime(b.open), close: wallTime(b.close) })),
    })),
    args.day,
    args.zone,
    absences.map((a) => ({ start: fromDate(a.start), end: fromDate(a.end) })),
  );
}

export interface ReportAppointmentRow {
  id: string;
  startAt: Date;
  status: AppointmentStatus;
  providerName: string;
  clientName: string | null;
  clientPhone: string | null;
  serviceNames: string[];
}

/**
 * RPT-01's "every tile drills into the underlying filtered list" — one
 * general-purpose query behind all four tiles, parameterized by what each
 * one already knows: the week, and optionally which statuses or provider.
 */
export async function listReportAppointments(
  db: Db,
  args: { businessId: string; fromDay: string; toDay: string; statuses?: readonly AppointmentStatus[]; providerId?: string },
): Promise<ReportAppointmentRow[]> {
  const rows = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      startDay: { gte: args.fromDay, lte: args.toDay },
      ...(args.statuses ? { status: { in: [...args.statuses] } } : {}),
      ...(args.providerId ? { providerId: args.providerId } : {}),
    },
    orderBy: { startAt: 'asc' },
    select: {
      id: true,
      startAt: true,
      status: true,
      provider: { select: { displayName: true } },
      client: { select: { name: true, phone: true } },
      lines: { orderBy: { ordinal: 'asc' }, select: { service: { select: { name: true } } } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    startAt: row.startAt,
    status: row.status,
    providerName: row.provider.displayName,
    clientName: row.client?.name ?? null,
    clientPhone: row.client?.phone ?? null,
    serviceNames: row.lines.map((l) => l.service.name),
  }));
}
