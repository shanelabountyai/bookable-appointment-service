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
 * A-067 — AND A CANCELLATION IS NOT THE ONLY THING THAT FREES TIME. Mrs Hall
 * is booked cut + full head, two hours of a Saturday; she sits down and wants
 * the roots only. A-055 does exactly what it should — the visit shortens, no
 * cancellation, no notice — and ninety minutes of a Saturday afternoon became
 * INVISIBLE here, because this file asked the status column what had been
 * freed and a shortened visit is still `booked`. Same for a reschedule off the
 * day and a cross-provider reassign. (A-055's backlog row claimed the tail
 * reached this list "for free, because it derives". It did not, and this is
 * that claim's correction — CLAUDE.md's "a state change is never one edit".)
 *
 * SO THERE ARE TWO SOURCES, not two lists: the status column answers "who gave
 * the whole thing back", and the EVENT LOG answers "what stopped being
 * occupied" — `services_changed`, `rescheduled` and `provider_changed` all
 * record BOTH sides (D-31), which is what makes the vacated span derivable at
 * all. The log also carries a real timestamp, so those three get an honest
 * recency bound rather than the `updatedAt` heuristic the cancellations still
 * stand on.
 *
 * DERIVED ON EVERY READ, NOTHING STORED — the same reflex as AVAIL-05's
 * conflicts (operator R-7) and A-021's call-down. "This slot is open" stops
 * being true the moment somebody books it, and a stored flag would need its
 * own clearing code in every one of those paths. Adding three more ways to
 * free time is precisely why: none of them needed clearing code.
 *
 * THE LIST IS BOUNDED IN THREE DIRECTIONS, and the tests are mostly about the
 * bounds rather than the contents: `appointmentsInRange` next door has no
 * lower time bound at all, which is safe there (its window is the absence
 * being written) and would be ruinous here — every cancellation the salon has
 * ever taken, forever.
 */
import { SLOT_FREEING_STATUSES } from '../../core/scheduling';
import { InvalidTimeValue, fromDate, instant, instantFromIso, toDate } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { findAbsences } from '../availability/availability';
import { findBusyAppointments } from '../scheduling/busy-set';

type Db = Prisma.TransactionClient | PrismaClient;

/** How long a freed slot stays news. Past this it is not "what just opened
 *  up" any more, it is simply an empty column, and the day grid is already
 *  the screen for that. */
export const FREED_LOOKBACK_DAYS = 14;

const DAY_MS = 86_400_000;

/** The event types that vacate time without freeing the whole appointment.
 *  Every one of them records both sides in its payload (D-31) — that is the
 *  property this file depends on, not the name. */
const VACATING_EVENT_TYPES = ['services_changed', 'rescheduled', 'provider_changed'] as const;

/**
 * WHY the span is empty, in enough structure for the web layer to word it —
 * the follow-up phone call is a different call in each case ("shall we find
 * you another time?" is not what you say about Mrs Hall's dropped colour), and
 * wording lives next to `event-language.ts`, not in a query.
 */
export type FreedBy =
  | { kind: 'cancelled' }
  /** A-055 shortened the visit; this is the tail it let go of. */
  | { kind: 'shortened'; droppedServiceNames: string[] }
  /** D-6 moved the whole visit; this is the range it left behind. */
  | { kind: 'rescheduled'; movedToStartAt: Date }
  /** A-038/A-042 handed it to another stylist; this chair is now empty. */
  | { kind: 'reassigned'; movedToProviderName: string };

export interface OpenedSlot {
  /** Stable per ROW, not per appointment: one visit shortened twice frees two
   *  separate tails, and they are two phone calls. */
  key: string;
  appointmentId: string;
  providerId: string;
  providerName: string;
  /** The freed span's start — what the desk reads, and what the ordering is
   *  on. For a cancellation that is the body start, as it always was. */
  startAt: Date;
  /** Buffer-inclusive, because that is the range the exclusion constraint let
   *  go of and the range `matchFreedSlot` measures a service against. */
  blockedStart: Date;
  blockedEnd: Date;
  freedMinutes: number;
  /** `matchFreedSlot` matches ONE service, so this is the seed: the service
   *  she dropped when she dropped one, the visit's first line otherwise. */
  primaryServiceId: string | null;
  serviceNames: string[];
  status: string;
  /** Whose time it was — on the row for the same reason AVAIL-05's conflicts
   *  and A-021's call-down put it there: "shall we find you another time?" is
   *  a call, and a list you have to click through is a list the desk copies
   *  onto paper. */
  clientName: string | null;
  clientPhone: string | null;
  freedBy: FreedBy;
}

/** One candidate span before the still-empty bound has been applied. */
type Candidate = OpenedSlot;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Payloads are JSON, so every field is `unknown` until proven otherwise — one
 *  malformed row must not take the screen down (`event-language.ts`'s rule). */
const asDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  try {
    // The boundary parser, never `new Date(string)` — banned repo-wide, and
    // these payloads are `toISOString()` output so the offset is always there.
    return toDate(instantFromIso(value));
  } catch (error) {
    if (error instanceof InvalidTimeValue) return null;
    throw error;
  }
};

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const minutesBetween = (start: Date, end: Date) => Math.round((fromDate(end) - fromDate(start)) / 60_000);

/**
 * Future time that recently stopped being occupied and is still empty,
 * soonest first.
 *
 * `now` is injected, never read from the clock here — same discipline as
 * `listUnconfirmedTomorrow` and `clientReliability`.
 *
 * Ordered by how soon the time EXPIRES, not by when it was freed: a Thursday
 * 2pm dies on Thursday at 2 whether it was freed this morning or a week ago,
 * and the one at the top is the one worth a phone call now.
 */
export async function listOpenedSlots(
  db: Db,
  args: { businessId: string; now: Date; lookbackDays?: number },
): Promise<OpenedSlot[]> {
  const since = toDate(instant(fromDate(args.now) - (args.lookbackDays ?? FREED_LOOKBACK_DAYS) * DAY_MS));

  const [cancelled, vacated] = await Promise.all([
    cancelledCandidates(db, args, since),
    vacatedCandidates(db, args, since),
  ]);

  // BOUND 3 — still empty. One pair of reads per candidate rather than one
  // query for the lot: `findBusyAppointments` is the only reader that gets
  // D-16's `overriddenFromRange` and D-29's per-block ranges right, and
  // re-implementing that predicate here to save a round trip is exactly the
  // second copy CLAUDE.md keeps out. Bounded by the two bounds above — a
  // salon's fortnight of freed time, not a table scan.
  //
  // It is also the ONLY thing that retires a row, which is what keeps all four
  // sources derived: re-lengthen the visit, move it back, hand it back to
  // Dana, or simply sell the gap, and the span stops being empty. No path
  // anywhere has to remember to clear anything.
  const open = await Promise.all(
    cancelled.concat(vacated).map(async (row) => {
      const window = { providerId: row.providerId, windowStart: row.blockedStart, windowEnd: row.blockedEnd };
      const [busy, absences] = await Promise.all([
        // A cancelled row is not in its own busy set: its blocks carry its own
        // status and ACTIVE_STATUSES excludes it. A SHORTENED one very much
        // is — which is why its span starts at the new `blockedEnd` and not a
        // minute earlier.
        findBusyAppointments(db, window),
        // Time off over the freed slot means it did not open up — Dana is off,
        // and that appointment is the conflicts screen's problem, not a thing
        // to sell to the waitlist.
        findAbsences(db, window),
      ]);
      return busy.length === 0 && absences.length === 0 ? row : null;
    }),
  );

  return open
    .flatMap((row) => (row === null ? [] : [row]))
    .sort((a, b) => fromDate(a.startAt) - fromDate(b.startAt) || a.key.localeCompare(b.key));
}

/** The whole visit given back: the status column is the record of it. */
async function cancelledCandidates(
  db: Db,
  args: { businessId: string; now: Date },
  since: Date,
): Promise<Candidate[]> {
  const rows = await db.appointment.findMany({
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
      // wrong date, right answer. The opposite error is impossible. (The three
      // event-sourced kinds below do not need the heuristic; they have a real
      // timestamp.)
      updatedAt: { gte: since },
      // A cancelled override freed a zero-width range (D-8) — it never held
      // any time to give back, and its `freedMinutes` of 0 matches nothing.
      isOverride: false,
      // Nobody can be booked with a provider who has left (A-041).
      provider: { is: { active: true } },
    },
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

  return rows.map((row) => ({
    key: `cancelled:${row.id}`,
    appointmentId: row.id,
    providerId: row.providerId,
    providerName: row.provider.displayName,
    startAt: row.startAt,
    blockedStart: row.blockedStart,
    blockedEnd: row.blockedEnd,
    freedMinutes: minutesBetween(row.blockedStart, row.blockedEnd),
    primaryServiceId: row.lines[0]?.serviceId ?? null,
    serviceNames: row.lines.map((l) => l.service.name),
    status: row.status,
    clientName: row.client?.name ?? null,
    clientPhone: row.client?.phone ?? null,
    freedBy: { kind: 'cancelled' },
  }));
}

/**
 * A-067. Part of a visit given back, or the whole of it moved elsewhere. The
 * appointment is still live and still `booked`, so nothing about the row says
 * a span was vacated — the EVENT is the only record of the other side, which
 * is exactly what D-31 put it there for.
 */
async function vacatedCandidates(
  db: Db,
  args: { businessId: string; now: Date },
  since: Date,
): Promise<Candidate[]> {
  const events = await db.appointmentEvent.findMany({
    where: {
      businessId: args.businessId,
      type: { in: [...VACATING_EVENT_TYPES] },
      // BOUND 2 — recent, and honestly this time: the event's own timestamp,
      // not a proxy for it.
      createdAt: { gte: since },
      appointment: {
        // A visit that has since been cancelled is already on the list once,
        // whole, from the source above — the tail it dropped last week is not
        // a second phone call.
        status: { notIn: [...SLOT_FREEING_STATUSES] },
        // Same reasoning as above: an override never held a range (D-8).
        isOverride: false,
      },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      type: true,
      payload: true,
      createdAt: true,
      appointmentId: true,
      appointment: {
        select: {
          id: true,
          providerId: true,
          startAt: true,
          endAt: true,
          blockedStart: true,
          blockedEnd: true,
          status: true,
          client: { select: { name: true, phone: true } },
          lines: { orderBy: { ordinal: 'asc' }, select: { serviceId: true, service: { select: { name: true } } } },
        },
      },
    },
  });
  if (events.length === 0) return [];

  // Four chairs. One read of the roster answers "who vacated it, and are they
  // still here?" for every event, including the provider the appointment no
  // longer points at — which is the whole question a reassign asks.
  const providers = new Map(
    (
      await db.provider.findMany({
        where: { businessId: args.businessId },
        select: { id: true, displayName: true, active: true },
      })
    ).map((p) => [p.id, p]),
  );

  return events.flatMap((event): Candidate[] => {
    const appointment = event.appointment;
    const payload = asRecord(event.payload);

    const span = vacatedSpan(event.type, payload, appointment);
    if (span === null) return [];

    // BOUND 1 — still future. A tail that ended at noon cannot be sold at two.
    if (fromDate(span.start) <= fromDate(args.now)) return [];
    // A change that lengthened the visit, or moved it by nothing, vacated
    // nothing. Half-open everywhere (CLAUDE.md), so zero width is no width.
    if (fromDate(span.end) <= fromDate(span.start)) return [];

    const provider = providers.get(span.providerId);
    // Nobody can be booked with a provider who has left (A-041).
    if (provider === undefined || !provider.active) return [];

    const droppedNames = asStrings(payload.removed);
    const droppedIds = asStrings(payload.removedServiceIds);

    return [
      {
        key: `${event.type}:${event.id}`,
        appointmentId: appointment.id,
        providerId: span.providerId,
        providerName: provider.displayName,
        startAt: span.start,
        blockedStart: span.start,
        blockedEnd: span.end,
        freedMinutes: minutesBetween(span.start, span.end),
        // The service she DROPPED is the one to ring the waitlist about — "who
        // else wants a colour on Saturday afternoon?" `removedServiceIds` is
        // A-067's addition to the payload; events written before it fall back
        // to what is still on the visit, which fits the span by construction.
        primaryServiceId: droppedIds[0] ?? appointment.lines[0]?.serviceId ?? null,
        serviceNames: droppedNames.length > 0 ? droppedNames : appointment.lines.map((l) => l.service.name),
        status: appointment.status,
        clientName: appointment.client?.name ?? null,
        clientPhone: appointment.client?.phone ?? null,
        freedBy: span.freedBy,
      },
    ];
  });

  function vacatedSpan(
    type: string,
    payload: Record<string, unknown>,
    appointment: { providerId: string; startAt: Date; endAt: Date; blockedStart: Date; blockedEnd: Date },
  ): { providerId: string; start: Date; end: Date; freedBy: FreedBy } | null {
    switch (type) {
      // A-055 shortened the visit. The tail runs from where the appointment
      // NOW lets go — its recomputed `blockedEnd`, trigger-written, so the
      // buffer arithmetic is not repeated here — to where it USED to let go,
      // which the event records. Starting a minute earlier would name time the
      // visit still holds, and the still-empty bound would then drop the whole
      // row: the appointment is `booked` and very much in its own busy set.
      case 'services_changed': {
        // `fromBlockedEnd` is A-067's addition — the end of the buffer the
        // visit used to carry, which is genuinely sellable now. Events written
        // before it fall back to the body end, which under-reports by one
        // buffer: the safe direction, and never into time she still holds.
        const wasEndingAt = asDate(payload.fromBlockedEnd) ?? asDate(payload.fromEndAt);
        if (wasEndingAt === null) return null;
        return {
          providerId: appointment.providerId,
          start: appointment.blockedEnd,
          end: wasEndingAt,
          freedBy: { kind: 'shortened', droppedServiceNames: asStrings(payload.removed) },
        };
      }
      // D-6 moved the whole visit. The row survives, so the old range exists
      // nowhere but this payload. Buffers are read off the row as offsets from
      // the body — the same service list, so the same buffers, unless the move
      // also crossed stylists with different ones; that shifts an edge by the
      // buffer difference and the still-empty bound then judges the shifted
      // range, which errs toward not listing.
      case 'rescheduled': {
        const from = asDate(payload.from);
        const fromEndAt = asDate(payload.fromEndAt);
        const to = asDate(payload.to);
        if (from === null || fromEndAt === null || to === null) return null;
        const before = fromDate(appointment.startAt) - fromDate(appointment.blockedStart);
        const after = fromDate(appointment.blockedEnd) - fromDate(appointment.endAt);
        return {
          // A move that also changed stylist emptied the chair she LEFT, not
          // the one she is on now — and after the UPDATE the row only knows
          // the latter, which is why the payload carries the former.
          providerId: typeof payload.fromProviderId === 'string' ? payload.fromProviderId : appointment.providerId,
          start: toDate(instant(fromDate(from) - before)),
          end: toDate(instant(fromDate(fromEndAt) + after)),
          freedBy: { kind: 'rescheduled', movedToStartAt: to },
        };
      }
      // A-038/A-042 handed it to another stylist and did not move it, so the
      // range it vacated is the range it still occupies — on the OTHER chair.
      case 'provider_changed': {
        const fromProviderId = payload.fromProviderId;
        if (typeof fromProviderId !== 'string') return null;
        // The stylist half of a move that also changed the time. The
        // `rescheduled` row beside it reports that span already, on the right
        // chair; this one would report the chair she left as free at the time
        // she is now sitting in it. (Cross-provider reschedules written before
        // A-067 have no such marker and will double-report for one lookback.)
        if (payload.viaReschedule === true) return null;
        return {
          providerId: fromProviderId,
          start: appointment.blockedStart,
          end: appointment.blockedEnd,
          freedBy: {
            kind: 'reassigned',
            movedToProviderName: providers.get(appointment.providerId)?.displayName ?? 'another stylist',
          },
        };
      }
      default:
        return null;
    }
  }
}
