import 'server-only';

/**
 * A-016 — turning a `DayView` into something the browser can position.
 *
 * EVERY zone conversion and every label happens HERE, on the server. What
 * crosses to the client is minutes-from-the-top and text: no instants, no
 * timezone, no `Date`. The browser formatting a time would format it in the
 * VISITOR's zone (spec §3.D) — which on a laptop the front desk brought back
 * from holiday is not the salon's.
 *
 * Minutes rather than pixels, so the grid's scale is a CSS decision and this
 * file has no opinion about it.
 */
import type { DayColumn, DayView } from '@bookable/db/day';
import type { AppointmentStatus } from '@bookable/core/scheduling';
import { type ZoneId, fromDate, instant, toDate, toLabel } from '@bookable/core/time';

const MIN = 60_000;

export type ItemKind = 'appointment' | 'absence' | 'break' | 'gap';

export interface GridItem {
  key: string;
  kind: ItemKind;
  /** Offset from the top of the grid, in minutes. */
  top: number;
  minutes: number;
  /** "10:00–11:00" in the salon's zone. */
  time: string;
  title: string;
  detail?: string;
  /** CLIENT-03's pinned note, surfaced on the chip because an allergy is a
   *  safety surface rather than a detail. */
  pinnedNote?: string;
  /** CLIENT-04's flag, already worded. On the chip for the same reason as the
   *  note: the day grid is where the desk decides who to ring this morning,
   *  and "she has missed the last two" is that decision. */
  missed?: string;
  status?: AppointmentStatus;
  isOverride?: boolean;
  /** APPT-03's projected start: what time this is REALLY likely to begin,
   *  given how far behind she is. Shown beside the scheduled time, never
   *  instead of it — the client was booked for 14:00 and her confirmation
   *  still says so. */
  projected?: string;
  href?: string;
  /** The whole chip as one sentence, for a screen reader and for the
   *  accessible name of the link. */
  label: string;
}

export interface GridColumn {
  providerId: string;
  providerName: string;
  closed: boolean;
  /** D-22, for the column header's "Dana +38". */
  runningLateMinutes: number | null;
  /** APPT-04's "from here": the first appointment still ahead of `now`, as an
   *  INSTANT. Null when there is nothing left in the column to push. */
  pushFrom: string | null;
  items: GridItem[];
  /** Where this provider's working hours sit, for shading the column. */
  windows: { top: number; minutes: number }[];
}

export interface GridModel {
  day: string;
  /** "Tuesday 9 June", server-formatted. */
  dayLabel: string;
  totalMinutes: number;
  /** Hour marks for the gutter. */
  ticks: { top: number; label: string }[];
  /** Null when the day being viewed is not today — a now-line on Thursday's
   *  page pointing at Tuesday's 2pm is a lie the eye believes. */
  nowTop: number | null;
  columns: GridColumn[];
}

export function toGridModel(
  view: DayView,
  now: Date,
  dayLabel: string,
  /** CLIENT-04 flags by client id, already worded by the caller. Optional so
   *  the model stays testable without a database. */
  missedByClient: ReadonlyMap<string, string> = new Map(),
): GridModel {
  const zone = view.timezone as ZoneId;
  const from = fromDate(view.from);
  const total = Math.max(60, (fromDate(view.to) - from) / MIN);
  const minutesFrom = (at: Date) => (fromDate(at) - from) / MIN;
  const clock = (at: Date) => toLabel(fromDate(at), zone).time;
  const range = (start: Date, end: Date) => `${clock(start)}–${clock(end)}`;
  /** A time moved forward by N minutes, formatted — the projected start. On
   *  the PHYSICAL axis, so a projection across a DST transition lands where
   *  the clock will actually be. */
  const shift = (at: Date, minutes: number) => clock(toDate(instant(fromDate(at) + minutes * MIN)));

  const nowMinutes = (fromDate(now) - from) / MIN;
  const nowTop = nowMinutes >= 0 && nowMinutes <= total ? nowMinutes : null;

  return {
    day: view.day,
    dayLabel,
    totalMinutes: total,
    ticks: hourTicks(view, zone, from, total),
    nowTop,
    columns: view.columns.map((column) =>
      toColumn(column, { minutesFrom, clock, range, shift }, view.day, now, missedByClient),
    ),
  };
}

// ─────────────────────────── internals ───────────────────────────

interface Formatters {
  minutesFrom: (at: Date) => number;
  clock: (at: Date) => string;
  range: (start: Date, end: Date) => string;
  shift: (at: Date, minutes: number) => string;
}

function toColumn(
  column: DayColumn,
  f: Formatters,
  day: string,
  now: Date,
  missedByClient: ReadonlyMap<string, string>,
): GridColumn {
  const items: GridItem[] = [
    ...column.breaks.map((brk, i) => ({
      key: `break-${i}`,
      kind: 'break' as const,
      top: f.minutesFrom(brk.start),
      minutes: (brk.end.getTime() - brk.start.getTime()) / MIN,
      time: f.range(brk.start, brk.end),
      title: 'Break',
      label: `Break, ${f.range(brk.start, brk.end)}`,
    })),
    ...column.absences.map((absence) => ({
      key: `absence-${absence.id}`,
      kind: 'absence' as const,
      top: f.minutesFrom(absence.start),
      minutes: (absence.end.getTime() - absence.start.getTime()) / MIN,
      time: f.range(absence.start, absence.end),
      // An ad-hoc block is NOT time off. Telling the front desk a stylist is
      // away when she is standing there is how a screen stops being read.
      title: absence.kind === 'time_off' ? 'Time off' : 'Blocked',
      detail: absence.reason ?? undefined,
      label: `${absence.kind === 'time_off' ? 'Time off' : 'Blocked'}, ${f.range(absence.start, absence.end)}${absence.reason ? `, ${absence.reason}` : ''}`,
    })),
    ...column.gaps.map((gap) => ({
      key: `gap-${gap.start.toISOString()}`,
      kind: 'gap' as const,
      top: f.minutesFrom(gap.start),
      minutes: gap.minutes,
      time: f.range(gap.start, gap.end),
      title: `${gap.minutes} min free`,
      // A-017 gave the gap somewhere to go, which is what A-016 deliberately
      // waited for. The link carries the INSTANT (D-4), never a wall label:
      // on the day the clocks go back, "01:30" names two of these.
      href: `/staff/book?provider=${column.providerId}&at=${encodeURIComponent(gap.start.toISOString())}&day=${day}`,
      label: `Book ${gap.minutes} minutes free, ${f.range(gap.start, gap.end)}, with ${column.providerName}`,
    })),
    ...column.appointments.map((appointment) => {
      const who = appointment.clientName ?? 'Walk-in';
      const services = appointment.serviceNames.join(' + ');
      const missed = appointment.clientId ? missedByClient.get(appointment.clientId) : undefined;
      return {
        key: `appointment-${appointment.id}`,
        kind: 'appointment' as const,
        top: f.minutesFrom(appointment.occupiesStart),
        minutes: (appointment.occupiesEnd.getTime() - appointment.occupiesStart.getTime()) / MIN,
        time: f.range(appointment.startAt, appointment.endAt),
        title: who,
        detail: [services, appointment.clientPhone].filter(Boolean).join(' · '),
        pinnedNote: appointment.clientNotes ?? undefined,
        ...(missed ? { missed } : {}),
        status: appointment.status as AppointmentStatus,
        isOverride: appointment.isOverride,
        // Only for what has not started yet: projecting a time onto an
        // appointment already in the chair is noise, and projecting onto a
        // finished one is wrong.
        ...(column.runningLateMinutes && appointment.status === 'booked'
          ? { projected: f.shift(appointment.startAt, column.runningLateMinutes) }
          : {}),
        // A-027 exists now, so a chip goes to the APPOINTMENT rather than to
        // the client record. The front desk's next question is "what happened
        // to this one?", and the client is one link further on from there —
        // and a walk-in with no client record finally has a destination.
        href: `/staff/appointments/${appointment.id}`,
        label: [
          `${f.range(appointment.startAt, appointment.endAt)}, ${who}`,
          services,
          STATUS_WORDS[appointment.status as AppointmentStatus],
          appointment.isOverride ? 'booked as an override' : '',
          appointment.clientNotes ? `note: ${appointment.clientNotes}` : '',
          missed ?? '',
          column.runningLateMinutes && appointment.status === 'booked'
            ? `likely ${f.shift(appointment.startAt, column.runningLateMinutes)}`
            : '',
        ]
          .filter(Boolean)
          .join(', '),
      };
    }),
  ];

  return {
    providerId: column.providerId,
    providerName: column.providerName,
    closed: column.closed,
    runningLateMinutes: column.runningLateMinutes,
    // "From here" means the next appointment, not an arbitrary clock time:
    // pushing starts at the first client who has not sat down yet.
    pushFrom:
      column.appointments
        .filter((a) => a.startAt.getTime() >= now.getTime() && !CANCELLED.has(a.status))
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0]
        ?.startAt.toISOString() ?? null,
    // CHRONOLOGICAL DOM ORDER, whatever the visual layering. The items are
    // absolutely positioned, so tab order and screen-reader order come from
    // here — sorting by anything else makes the column read out of sequence.
    items: items.sort((a, b) => a.top - b.top || a.minutes - b.minutes),
    windows: column.windows.map((w) => ({
      top: f.minutesFrom(w.start),
      minutes: (w.end.getTime() - w.start.getTime()) / MIN,
    })),
  };
}

/**
 * A tick on each whole hour the grid covers.
 *
 * Walked on the INSTANT axis and labelled through the one conversion module,
 * so a spring-forward day shows 01:00 then 03:00 — which is what the clocks
 * actually did, and what a stylist looking for her 2am appointment needs to
 * see. Generating labels by incrementing an hour counter would invent an 02:00
 * that did not happen.
 */
function hourTicks(view: DayView, zone: ZoneId, from: number, total: number): { top: number; label: string }[] {
  const ticks: { top: number; label: string }[] = [];
  const start = fromDate(view.from);
  // Round up to the next whole hour on the physical axis.
  const first = Math.ceil(start / (60 * MIN)) * 60 * MIN;

  for (let t = first; (t - from) / MIN <= total; t += 60 * MIN) {
    ticks.push({ top: (t - from) / MIN, label: toLabel(t as ReturnType<typeof fromDate>, zone).time });
  }
  return ticks;
}

const CANCELLED = new Set(['cancelled', 'cancelled_late']);

/** For the accessible name. The visible chip shows a colour and a short word;
 *  a screen reader gets the sentence. */
const STATUS_WORDS = {
  booked: 'booked',
  confirmed: 'confirmed',
  checked_in: 'checked in',
  in_progress: 'in progress',
  completed: 'completed',
  no_show: 'no-show',
  cancelled: 'cancelled',
  cancelled_late: 'cancelled late',
} satisfies Record<AppointmentStatus, string>;

export { STATUS_WORDS };
