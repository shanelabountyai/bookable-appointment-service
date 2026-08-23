/**
 * A-016 — THE STAFF DAY VIEW (BOOK-04's view half, Goal 3).
 *
 * One read, one screen: every provider's column for one business day, with the
 * hours they work, what is in them, and what is left.
 *
 * THE THREE THINGS THIS FILE REFUSES TO RE-DERIVE, each because a second
 * implementation is a second set of bugs that only shows up on one day of the
 * year or one row in a thousand:
 *
 *  1. The hours. `resolveDayWindows` (A-007's precedence chain) decides them,
 *     and `resolveWindow` (A-008's axis crossing, now shared) places them on
 *     the physical axis. A grid that drew its own windows would eventually
 *     draw one the engine refuses to sell from.
 *  2. The busy set. `findBusyAppointments` is the D-16 reader — it COALESCEs
 *     `overriddenFromRange`, so a staff override's true range is what occupies
 *     the column even though its blocked range is zero-width (D-8). The grid
 *     renders the real collision; that is the whole point of storing it.
 *  3. What counts as occupied at all. The busy query's status filter comes
 *     from `ACTIVE_STATUSES`, so `completed` and `no_show` still hold their
 *     time (D-7) and only cancellations free it.
 */
import { type Span, resolveWindow, subtractSpans, wallTime } from '../../core/scheduling';
import { type ZoneId, addDays, calendarDay, fromDate, instant, startOfDay, toDate, weekdayOf } from '../../core/time';
import { findAbsences, resolveDayWindows } from '../availability';
import { type DayRoom, loadRoom } from './room';
import { findRunningLate } from './running-late';
import { findBusyAppointments } from '../scheduling';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

const MIN = 60_000;

export interface DayAppointment {
  id: string;
  startAt: Date;
  endAt: Date;
  /** Where it sits in the column — the D-16 effective range, so an override
   *  occupies its true span rather than the zero-width one. */
  occupiesStart: Date;
  occupiesEnd: Date;
  status: string;
  isOverride: boolean;
  overrideReason: string | null;
  serviceNames: string[];
  /** BOOK-04: a walk-in with no record is a real appointment, so every one of
   *  these may be null. */
  clientId: string | null;
  clientName: string | null;
  clientPhone: string | null;
  /** CLIENT-03's pinned note — an allergy is a safety surface, and it belongs
   *  on the chip rather than one click away. */
  clientNotes: string | null;
  notes: string | null;
}

export interface DayAbsence {
  id: string;
  start: Date;
  end: Date;
  kind: 'time_off' | 'ad_hoc_block';
  reason: string | null;
}

export interface DayGap {
  start: Date;
  end: Date;
  minutes: number;
}

export interface DayColumn {
  providerId: string;
  providerName: string;
  /** D-22. How far behind she is running right now, if anybody has said so.
   *  Null is "on time", which is the state that needs no explanation. */
  runningLateMinutes: number | null;
  /** No hours at all today — a closed day, not an empty one. The distinction
   *  is what stops the grid inviting a booking into a day off. */
  closed: boolean;
  windows: { start: Date; end: Date }[];
  breaks: { start: Date; end: Date }[];
  appointments: DayAppointment[];
  absences: DayAbsence[];
  gaps: DayGap[];
}

export interface DayView {
  day: string;
  timezone: string;
  /**
   * A-035. The business default, for asking the §7 table what the desk may do
   * to a chip right now — the cutoff clause governs the cancel edges.
   *
   * The business default and not D-19's per-service resolution: a chip offers
   * no cancel edge (see the view model), so nothing on this surface can
   * currently consult it. It is carried anyway rather than passed as a zero,
   * because a zero would be a lie the day somebody adds one.
   */
  cancellationCutoffMinutes: number;
  /** The rendering bounds: the earliest and latest instant anything on this
   *  day touches, so an overnight window or a 07:00 override is on screen
   *  rather than clipped off the top. */
  from: Date;
  to: Date;
  columns: DayColumn[];
  /** A-046. The same day seen from the ROOM rather than from the roster — the
   *  axis that has been refusing bookings since A-031 and appearing on no
   *  screen. Empty for a business with no resource types, which is every
   *  business that has not defined any. */
  room: DayRoom[];
}

export async function loadDayView(
  db: Db,
  args: { businessId: string; day: string; now: Date },
): Promise<DayView> {
  const business = await db.business.findUniqueOrThrow({
    where: { id: args.businessId },
    select: { timezone: true, cancellationCutoffMinutes: true },
  });
  const zone = business.timezone as ZoneId;
  const day = calendarDay(args.day);
  const weekday = weekdayOf(day);

  const providers = await db.provider.findMany({
    where: { businessId: args.businessId, active: true },
    orderBy: [{ displayOrder: 'asc' }, { displayName: 'asc' }],
    select: { id: true, displayName: true },
  });

  // The widest span the day can touch, for the queries. Local midnight either
  // side plus a day of slack covers an overnight window and anything whose
  // buffers hang off the ends.
  const from = toDate(instant(startOfDay(day, zone) - 24 * 60 * MIN));
  const to = toDate(instant(startOfDay(addDays(day, 1), zone) + 24 * 60 * MIN));

  // One read for the whole day rather than one per column: the delta table is
  // keyed by (provider, day), so the day's rows are a single indexed lookup.
  const late = await findRunningLate(db, { businessId: args.businessId, day: args.day });
  const lateByProvider = new Map(late.map((row) => [row.providerId, row.minutes]));

  const columns = await Promise.all(
    providers.map((provider) =>
      loadColumn(db, {
        ...args,
        provider,
        zone,
        day,
        weekday,
        from,
        to,
        runningLateMinutes: lateByProvider.get(provider.id) ?? null,
      }),
    ),
  );

  // The room is read over the SAME wide query bounds the columns used, so a
  // hold whose envelope hangs off either end is fetched rather than clipped
  // out of the data; the view model clamps it to the rendered height.
  const room = await loadRoom(db, { businessId: args.businessId, from, to });

  return {
    day: args.day,
    timezone: business.timezone,
    cancellationCutoffMinutes: business.cancellationCutoffMinutes,
    ...renderBounds(day, zone, columns),
    columns,
    room,
  };
}

// ─────────────────────────── internals ───────────────────────────

/**
 * ponytail: one round of queries PER PROVIDER, run concurrently. Four columns
 * is four small indexed reads and the constraint is the salon's chair count
 * (D-20), so the ceiling is a handful. If a much larger roster ever appears,
 * the fix is to batch the two per-provider reads by `providerId IN (...)` —
 * the shapes already return the id on every row.
 */
async function loadColumn(
  db: Db,
  args: {
    businessId: string;
    provider: { id: string; displayName: string };
    zone: ZoneId;
    day: ReturnType<typeof calendarDay>;
    weekday: number;
    from: Date;
    to: Date;
    now: Date;
    runningLateMinutes: number | null;
  },
): Promise<DayColumn> {
  const [resolved, busy, absences, rows] = await Promise.all([
    resolveDayWindows(db, {
      businessId: args.businessId,
      providerId: args.provider.id,
      day: args.day,
      weekday: args.weekday,
    }),
    findBusyAppointments(db, { providerId: args.provider.id, windowStart: args.from, windowEnd: args.to }),
    findAbsences(db, { providerId: args.provider.id, windowStart: args.from, windowEnd: args.to }),
    db.appointment.findMany({
      where: {
        providerId: args.provider.id,
        businessId: args.businessId,
        // An INSTANT-overlap predicate, never `WHERE date(startAt) = day` —
        // the 23:30 booking that runs past midnight belongs to both days.
        startAt: { lt: args.to },
        endAt: { gt: args.from },
      },
      orderBy: { startAt: 'asc' },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        status: true,
        isOverride: true,
        overrideReason: true,
        notes: true,
        client: { select: { id: true, name: true, phone: true, notes: true } },
        lines: { orderBy: { ordinal: 'asc' }, select: { service: { select: { name: true } } } },
      },
    }),
  ]);

  const windows = resolved.windows.map((w) =>
    resolveWindow(
      {
        open: wallTime(w.open),
        close: wallTime(w.close),
        endsNextDay: w.endsNextDay,
        breaks: w.breaks.map((b) => ({ open: wallTime(b.open), close: wallTime(b.close) })),
      },
      args.day,
      args.zone,
    ),
  );

  const windowSpans = windows.map((w) => w.span);
  const breakSpans = windows.flatMap((w) => [...w.breaks]);

  /**
   * THE COLUMN IS CLIPPED BACK TO THE DAY.
   *
   * The queries above deliberately span local midnight ±24h — the busy set
   * needs that width so a neighbouring day's buffers still subtract correctly,
   * and an overnight window needs it to exist at all. But an appointment is
   * DISPLAYED in this column only if it overlaps the day itself or one of the
   * provider's windows for it.
   *
   * Found by demo checkpoint 2: without this, Dana's Tuesday column showed 29
   * appointments running into Wednesday afternoon. Every A-016 test passed,
   * because each one seeded a single day — the defect needs a neighbouring day
   * with rows in it to appear at all, which is exactly what a seeded week has
   * and a unit fixture does not.
   */
  const dayStart = startOfDay(args.day, args.zone);
  const dayEnd = startOfDay(addDays(args.day, 1), args.zone);
  const onScreen: Span[] = [{ start: dayStart, end: dayEnd }, ...windowSpans];
  const belongsHere = (start: Date, end: Date) =>
    onScreen.some((span) => fromDate(start) < span.end && span.start < fromDate(end));

  // The two reads meet here: the raw one knows which range each appointment
  // OCCUPIES (D-16), the Prisma one knows what to write on the chip.
  const occupied = new Map(busy.map((b) => [b.id, b]));
  const appointments: DayAppointment[] = rows
    .filter((row) => belongsHere(row.startAt, row.endAt))
    .filter((row) => occupied.has(row.id) || !isActive(row.status))
    .map((row) => {
      const span = occupied.get(row.id);
      return {
        id: row.id,
        startAt: row.startAt,
        endAt: row.endAt,
        occupiesStart: span?.start ?? row.startAt,
        occupiesEnd: span?.end ?? row.endAt,
        status: row.status,
        isOverride: row.isOverride,
        overrideReason: row.overrideReason,
        serviceNames: row.lines.map((l) => l.service.name),
        clientId: row.client?.id ?? null,
        clientName: row.client?.name ?? null,
        clientPhone: row.client?.phone ?? null,
        clientNotes: row.client?.notes ?? null,
        notes: row.notes,
      };
    });

  // A gap is what is left of the working hours once breaks, absences and the
  // busy set are taken out. Breaks are subtracted too: lunch is not bookable
  // time, and a grid that offered it would send the front desk to interrupt a
  // stylist eating.
  const taken: Span[] = [
    ...breakSpans,
    ...absences.map((a) => ({ start: fromDate(a.start), end: fromDate(a.end) })),
    ...busy.map((b) => ({ start: fromDate(b.start), end: fromDate(b.end) })),
  ];

  return {
    providerId: args.provider.id,
    providerName: args.provider.displayName,
    runningLateMinutes: args.runningLateMinutes,
    closed: resolved.closed,
    windows: windowSpans.map(toDateSpan),
    breaks: breakSpans.map(toDateSpan),
    appointments,
    absences: absences.filter((a) => belongsHere(a.start, a.end)),
    gaps: subtractSpans(windowSpans, taken).map((span) => ({
      start: toDate(span.start),
      end: toDate(span.end),
      minutes: (span.end - span.start) / MIN,
    })),
  };
}

/**
 * Which statuses still occupy time, asked of the same module the constraint
 * and the busy query derive from (D-15).
 *
 * Used only to decide whether a row the busy query DIDN'T return should still
 * be drawn: a cancelled appointment is shown in the column, greyed, because
 * "she cancelled" is information the front desk needs when the client turns up
 * anyway — but it occupies nothing.
 */
function isActive(status: string): boolean {
  return !CANCELLED.has(status);
}
const CANCELLED = new Set(['cancelled', 'cancelled_late']);

const toDateSpan = (span: Span) => ({ start: toDate(span.start), end: toDate(span.end) });

/**
 * The vertical extent of the grid.
 *
 * Local midnight to local midnight is the base, widened by anything that pokes
 * out — an overnight window, or a staff override booked before opening. Not
 * fixed at 00:00–24:00: a salon working 09:00–18:00 would render fifteen empty
 * hours and squeeze the working day into a third of the screen.
 */
function renderBounds(
  day: ReturnType<typeof calendarDay>,
  zone: ZoneId,
  columns: DayColumn[],
): { from: Date; to: Date } {
  const edges = columns.flatMap((column) => [
    ...column.windows.flatMap((w) => [fromDate(w.start), fromDate(w.end)]),
    ...column.appointments.flatMap((a) => [fromDate(a.occupiesStart), fromDate(a.occupiesEnd)]),
    ...column.absences.flatMap((a) => [fromDate(a.start), fromDate(a.end)]),
  ]);

  if (edges.length === 0) {
    // A day with nothing on it still needs a height, or the grid collapses.
    return { from: toDate(startOfDay(day, zone)), to: toDate(startOfDay(addDays(day, 1), zone)) };
  }

  return { from: toDate(instant(Math.min(...edges))), to: toDate(instant(Math.max(...edges))) };
}
