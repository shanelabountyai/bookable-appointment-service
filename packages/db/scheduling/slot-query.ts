/**
 * Availability → SlotQuery (A-026, SLOT-07).
 *
 * Where A-007's wall-clock precedence chain, A-003's rows and A-008's pure
 * engine finally meet. Everything this module does is assemble inputs — the
 * engine stays pure and this file stays free of scheduling rules.
 */
import { resolveAvailableWindows, toMinuteWindow, toWindowInput } from '../../core/availability';
import {
  type BusyInterval,
  type Slot,
  type SlotPolicy,
  type SlotQuery,
  type SlotResult,
  calendarDay,
  computeSlots,
  instant,
  wallTime,
  zoneId,
} from '../../core/scheduling';
import { type Instant, addDays, fromDate, startOfDay, toDate, weekdayOf } from '../../core/time';
import { effectiveDurationMinutes } from '../../core/settings';
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { findAbsences } from '../availability';
import { findBusyAppointments } from './busy-set';

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
  serviceId: string;
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
}

export interface BuiltSlotQuery {
  query: SlotQuery;
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

  const link = await db.serviceProvider.findFirst({
    where: { serviceId: args.serviceId, providerId: args.providerId },
    include: { service: true, provider: true },
  });
  // SVC-02: "an unassigned provider never appears in that service's booking
  // flow". Not an empty result — an explicit refusal, because a caller asking
  // for an impossible pair has a bug, and returning "no slots" would hide it.
  if (!link) {
    throw new SlotQueryUnavailable(
      `Provider ${args.providerId} is not qualified for service ${args.serviceId}.`,
    );
  }
  if (!link.provider.active || !link.service.active) {
    return emptyQuery(args, business, link, audience, false);
  }

  const day = calendarDay(args.day);
  const zone = zoneId(business.timezone);
  const nowInstant = fromDate(args.now);

  // D-21: the horizon caps SELF-SERVE only. Staff booking is never capped —
  // the front desk pre-books a year out for a wedding and that is normal.
  const beyondHorizon =
    audience === 'public' && startOfDay(day, zone) > nowInstant + business.bookingHorizonDays * 24 * 60 * MIN;
  if (beyondHorizon) return emptyQuery(args, business, link, audience, true);

  const resolved = await resolveDayWindowsFor(db, {
    businessId: args.businessId,
    providerId: args.providerId,
    day: args.day,
    zone: business.timezone,
  });

  const durationMinutes = effectiveDurationMinutes(link.service.durationMinutes, link.durationOverrideMinutes);
  const service = {
    durationMinutes,
    bufferBeforeMinutes: link.service.bufferBeforeMinutes,
    bufferAfterMinutes: link.service.bufferAfterMinutes,
  };

  const busy = resolved.windows.length === 0
    ? []
    : await loadBusy(db, {
        providerId: args.providerId,
        day,
        zone,
        windows: resolved.windows,
        service,
      });

  return {
    beyondHorizon: false,
    query: {
      day,
      businessZone: zone,
      service,
      windows: resolved.windows,
      busy,
      grid: { intervalMinutes: business.slotIntervalMinutes, anchor: 'window-open' },
      now: nowInstant,
      minimumLeadMinutes: business.minimumLeadMinutes,
      policy: policyOf(business),
      // NEVER for the public. Enforced here as well as at the route, because
      // "enforced at the route" is one forgotten line away from a leak.
      ...(audience === 'staff' ? { explain: true } : {}),
    },
  };
}

/** Runs the engine for one day. The engine stays pure; this is the only
 *  place that hands it database-shaped inputs. */
export async function computeDaySlots(db: Db, args: BuildSlotQueryArgs): Promise<SlotResult> {
  const { query } = await buildSlotQuery(db, args);
  return computeSlots(query);
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
    const { query, beyondHorizon } = await buildSlotQuery(db, { ...args, day });
    if (!beyondHorizon && query.windows.length > 0 && computeSlots(query).slots.length > 0) {
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
  link: { service: { durationMinutes: number; bufferBeforeMinutes: number; bufferAfterMinutes: number }; durationOverrideMinutes: number | null },
  audience: 'public' | 'staff',
  beyondHorizon: boolean,
): BuiltSlotQuery {
  return {
    beyondHorizon,
    query: {
      day: calendarDay(args.day),
      businessZone: zoneId(business.timezone),
      service: {
        durationMinutes: effectiveDurationMinutes(link.service.durationMinutes, link.durationOverrideMinutes),
        bufferBeforeMinutes: link.service.bufferBeforeMinutes,
        bufferAfterMinutes: link.service.bufferAfterMinutes,
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

/** A-007's chain, converted into the branded WallTime shape SlotQuery wants. */
async function resolveDayWindowsFor(
  db: Db,
  args: { businessId: string; providerId: string; day: string; zone: string },
): Promise<{ windows: SlotQuery['windows'] }> {
  const weekday = weekdayOf(calendarDay(args.day));

  const [businessPattern, providerPattern] = await Promise.all([
    loadPattern(db, { businessId: args.businessId, providerId: null, day: args.day, weekday }),
    loadPattern(db, { businessId: args.businessId, providerId: args.providerId, day: args.day, weekday }),
  ]);

  const windows = resolveAvailableWindows(businessPattern, providerPattern).map(toWindowInput);
  return {
    windows: windows.map((w) => ({
      open: wallTime(w.open),
      close: wallTime(w.close),
      endsNextDay: w.endsNextDay,
      breaks: w.breaks.map((b) => ({ open: wallTime(b.open), close: wallTime(b.close) })),
    })),
  };
}

async function loadPattern(
  db: Db,
  args: { businessId: string; providerId: string | null; day: string; weekday: number },
) {
  const [weeklyRows, overrideRow] = await Promise.all([
    db.weeklyWindow.findMany({
      where: { businessId: args.businessId, providerId: args.providerId, weekday: args.weekday },
      include: { breaks: true },
    }),
    db.dateOverride.findFirst({
      where: { businessId: args.businessId, providerId: args.providerId, day: args.day },
      include: { windows: true },
    }),
  ]);

  return {
    weekly: weeklyRows.map((w) =>
      toMinuteWindow({
        open: w.open.trim(),
        close: w.close.trim(),
        endsNextDay: w.endsNextDay,
        breaks: w.breaks.map((b) => ({ open: b.open.trim(), close: b.close.trim() })),
      }),
    ),
    override: overrideRow
      ? {
          isClosed: overrideRow.isClosed,
          windows: overrideRow.windows.map((w) =>
            toMinuteWindow({ open: w.open.trim(), close: w.close.trim(), endsNextDay: w.endsNextDay }),
          ),
        }
      : null,
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
    windows: SlotQuery['windows'];
    service: { durationMinutes: number; bufferBeforeMinutes: number; bufferAfterMinutes: number };
  },
): Promise<BusyInterval[]> {
  // The widest span the day's candidates can possibly touch. Local midnight to
  // local midnight of the following day covers every window including an
  // overnight one, and the buffers extend it either side.
  const dayStart = startOfDay(args.day, args.zone);
  const dayEnd = startOfDay(addDays(args.day, 1), args.zone);
  const windowStart = toDate(instant(dayStart - args.service.bufferBeforeMinutes * MIN - 24 * 60 * MIN));
  const windowEnd = toDate(instant(dayEnd + args.service.bufferAfterMinutes * MIN + 24 * 60 * MIN));

  const [appointments, absences] = await Promise.all([
    findBusyAppointments(db, { providerId: args.providerId, windowStart, windowEnd }),
    findAbsences(db, { providerId: args.providerId, windowStart, windowEnd }),
  ]);

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
  ] satisfies BusyInterval[];
}

export type { Slot, SlotResult, Instant };
