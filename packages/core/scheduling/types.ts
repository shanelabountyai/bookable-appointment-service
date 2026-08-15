/**
 * The slot-engine contract. NORMATIVE SOURCE: docs/reviews/03-slot-engine-spec.md §1.
 *
 * The No-Mixing Law (D-3):
 *  - CalendarDay / WallTime / ZoneId live on the calendar axis (rules).
 *  - Instant lives on the physical axis (occurrences).
 *  - They are branded and structurally incompatible. Neither `Date` nor a bare
 *    string/number crosses the engine boundary in either direction.
 *  - Exactly ONE module (packages/core/time/zone.ts, built in A-002) converts
 *    between the axes, and its resolve() returns unique | gap | ambiguous —
 *    never a bare Instant.
 */

// ── The calendar axis. No offset. No instant. Not orderable against Instant. ──
/** ISO-8601 calendar date, "2026-03-08". A label on a wall calendar. */
export type CalendarDay = string & { readonly __calendarDay: unique symbol };
/** ISO-8601 local time of day, "09:00". No date, no zone. */
export type WallTime = string & { readonly __wallTime: unique symbol };
/** IANA zone id, "America/Chicago". Never a fixed offset or abbreviation. */
export type ZoneId = string & { readonly __zoneId: unique symbol };

// ── The physical axis. One number line. No calendar meaning. ──
/** Epoch milliseconds UTC. The only representation of a moment in this system. */
export type Instant = number & { readonly __instant: unique symbol };

// Constructors for fixtures and boundaries. Validation arrives with A-002;
// these are deliberately thin so the red suite can run before the time module exists.
export const calendarDay = (s: string): CalendarDay => s as CalendarDay;
export const wallTime = (s: string): WallTime => s as WallTime;
export const zoneId = (s: string): ZoneId => s as ZoneId;
export const instant = (epochMs: number): Instant => epochMs as Instant;
/** Fixture helper: parse an offset-bearing ISO string to an Instant. The offset
 *  is REQUIRED — a zoneless string is exactly the bug this type system forbids. */
export const instantFromIso = (iso: string): Instant => {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    throw new Error(`instantFromIso requires an explicit offset, got: ${iso}`);
  }
  // Starter fixture helper only, guarded by the offset check above (never a
  // zoneless/local parse). A-002 replaces this with the temporal-polyfill
  // conversion module.
  // eslint-disable-next-line no-restricted-syntax
  return Date.parse(iso) as Instant;
};

export interface WorkingWindow {
  readonly open: WallTime;
  readonly close: WallTime;
  /** Required, never inferred: `close <= open` with endsNextDay=false is malformed. */
  readonly endsNextDay: boolean;
  /** Breaks belong to the WINDOW, not the day (spec OV-9). */
  readonly breaks: readonly { readonly open: WallTime; readonly close: WallTime }[];
}

export interface BusyInterval {
  /** Half-open [start, end) on the physical axis. For bookings this is the
   *  BLOCKED range (body ± its own buffers), matching the D-2 constraint. */
  readonly start: Instant;
  readonly end: Instant;
  readonly kind: 'booking' | 'time_off' | 'ad_hoc_block';
  readonly id: string;
}

export interface SlotPolicy {
  readonly bufferMayOverlapBreak: boolean; // default true (spec §3.H)
  readonly bufferMayExtendPastClose: boolean; // default true
  readonly ambiguousLocalTime: 'offer-both' | 'offer-earlier-only'; // default 'offer-both'
}

export interface SlotQuery {
  /** The calendar day being browsed, IN THE BUSINESS'S CALENDAR. Never derived
   *  from the customer's browser. */
  readonly day: CalendarDay;
  /** The ONLY timezone that participates in computation. */
  readonly businessZone: ZoneId;
  readonly service: {
    readonly durationMinutes: number; // > 0, integer
    readonly bufferBeforeMinutes: number; // >= 0 (D-11 adds it now; retrofitting re-means every stored interval)
    readonly bufferAfterMinutes: number; // >= 0
  };
  /** Wall-clock RULES, already resolved to this provider for this day
   *  (override-or-weekly precedence happens in the availability layer, A-007). */
  readonly windows: readonly WorkingWindow[];
  /** INSTANTS. Everything already fixed on the physical timeline. */
  readonly busy: readonly BusyInterval[];
  readonly grid: {
    readonly intervalMinutes: number; // > 0, integer, default 15
    readonly anchor: 'window-open' | 'local-midnight'; // default 'window-open' (D-4)
  };
  /** Injected. NEVER Date.now() — that alone would destroy purity. */
  readonly now: Instant;
  readonly minimumLeadMinutes: number; // >= 0 (D-11)
  readonly policy: SlotPolicy;
  readonly explain?: boolean; // default false; NEVER exposed on public routes
}

export interface SlotLabel {
  readonly day: CalendarDay; // may differ from query.day for overnight windows (spec MN-3)
  readonly time: WallTime;
  readonly offset: string; // "-05:00" — the fall-back tiebreaker
  readonly abbreviation: string; // "CDT" — for the UI, never for logic
}

export interface Slot {
  readonly start: Instant; // the identity of the slot (D-4)
  readonly end: Instant; // start + duration, exclusive
  readonly blockedStart: Instant; // start − bufferBefore
  readonly blockedEnd: Instant; // end + bufferAfter
  /** Precomputed in the BUSINESS zone. Never recompute downstream. */
  readonly label: SlotLabel;
  /** true when this wall label occurs twice on this calendar day (fall-back). */
  readonly labelIsAmbiguous: boolean;
}

export type ExclusionReason =
  | 'outside-working-window'
  | 'inside-break'
  | 'crosses-window-close'
  | 'overlaps-booking'
  | 'overlaps-buffer'
  | 'overlaps-time-off'
  | 'in-the-past'
  | 'inside-lead-time'
  | 'nonexistent-local-time'
  | 'ambiguous-suppressed';

export interface Exclusion {
  readonly candidateStart: Instant;
  readonly label: SlotLabel;
  readonly reasons: readonly ExclusionReason[]; // ALL of them, not the first
  readonly conflictIds: readonly string[];
}

export interface SlotResult {
  readonly slots: readonly Slot[];
  /** Populated only when explain === true. */
  readonly excluded: readonly Exclusion[];
  readonly meta: {
    readonly windowInstants: readonly { readonly start: Instant; readonly end: Instant }[];
    /** 1380 on spring-forward, 1500 on fall-back, 1440 otherwise. */
    readonly localDayLengthMinutes: number;
    readonly candidatesConsidered: number;
  };
}

/** Malformed input (vs semantically-empty input, which returns empty slots).
 *  The rule (spec §2, items 27–39): malformed THROWS; "nothing available" returns []. */
export class InvalidSlotQuery extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSlotQuery';
  }
}
