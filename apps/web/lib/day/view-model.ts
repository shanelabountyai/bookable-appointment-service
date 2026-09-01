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
import type { DayColumn, DayRoom, DayView } from '@bookable/db/day';
import { type AppointmentStatus, availableTransitions } from '@bookable/core/scheduling';
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
  /** A-062. The BODY's length in PHYSICAL minutes — what the stylist has the
   *  chair for, not the envelope `minutes` the chip is drawn from. Appointments
   *  only. */
  durationMinutes?: number;
  title: string;
  detail?: string;
  /** CLIENT-03's pinned note, surfaced on the chip because an allergy is a
   *  safety surface rather than a detail. */
  pinnedNote?: string;
  /**
   * A-070 (CLIENT-03) — THE NOTE ABOUT TODAY, as opposed to the note about
   * HER. "Patch test done 12/4." "6.3 + 20 vol, 35 min." "Bring the reference
   * photo."
   *
   * `day-view.ts` has selected and returned it since A-016 and this model
   * dropped it on the floor, so the desk typed it on one screen and the
   * stylist at the backwash could read it on none. The printed sheet then
   * carried only the pinned CLIENT note, which made A-062's blank scribble
   * column the salon writing the colour formula on paper and binning it at
   * six — and left the patch-test line, which is a safety surface, in the one
   * place nobody looks.
   *
   * NEVER MERGED with `pinnedNote`. `Appointment.notes` exists precisely
   * because per-visit notes bury the allergy line.
   */
  visitNote?: string;
  /** CLIENT-04's flag, already worded. On the chip for the same reason as the
   *  note: the day grid is where the desk decides who to ring this morning,
   *  and "she has missed the last two" is that decision. */
  missed?: string;
  status?: AppointmentStatus;
  /** A-035. Present on appointment items only — the status buttons post it. */
  appointmentId?: string;
  /**
   * A-035. What the front desk may do to this one RIGHT NOW, from the §7
   * table, asked with the real actor and the real clock — never assembled by a
   * screen. Empty for anything terminal, and empty for every non-appointment
   * item.
   */
  available?: AppointmentStatus[];
  isOverride?: boolean;
  /** APPT-03's projected start: what time this is REALLY likely to begin,
   *  given how far behind she is. Shown beside the scheduled time, never
   *  instead of it — the client was booked for 14:00 and her confirmation
   *  still says so. */
  projected?: string;
  /** A-069 / D-44 — the instant the desk gave this no-show's remaining time
   *  back. Present only on a released one; the chip keeps its booked extent,
   *  so this is what explains the bookable gap sitting on top of it. */
  released?: string;
  href?: string;
  /** The whole chip as one sentence, for a screen reader and for the
   *  accessible name of the link. */
  label: string;
}

/**
 * A-059 (APPT-03) — one client the desk still has to ring, formatted.
 *
 * Every time here was formatted server-side in the SALON's zone, like every
 * other time that reaches the browser in this project. The `tel:` href is the
 * raw number: a phone dialler is not a display surface.
 */
export interface CallRow {
  appointmentId: string;
  clientName: string;
  /** Null for a walk-in with no record, and for a client with no number on
   *  file — which is a fact the desk needs, not a row to hide. */
  phone: string | null;
  /** The time on her confirmation. Unchanged by the delta (D-22), and shown
   *  because it is the time she is currently planning her morning around. */
  scheduled: string;
  /** Scheduled + the delta: when she is really likely to be seen. */
  projected: string;
  href: string;
  /** CLIENT-03's pinned note and CLIENT-04's flag, the same two the chip
   *  carries — the desk decides how to open the call from these. */
  note?: string;
  missed?: string;
  /** "Told at 14:12 by Sam", or absent. */
  told?: string;
  /** She was told about a materially different number and is owed a second
   *  call. */
  stale?: boolean;
}

export interface GridColumn {
  providerId: string;
  providerName: string;
  closed: boolean;
  /** D-22, for the column header's "Dana +38". */
  runningLateMinutes: number | null;
  /** A-059. Who is still on their way and has to be RUNG — empty unless a
   *  delta is set. Nothing on this list has been sent to anybody. */
  calls: CallRow[];
  /** APPT-04's "from here": the first appointment still ahead of `now`, as an
   *  INSTANT. Null when there is nothing left in the column to push. */
  pushFrom: string | null;
  items: GridItem[];
  /** Where this provider's working hours sit, for shading the column. */
  windows: { top: number; minutes: number }[];
}

/** A-046. One chair, as a track down the same day the columns run down. */
export interface RoomTrack {
  resourceId: string;
  name: string;
  active: boolean;
  blocks: {
    key: string;
    top: number;
    minutes: number;
    title: string;
    detail: string;
    href: string;
    label: string;
  }[];
}

export interface RoomModel {
  typeName: string;
  /** ACTIVE resources — the number the engine's "room full" answer was
   *  computed against, shown so the desk can check it against what it can see. */
  capacity: number;
  tracks: RoomTrack[];
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
  /** A-046 — the room, on the same vertical scale as the columns. */
  room: RoomModel[];
}

export function toGridModel(
  view: DayView,
  now: Date,
  dayLabel: string,
  /** CLIENT-04 flags by client id, already worded by the caller. Optional so
   *  the model stays testable without a database. */
  missedByClient: ReadonlyMap<string, string> = new Map(),
  /** A-037's names by staff id, so "told by" is a person rather than "the
   *  front desk" — which is four people. */
  staffNames: ReadonlyMap<string, string> = new Map(),
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
      toColumn(
        column,
        { minutesFrom, clock, range, shift },
        view.day,
        now,
        missedByClient,
        view.cancellationCutoffMinutes,
        staffNames,
      ),
    ),
    room: view.room.map((type) => toRoom(type, { minutesFrom, clock, range, shift }, total)),
  };
}

/**
 * A-046 — the room as tracks.
 *
 * Clamped to the rendered height rather than allowed to stretch it: a hold's
 * envelope includes buffers, so a 09:00 colour with a ten-minute before-buffer
 * legitimately starts before the first working window. Letting that widen the
 * grid would move every provider column to make room for a strip that is
 * explaining them — so the block is trimmed, and a block trimmed to nothing is
 * dropped rather than drawn as a hairline nobody can read.
 */
function toRoom(type: DayRoom, f: Formatters, total: number): RoomModel {
  return {
    typeName: type.typeName,
    capacity: type.capacity,
    tracks: type.resources.map((resource) => ({
      resourceId: resource.id,
      name: resource.name,
      active: resource.active,
      blocks: resource.holds.flatMap((hold) => {
        const top = Math.max(0, f.minutesFrom(hold.start));
        const minutes = Math.min(total, f.minutesFrom(hold.end)) - top;
        if (minutes <= 0) return [];
        const who = hold.clientName ?? 'Walk-in';
        const services = hold.serviceNames.join(' + ');
        return [
          {
            key: hold.appointmentId,
            top,
            minutes,
            title: who,
            detail: [hold.providerName, services].filter(Boolean).join(' · '),
            href: `/staff/appointments/${hold.appointmentId}`,
            // The envelope's OWN range, not the appointment's body: this strip
            // exists to show that the chair is held longer than the stylist is
            // busy, and a label reading the body times would hide exactly that.
            label: `${resource.name}, ${f.range(hold.start, hold.end)}, ${who} with ${hold.providerName}${services ? `, ${services}` : ''}`,
          },
        ];
      }),
    })),
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
  cutoffMinutes: number,
  staffNames: ReadonlyMap<string, string>,
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
        durationMinutes: (appointment.endAt.getTime() - appointment.startAt.getTime()) / MIN,
        title: who,
        detail: [services, appointment.clientPhone].filter(Boolean).join(' · '),
        pinnedNote: appointment.clientNotes ?? undefined,
        // A-070. Selected by `day-view.ts` since A-016 and dropped here until
        // now — an oversight rather than a decision, which is why it is one
        // line.
        visitNote: appointment.notes ?? undefined,
        ...(missed ? { missed } : {}),
        status: appointment.status as AppointmentStatus,
        appointmentId: appointment.id,
        // A-035 — the buttons on the chip, decided HERE by the §7 table with
        // the real actor and the real clock. The screen renders this list and
        // holds no opinion of its own about what is allowed.
        available: chipMoves(appointment.status as AppointmentStatus, {
          actor: 'staff',
          now: fromDate(now),
          startAt: fromDate(appointment.startAt),
          endAt: fromDate(appointment.endAt),
          cancellationCutoffMinutes: cutoffMinutes,
          // DELIBERATELY NO REASON. A chip has no reason box, so asking with
          // one would offer a button the write path then refuses — which is
          // how the walk-out and the terminal corrections (APPT-06) stay on
          // the detail panel, where the reason they require can be typed.
        }),
        isOverride: appointment.isOverride,
        // A-069. The gap chip painting over her is the released time, and it
        // is clickable — this is the sentence that makes that legible instead
        // of alarming.
        ...(appointment.releasedAt ? { released: f.clock(appointment.releasedAt) } : {}),
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
          appointment.releasedAt ? `time given back from ${f.clock(appointment.releasedAt)}` : '',
          appointment.clientNotes ? `note: ${appointment.clientNotes}` : '',
          // Worded so the two cannot be confused when they are read aloud one
          // after the other: one is about her, one is about today.
          appointment.notes ? `today: ${appointment.notes}` : '',
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
    calls: column.lateCalls.map((call) => {
      const who = call.clientName ?? 'Walk-in';
      return {
        appointmentId: call.appointmentId,
        clientName: who,
        phone: call.clientPhone,
        scheduled: f.clock(call.scheduled),
        projected: f.clock(call.projected),
        href: `/staff/appointments/${call.appointmentId}`,
        ...(call.note ? { note: call.note } : {}),
        ...(call.clientId && missedByClient.get(call.clientId)
          ? { missed: missedByClient.get(call.clientId)! }
          : {}),
        ...(call.told
          ? {
              told: `Told at ${f.clock(call.told.createdAt)}${
                call.told.actorRef && staffNames.get(call.told.actorRef)
                  ? ` by ${staffNames.get(call.told.actorRef)}`
                  : ''
              }`,
            }
          : {}),
        ...(call.stale ? { stale: true as const } : {}),
      };
    }),
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

/**
 * THE FOUR MOVES A CHIP CARRIES (A-035, operator P-4): check in, start,
 * finish, no-show. The visit going forwards.
 *
 * This is a decision about the SURFACE, not about what is legal — legality is
 * still the §7 table's answer and this only narrows it. Two edges are left off
 * on purpose:
 *  - CANCELLING. Legal from a chip with no reason, and a mis-tap on a phone
 *    would end a client's appointment with no record of why. It keeps the
 *    detail panel, where the client, her history and a reason box are.
 *  - CONFIRMING. It belongs to the call-down, which is a different errand done
 *    at a different time of day, and a fifth button costs the four that matter.
 */
const ON_THE_CHIP = new Set<AppointmentStatus>(['checked_in', 'in_progress', 'completed', 'no_show']);

function chipMoves(status: AppointmentStatus, context: Parameters<typeof availableTransitions>[1]): AppointmentStatus[] {
  return availableTransitions(status, context).filter((to) => ON_THE_CHIP.has(to));
}

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
