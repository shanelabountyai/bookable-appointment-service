/**
 * Availability → SlotQuery (A-026, SLOT-07).
 *
 * Where A-007's wall-clock precedence chain, A-003's rows and A-008's pure
 * engine finally meet. Everything this module does is assemble inputs — the
 * engine stays pure and this file stays free of scheduling rules.
 */
import {
  type BusyInterval,
  type ComposedVisit,
  type Exclusion,
  type Slot,
  type SlotPolicy,
  type SlotQuery,
  type SlotResult,
  type VisitLine,
  calendarDay,
  composeVisit,
  computeSlots,
  instant,
  wallTime,
  zoneId,
} from '../../core/scheduling';
import { type Instant, addDays, fromDate, startOfDay, toDate, weekdayOf } from '../../core/time';
import { effectiveDurationMinutes } from '../../core/settings';
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { findAbsences, resolveDayWindows } from '../availability';
import { findRunningLate, runningLateInterval } from '../day/running-late';
import { requiredResourceTypeId } from '../booking/resources';
import { findBusyAppointments } from './busy-set';
import { type Seating, canSeat, loadSeating } from './resource-load';

type Db = Prisma.TransactionClient | PrismaClient;

const MIN = 60_000;

export class SlotQueryUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotQueryUnavailable';
  }
}

export interface BuildSlotQueryArgs {
  businessId: string;
  providerId: string;
  /**
   * The services in this visit, IN ORDER (VISIT-01, D-23). One entry is the
   * ordinary case; several compose into a single longer body with one buffer
   * at each end.
   *
   * Plural rather than a `serviceId` with an optional `additionalServiceIds`
   * beside it: two ways to say the same thing is exactly the dead flexibility
   * that rots. `AppointmentServiceLine` has been plural-shaped since A-003
   * (D-12) for the same reason.
   */
  serviceIds: readonly string[];
  /** The calendar day being browsed, in the BUSINESS's calendar — never
   *  derived from the customer's browser (spec §1.3). */
  day: string;
  now: Date;
  /**
   * Staff surfaces are NOT capped by the booking horizon (D-21) and MAY see
   * exclusion reasons; public surfaces are capped and must never see them.
   *
   * Defaults to the SAFE value. A route that forgets to pass this gets the
   * public treatment, which is the direction a mistake should fail in —
   * `explain` leaking `overlaps-booking` to an anonymous visitor tells them
   * exactly when the provider is with a client (spec §1.3, a calendar-privacy
   * leak).
   */
  audience?: 'public' | 'staff';
  /**
   * A-014. The appointment being MOVED, which must not block its own
   * destination — see `findBusyAppointments`. Only reschedule passes it; every
   * other caller leaves it undefined and sees the whole busy set.
   */
  excludeAppointmentId?: string | null;
  /**
   * A-082 — WHO WOULD BE SITTING IN THE CHAIR, when that is already known.
   *
   * A-063 lets one client's own overlapping ENVELOPES share a single chair, so
   * the room's answer differs for a client who is already in it. The write
   * path has passed this to `findFreeResource` since A-063; the OFFER did not
   * ask at all, which was safe only while the offer asked the weaker
   * cardinality question. Now that it asks the chooser's question it has to be
   * given the chooser's inputs, or a client rescheduling next to her own
   * colour would be refused a chair she is already sitting in.
   *
   * `null`/omitted is the STRICT question and the right default: an anonymous
   * visitor has not said who she is yet, and a nameless walk-in can never
   * share (two anonymous appointments are two different people).
   */
  holderKey?: string | null;
}

export interface BuiltSlotQuery {
  query: SlotQuery;
  /**
   * A-082. The room, carried BESIDE the query rather than folded into
   * `busy`, because "is there one chair free start to finish?" cannot be
   * expressed as intervals the engine subtracts by overlap — see the header of
   * `resource-load.ts` for the proof. `null` when the visit needs no chair.
   *
   * Nothing should read this directly: `computeSlotsIn` is the only way to run
   * the engine on a built query, and it is the thing that applies it.
   */
  seating: Seating | null;
  /** A-082 — forwarded from the args, for `canSeat`. */
  holderKey: string | null;
  /** True when the day is past the self-serve horizon (D-21). The query is
   *  still returned, with no windows, so callers render "nothing available"
   *  rather than an error. */
  beyondHorizon: boolean;
}

/**
 * Assembles the SlotQuery for one provider, one service, one day.
 *
 * Loads: business policy and zone, the service with this provider's overrides
 * (SVC-02), A-007's resolved windows, and the busy set — appointments (D-16's
 * COALESCE) plus time off and ad-hoc blocks, each carrying its own kind so the
 * engine can report the right exclusion reason.
 */
export async function buildSlotQuery(db: Db, args: BuildSlotQueryArgs): Promise<BuiltSlotQuery> {
  const audience = args.audience ?? 'public';

  const business = await db.business.findUnique({ where: { id: args.businessId } });
  if (!business) throw new SlotQueryUnavailable(`No such business: ${args.businessId}`);

  const links = await loadVisitLinks(db, args.providerId, args.serviceIds);
  if (!links.provider.active || links.rows.some((l) => !l.service.active)) {
    return emptyQuery(args, business, links.visit, audience, false);
  }

  const day = calendarDay(args.day);
  const zone = zoneId(business.timezone);
  const nowInstant = fromDate(args.now);

  // D-21: the horizon caps SELF-SERVE only. Staff booking is never capped —
  // the front desk pre-books a year out for a wedding and that is normal.
  const beyondHorizon =
    audience === 'public' && startOfDay(day, zone) > nowInstant + business.bookingHorizonDays * 24 * 60 * MIN;
  if (beyondHorizon) return emptyQuery(args, business, links.visit, audience, true);

  const resolved = await resolveDayWindowsFor(db, {
    businessId: args.businessId,
    providerId: args.providerId,
    day: args.day,
    zone: business.timezone,
  });

  const service = {
    durationMinutes: links.visit.durationMinutes,
    bufferBeforeMinutes: links.visit.bufferBeforeMinutes,
    bufferAfterMinutes: links.visit.bufferAfterMinutes,
  };

  // The widest span this day's candidates can touch: local midnight to local
  // midnight of the following day covers every window including an overnight
  // one, and the buffers extend it either side. Computed ONCE and handed to
  // both the busy set and the room, so the two provably measure the same day —
  // the reason `loadRoom` takes `loadDayView`'s bounds rather than its own.
  const windowStart = toDate(
    instant(startOfDay(day, zone) - service.bufferBeforeMinutes * MIN - 24 * 60 * MIN),
  );
  const windowEnd = toDate(
    instant(startOfDay(addDays(day, 1), zone) + service.bufferAfterMinutes * MIN + 24 * 60 * MIN),
  );

  // RES-03. The chair the visit would need, and therefore whether the ROOM can
  // seat it — a question about everybody's appointments, not this provider's.
  // Null for a service that needs no resource (a phone consult), and skipped
  // entirely on a day this provider does not work: `daysWithAvailability` walks
  // 28 of these to draw a date picker, and a closed day has no candidate to
  // seat.
  const resourceTypeId =
    resolved.windows.length === 0 ? null : await requiredResourceTypeId(db, args.serviceIds);

  const [busy, seating] = await Promise.all([
    resolved.windows.length === 0
      ? Promise.resolve([] as BusyInterval[])
      : loadBusy(db, {
          businessId: args.businessId,
          providerId: args.providerId,
          serviceIds: args.serviceIds,
          day,
          zone,
          windows: resolved.windows,
          service,
          excludeAppointmentId: args.excludeAppointmentId ?? null,
          now: args.now,
          windowStart,
          windowEnd,
        }),
    resourceTypeId
      ? loadSeating(db, {
          businessId: args.businessId,
          resourceTypeId,
          windowStart,
          windowEnd,
          excludeAppointmentId: args.excludeAppointmentId ?? null,
        })
      : Promise.resolve(null),
  ]);

  return {
    beyondHorizon: false,
    seating,
    holderKey: args.holderKey ?? null,
    query: {
      day,
      businessZone: zone,
      service,
      windows: resolved.windows,
      busy,
      grid: { intervalMinutes: business.slotIntervalMinutes, anchor: 'window-open' },
      now: nowInstant,
      // THE LEAD TIME IS A SELF-SERVE RULE (D-25), like the horizon above.
      //
      // D-11 exists to close one specific trap: a customer books a slot five
      // minutes out and is instantly inside the cancellation cutoff, unable to
      // undo it without ringing — the failure this product exists to
      // eliminate. Staff are not bound by the cutoff either (APPT-05), so the
      // trap cannot close on them. Applying it to them instead breaks
      // BOOK-04's walk-in outright: a front desk that cannot book the person
      // standing in front of it is a paper diary with extra steps.
      minimumLeadMinutes: audience === 'staff' ? 0 : business.minimumLeadMinutes,
      policy: policyOf(business),
      // NEVER for the public. Enforced here as well as at the route, because
      // "enforced at the route" is one forgotten line away from a leak.
      ...(audience === 'staff' ? { explain: true } : {}),
    },
  };
}

/**
 * A-082 — THE ONLY WAY TO RUN THE ENGINE ON A BUILT QUERY.
 *
 * Runs `computeSlots` and then asks the room the question the CHAIR CHOOSER
 * asks: is there one chair free for this candidate's whole envelope? A count
 * of occupied chairs cannot answer that (see `resource-load.ts`), and the
 * answer cannot be folded back into `busy` as intervals, so it is a filter
 * over candidates and it lives here — with the engine call — rather than in
 * each of the five places that offer a time.
 *
 * `overrides` is for the callers that legitimately run the engine against
 * something other than the live catalogue: D-18's duration snapshot on a
 * reschedule, A-055's new visit length, `explain` on the write paths.
 *
 * A slot the room cannot seat becomes an EXCLUSION with `no-resource-free`,
 * not a silent disappearance: three write paths read that reason to tell the
 * desk "she is free, the room is not" and to offer RES-04's override, and a
 * slot that merely vanished would reach them as `SlotNotOffered` with no
 * reasons at all.
 */
export function computeSlotsIn(built: BuiltSlotQuery, overrides?: Partial<SlotQuery>): SlotResult {
  const query = overrides ? { ...built.query, ...overrides } : built.query;
  const result = computeSlots(query);
  const seating = built.seating;
  if (!seating) return result;

  const slots: Slot[] = [];
  const refused: Exclusion[] = [];
  for (const slot of result.slots) {
    if (canSeat(seating, { start: slot.blockedStart, end: slot.blockedEnd }, { start: slot.start, end: slot.end }, built.holderKey)) {
      slots.push(slot);
    } else if (query.explain === true) {
      refused.push({
        candidateStart: slot.start,
        label: slot.label,
        reasons: ['no-resource-free'],
        // Nothing a human could open: the conflict is everybody's appointments
        // at once rather than one of them, which is why the old synthetic
        // interval id was synthetic too.
        conflictIds: [],
      });
    }
  }
  if (slots.length === result.slots.length) return result;

  return {
    ...result,
    slots,
    excluded: [...result.excluded, ...refused].sort((a, b) => a.candidateStart - b.candidateStart),
  };
}

/** Runs the engine for one day. The engine stays pure; this is the only
 *  place that hands it database-shaped inputs. */
export async function computeDaySlots(db: Db, args: BuildSlotQueryArgs): Promise<SlotResult> {
  return computeSlotsIn(await buildSlotQuery(db, args));
}

/**
 * SLOT-07 — which days in a range have at least one bookable slot.
 *
 * Derived from THE SAME pure function the day view uses, deliberately: a date
 * picker computed by a cheaper approximation is a date picker that greys out a
 * day the booking page will happily sell, or offers one it then refuses.
 *
 * Days are walked on the CALENDAR axis (`addDays`), never by adding 86_400_000
 * milliseconds — after a transition that arithmetic lands an hour off and
 * drifts permanently (spec X-2).
 */
export async function daysWithAvailability(
  db: Db,
  args: Omit<BuildSlotQueryArgs, 'day'> & { fromDay: string; toDay: string },
): Promise<string[]> {
  const available: string[] = [];
  let day = calendarDay(args.fromDay);
  const last = calendarDay(args.toDay);

  // A hard stop, so a caller that passes toDay < fromDay, or a range of years,
  // cannot spin. 400 covers any horizon D-21 permits with room to spare.
  for (let guard = 0; day <= last && guard < 400; guard++) {
    const built = await buildSlotQuery(db, { ...args, day });
    if (!built.beyondHorizon && built.query.windows.length > 0 && computeSlotsIn(built).slots.length > 0) {
      available.push(day);
    }
    day = addDays(day, 1);
  }
  return available;
}

// ─────────────────────────── internals ───────────────────────────

function policyOf(business: { bufferMayOverlapBreak: boolean; bufferMayExtendPastClose: boolean; ambiguousLocalTime: string }): SlotPolicy {
  return {
    bufferMayOverlapBreak: business.bufferMayOverlapBreak,
    bufferMayExtendPastClose: business.bufferMayExtendPastClose,
    ambiguousLocalTime: business.ambiguousLocalTime === 'offer-earlier-only' ? 'offer-earlier-only' : 'offer-both',
  };
}

function emptyQuery(
  args: BuildSlotQueryArgs,
  business: { timezone: string; slotIntervalMinutes: number; minimumLeadMinutes: number; bufferMayOverlapBreak: boolean; bufferMayExtendPastClose: boolean; ambiguousLocalTime: string },
  visit: ComposedVisit,
  audience: 'public' | 'staff',
  beyondHorizon: boolean,
): BuiltSlotQuery {
  return {
    beyondHorizon,
    seating: null,
    holderKey: args.holderKey ?? null,
    query: {
      day: calendarDay(args.day),
      businessZone: zoneId(business.timezone),
      service: {
        durationMinutes: visit.durationMinutes,
        bufferBeforeMinutes: visit.bufferBeforeMinutes,
        bufferAfterMinutes: visit.bufferAfterMinutes,
      },
      windows: [],
      busy: [],
      grid: { intervalMinutes: business.slotIntervalMinutes, anchor: 'window-open' },
      now: fromDate(args.now),
      minimumLeadMinutes: business.minimumLeadMinutes,
      policy: policyOf(business),
      ...(audience === 'staff' ? { explain: true } : {}),
    },
  };
}

/**
 * Loads every service in the visit, resolves this provider's overrides
 * (SVC-02), and composes them into one body (VISIT-01).
 *
 * Preserves the CALLER's order — the buffers come from the ends, so
 * "cut then colour" and "colour then cut" are genuinely different visits.
 * A findMany would return them in database order and silently reorder the
 * client's appointment.
 */
async function loadVisitLinks(db: Db, providerId: string, serviceIds: readonly string[]) {
  if (serviceIds.length === 0) {
    throw new SlotQueryUnavailable('A visit needs at least one service.');
  }

  const found = await db.serviceProvider.findMany({
    where: { providerId, serviceId: { in: [...serviceIds] } },
    include: { service: true, provider: true },
  });

  const byService = new Map(found.map((row) => [row.serviceId, row]));
  const rows = serviceIds.map((serviceId) => {
    const row = byService.get(serviceId);
    // SVC-02: "an unassigned provider never appears in that service's booking
    // flow". An explicit refusal, not an empty result — a caller asking for an
    // impossible pair has a bug, and "no slots" would hide it.
    if (!row) {
      throw new SlotQueryUnavailable(`Provider ${providerId} is not qualified for service ${serviceId}.`);
    }
    return row;
  });

  const lines: VisitLine[] = rows.map((row) => ({
    serviceId: row.serviceId,
    durationMinutes: effectiveDurationMinutes(row.service.durationMinutes, row.durationOverrideMinutes),
    bufferBeforeMinutes: row.service.bufferBeforeMinutes,
    bufferAfterMinutes: row.service.bufferAfterMinutes,
    priceCents: row.priceOverrideCents ?? row.service.priceCents,
  }));

  return { rows, lines, visit: composeVisit(lines), provider: rows[0]!.provider };
}

/**
 * A-007's chain, converted into the branded WallTime shape SlotQuery wants.
 *
 * The LOOKUP itself is `resolveDayWindows` in the availability module — this
 * used to hold a second private copy of it. Two implementations of "what hours
 * does this provider work on this day" is the fork that lets the day grid
 * (A-016) draw a window the engine will not sell from, and neither screen
 * looks wrong on its own.
 */
async function resolveDayWindowsFor(
  db: Db,
  args: { businessId: string; providerId: string; day: string; zone: string },
): Promise<{ windows: SlotQuery['windows'] }> {
  const resolved = await resolveDayWindows(db, {
    businessId: args.businessId,
    providerId: args.providerId,
    day: args.day,
    weekday: weekdayOf(calendarDay(args.day)),
  });

  return {
    windows: resolved.windows.map((w) => ({
      open: wallTime(w.open),
      close: wallTime(w.close),
      endsNextDay: w.endsNextDay,
      breaks: w.breaks.map((b) => ({ open: wallTime(b.open), close: wallTime(b.close) })),
    })),
  };
}

/**
 * Appointments, time off and ad-hoc blocks overlapping the day's windows.
 *
 * The query range is widened by the service's own buffers: a candidate's
 * BLOCKED range extends past the window on both sides, so a booking sitting
 * just outside the window can still collide with the first or last candidate.
 * Querying only the window itself would miss it.
 */
async function loadBusy(
  db: Db,
  args: {
    providerId: string;
    day: ReturnType<typeof calendarDay>;
    zone: ReturnType<typeof zoneId>;
    businessId: string;
    serviceIds: readonly string[];
    windows: SlotQuery['windows'];
    service: { durationMinutes: number; bufferBeforeMinutes: number; bufferAfterMinutes: number };
    excludeAppointmentId: string | null;
    now: Date;
    /** PASSED IN, not recomputed (A-082). The room is loaded over the same two
     *  instants; two functions each deriving "the widest span this day can
     *  touch" is the same fact under two names, and the day the buffers move
     *  they would disagree by exactly the buffer. */
    windowStart: Date;
    windowEnd: Date;
  },
): Promise<BusyInterval[]> {
  const { windowStart, windowEnd } = args;

  const [appointments, absences, late] = await Promise.all([
    findBusyAppointments(db, {
      providerId: args.providerId,
      windowStart,
      windowEnd,
      excludeAppointmentId: args.excludeAppointmentId,
    }),
    findAbsences(db, { providerId: args.providerId, windowStart, windowEnd }),
    // D-22. Keyed on the business day, so it can only ever apply to the day it
    // was set for — a delta does not survive to tomorrow, and nothing has to
    // remember to clear it overnight.
    findRunningLate(db, { businessId: args.businessId, day: args.day }),
  ]);

  const overrun = late
    .filter((row) => row.providerId === args.providerId)
    .map((row) => runningLateInterval(row, args.now))
    .filter((interval): interval is NonNullable<typeof interval> => interval !== null);

  return [
    ...appointments.map((a) => ({
      start: fromDate(a.start),
      end: fromDate(a.end),
      kind: 'booking' as const,
      id: a.id,
    })),
    // Each absence keeps its own kind so the engine reports the right reason:
    // an ad-hoc block is NOT time off, and telling the front desk a stylist is
    // away when she is standing there is how a screen stops being read.
    ...absences.map((a) => ({
      start: fromDate(a.start),
      end: fromDate(a.end),
      kind: a.kind,
      id: a.id,
    })),
    // D-22's overrun, with its OWN kind: the engine excludes it as
    // `provider-running-late`, so the day view can say "Dana is behind"
    // rather than the flatly wrong "she is unavailable".
    ...overrun,
    // RES-03 — THE ROOM IS NOT HERE ANY MORE (A-082). It was, as a
    // `resource-full` interval kind, and that shape could only ever express
    // "every chair is taken at this instant" — which is not the question the
    // chair chooser asks. `computeSlotsIn` applies it per candidate instead.
  ] satisfies BusyInterval[];
}

export type { Slot, SlotResult, Instant };
