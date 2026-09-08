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
import { type CalendarDay, type ZoneId, addDays, calendarDay, fromDate, startOfDay, toDate, toLabel, wallTime, weekdayOf, zoneId } from '../../core/time';
import { type AppointmentStatus, ACTIVE_STATUSES, CONSUMED_STATUSES } from '../../core/scheduling';
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
  /** RPT-02's fraction, 0..1 — FROZEN, and backward-looking by construction:
   *  the numerator is `CONSUMED_STATUSES`, so only a visit that has already
   *  happened is in it. `null` is "n/a" — a zero denominator, never rendered
   *  as 0%. */
  utilization: number | null;
  /**
   * A-101 (D-51) — THE FORWARD NUMBER, and the reason this interface has two.
   *
   * Same denominator, `ACTIVE_STATUSES` for a numerator: how much of the
   * week's working time is SPOKEN FOR, whether or not it has happened yet.
   * `CONSUMED_STATUSES ⊂ ACTIVE_STATUSES`, so `booked >= utilization` always,
   * and both are `null` on exactly the same zero denominator.
   *
   * RPT-02 is untouched. What was never specified is which WEEK the tile is
   * shown for, and the dashboard opens on the current one — the one week the
   * owner can still do something about, and the one a retrospective formula
   * can only ever say 0.0% about.
   */
  booked: number | null;
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
  /**
   * A-101 (D-51) — the week has not started yet, in the business's own zone.
   *
   * A FACT ABOUT THE CALENDAR, not about the data: the surface pairs it with
   * `utilization === 0` before it says "not yet worked", so a closed-out row
   * that somehow lands in a future week is still reported as the number it is
   * rather than papered over by the wording.
   */
  weekIsAhead: boolean;
}

/**
 * `anyDayInWeek` names any day; the summary covers the whole Monday-Sunday
 * week it falls in (`weekOf`). Passing a bare day rather than pre-computed
 * bounds keeps "which week" a one-value URL param at the surface.
 *
 * `now` is a PARAMETER (A-101), for the same reason the engine's is: the only
 * thing it decides is whether the week is still ahead, and a report that reads
 * the system clock is a report whose tests cannot ask it about next week.
 */
export async function dashboardSummary(
  db: Db,
  args: { businessId: string; anyDayInWeek: string; now: Date },
): Promise<DashboardSummary> {
  const { fromDay, toDay } = weekOf(calendarDay(args.anyDayInWeek));

  const business = await db.business.findUniqueOrThrow({ where: { id: args.businessId }, select: { timezone: true } });
  const zone = zoneId(business.timezone);
  /**
   * A-098. Active, OR she worked some part of THIS week — the same widening
   * `day-view.ts` and `room.ts` make, on the window this report covers.
   *
   * `active: true` alone meant a stylist leaving on Wednesday took Monday and
   * Tuesday's no-shows and her whole utilisation row out of the week she was
   * actually in, and out of every week before it. Retiring does not rewrite
   * history — `room.ts`'s comment says so about a chair, and a report is the
   * one surface where that has to be literally true.
   *
   * RPT-02's utilisation formula is untouched (frozen; A-101 owns the only
   * open question about it). This changes who has a row, not how one is
   * computed.
   */
  const providers = await db.provider.findMany({
    where: {
      businessId: args.businessId,
      OR: [{ active: true }, { appointments: { some: { startDay: { gte: fromDay, lte: toDay } } } }],
    },
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

  // BOTH numerators, one query: every provider's minutes this week that still
  // occupy the chair, summed in JS — a groupBy cannot sum a computed
  // expression, and the row count here is small enough that fetching it
  // plainly costs nothing a raw SQL aggregate would meaningfully save.
  //
  // A-086. Neither list is re-typed here: the tile and the drill-down link it
  // opens have to be the same set of rows, and there are two links now.
  // A-101 widens the QUERY from `CONSUMED_STATUSES` to `ACTIVE_STATUSES` —
  // which contains it (both are derived from `SLOT_FREEING_STATUSES` in the
  // status module) — and splits the two sums off `row.status`.
  const occupied = await db.appointment.findMany({
    where: {
      businessId: args.businessId,
      startDay: { gte: fromDay, lte: toDay },
      status: { in: [...ACTIVE_STATUSES] },
    },
    select: { providerId: true, status: true, startAt: true, endAt: true },
  });
  const consumedMinutesByProvider = new Map<string, number>();
  const activeMinutesByProvider = new Map<string, number>();
  for (const row of occupied) {
    const minutes = (fromDate(row.endAt) - fromDate(row.startAt)) / 60_000;
    activeMinutesByProvider.set(row.providerId, (activeMinutesByProvider.get(row.providerId) ?? 0) + minutes);
    if ((CONSUMED_STATUSES as readonly string[]).includes(row.status)) {
      consumedMinutesByProvider.set(row.providerId, (consumedMinutesByProvider.get(row.providerId) ?? 0) + minutes);
    }
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
      utilization: utilizationFraction(consumedMinutesByProvider.get(p.id) ?? 0, availableMinutesByProvider.get(p.id) ?? 0),
      booked: utilizationFraction(activeMinutesByProvider.get(p.id) ?? 0, availableMinutesByProvider.get(p.id) ?? 0),
    })),
    weekIsAhead: fromDay > toLabel(fromDate(args.now), zone).day,
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
