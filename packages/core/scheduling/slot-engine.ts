/**
 * THE SLOT ENGINE (A-008) — the core learning artifact.
 *
 * NORMATIVE: docs/reviews/03-slot-engine-spec.md §§1–3.
 *
 * PURE FUNCTION. No I/O, no Date.now(), no process.env, no Intl call that reads
 * the system zone. `now` is a parameter. Identical output under any process TZ.
 *
 * SHAPE (spec §1.3): candidate-then-filter, not interval-subtraction. That costs
 * short-circuiting — O(candidates × constraints), about 2,000 predicate
 * evaluations per provider-day, i.e. microseconds — and buys the thing that
 * makes the test suite real: almost every assertion in §3 is an assertion of
 * ABSENCE, and `expect(slots).not.toContain('11:00')` passes for a dozen reasons
 * that are all bugs. With accumulated reasons the test becomes
 * `expect(reasonFor('11:00')).toEqual(['overlaps-buffer'])`, which fails when
 * the mechanism is wrong even though the outcome looks right.
 *
 * AXIS DISCIPLINE (spec §5): Temporal is used ONLY to resolve the day's window
 * opens/closes/breaks to Instants — a handful of calls per provider-day, all of
 * them inside packages/core/time. Every grid step, overlap test and buffer
 * calculation below is integer epoch-millisecond arithmetic, which is DST-proof
 * by construction because the physical axis has no DST.
 */
import { addDays, localDayLengthMinutes, resolve, startOfDay, toLabel } from '../time/zone';
import type { CalendarDay, Instant, WallTime, ZoneId } from '../time/types';
import { InvalidTimeValue } from '../time/types';
import {
  type Exclusion,
  type ExclusionReason,
  InvalidSlotQuery,
  type Slot,
  type SlotLabel,
  type SlotQuery,
  type SlotResult,
  type WorkingWindow,
} from './types';

const MIN = 60_000;

/** A half-open [start, end) interval on the physical axis. */
interface Span {
  readonly start: Instant;
  readonly end: Instant;
}

const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

// ─────────────────────────── validation ───────────────────────────
// The rule (spec §2, items 27–39): MALFORMED input throws; "nothing available"
// returns an empty list. Confusing the two either hides a bug behind an empty
// calendar or turns an ordinary closed Sunday into a 500.

const requirePositiveInt = (value: number, field: string): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidSlotQuery(`${field} must be a positive integer, got: ${value}`);
  }
};

const requireNonNegativeInt = (value: number, field: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidSlotQuery(`${field} must be a non-negative integer, got: ${value}`);
  }
};

function validate(query: SlotQuery): void {
  requirePositiveInt(query.grid.intervalMinutes, 'grid.intervalMinutes');
  requirePositiveInt(query.service.durationMinutes, 'service.durationMinutes');
  requireNonNegativeInt(query.service.bufferBeforeMinutes, 'service.bufferBeforeMinutes');
  requireNonNegativeInt(query.service.bufferAfterMinutes, 'service.bufferAfterMinutes');
  requireNonNegativeInt(query.minimumLeadMinutes, 'minimumLeadMinutes');

  if (!Number.isFinite(query.now)) {
    throw new InvalidSlotQuery(`now must be an instant, got: ${query.now}`);
  }

  for (const busy of query.busy) {
    if (busy.end <= busy.start) {
      throw new InvalidSlotQuery(
        `busy interval ${busy.id} ends at or before it starts (${busy.start} -> ${busy.end})`,
      );
    }
  }

  for (const window of query.windows) {
    // DEG-9: never swap the pair, never silently return empty. An overnight
    // window must say so; `close <= open` without endsNextDay is malformed and
    // silently swapping it invents hours the provider never agreed to work.
    if (!window.endsNextDay && window.close <= window.open) {
      throw new InvalidSlotQuery(
        `window ${window.open}-${window.close} closes at or before it opens; set endsNextDay if it is an overnight window`,
      );
    }
    for (const brk of window.breaks) {
      if (brk.close <= brk.open) {
        throw new InvalidSlotQuery(`break ${brk.open}-${brk.close} closes at or before it opens`);
      }
    }
  }
}

// ─────────────────────────── the axis crossing ───────────────────────────
// Everything below this line until `union` is the ONLY part of the engine that
// touches the calendar axis, and it happens exactly once per window edge.

/**
 * Resolve one wall-clock edge to an instant.
 *
 * The three-armed `resolve()` forces a decision here rather than letting a
 * library make it silently (spec §5):
 *  - `gap`   -> take the instant AFTER the gap, for BOTH edges. An open at a
 *    nonexistent local time means the window begins when that time starts
 *    existing; a close at one means it runs to the far side. Taking `later` for
 *    a close is also what makes DST-7 work: split rows 01:00–02:00 and
 *    03:00–04:00 resolve to [07:00Z, 08:00Z) and [08:00Z, 09:00Z), which then
 *    union into one contiguous 07:00Z–09:00Z window. Take `earlier` for the
 *    close and you get a one-hour phantom hole and silently lose every long
 *    booking on the transition morning.
 *  - `ambiguous` -> `earlier` for an open, `later` for a close: the widest
 *    honest reading of "we are open 01:00–02:00" on a day when both happen
 *    twice. The doubled hour is real capacity (FB-1), so a window spanning it
 *    should contain all of it.
 */
function resolveEdge(day: CalendarDay, time: WallTime, zone: ZoneId, edge: 'open' | 'close'): Instant {
  const r = resolve(day, time, zone);
  if (r.kind === 'unique') return r.at;
  if (r.kind === 'gap') return r.later;
  return edge === 'open' ? r.earlier : r.later;
}

interface ResolvedWindow {
  readonly span: Span;
  readonly breaks: readonly Span[];
}

function resolveWindow(window: WorkingWindow, query: SlotQuery): ResolvedWindow {
  const { day, businessZone: zone } = query;
  const closeDay = window.endsNextDay ? addDays(day, 1) : day;

  const start = resolveEdge(day, window.open, zone, 'open');
  const end = resolveEdge(closeDay, window.close, zone, 'close');

  const breaks: Span[] = [];
  for (const brk of window.breaks) {
    // A break belongs to the WINDOW, not the day (spec OV-9), so it is resolved
    // on whichever calendar day that side of the window falls on.
    let bStart = resolveEdge(day, brk.open, zone, 'open');
    let bEnd = resolveEdge(day, brk.close, zone, 'close');
    if (window.endsNextDay && bStart < start) {
      bStart = resolveEdge(closeDay, brk.open, zone, 'open');
      bEnd = resolveEdge(closeDay, brk.close, zone, 'close');
    }
    breaks.push({ start: bStart, end: bEnd });
  }

  return { span: { start, end }, breaks };
}

/**
 * Union the resolved windows ON THE INSTANT AXIS — never before resolution
 * (spec DST-7). Ranges that merely touch (`a.end === b.start`) are merged too:
 * they are contiguous in physical time, and treating them as two windows would
 * reject any service spanning the join.
 */
function union(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    if (span.end <= span.start) continue; // a window that resolved to nothing
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      if (span.end > last.end) merged[merged.length - 1] = { start: last.start, end: span.end };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

// ─────────────────────────── the engine ───────────────────────────

export function computeSlots(query: SlotQuery): SlotResult {
  validate(query);

  const { businessZone: zone, day, service, grid, policy, now, minimumLeadMinutes } = query;

  // The zone is validated here, at the engine boundary, so a bad zone surfaces
  // as InvalidSlotQuery rather than as an empty day (DEG-12).
  let localDayLength: number;
  try {
    localDayLength = localDayLengthMinutes(day, zone);
  } catch (e) {
    throw new InvalidSlotQuery(
      `invalid day/zone: ${day} / ${zone}${e instanceof InvalidTimeValue ? ` (${e.message})` : ''}`,
    );
  }

  let resolved: ResolvedWindow[];
  try {
    resolved = query.windows.map((w) => resolveWindow(w, query));
  } catch (e) {
    if (e instanceof InvalidTimeValue) throw new InvalidSlotQuery(e.message);
    throw e;
  }

  const windows = union(resolved.map((r) => r.span));
  const breaks = resolved.flatMap((r) => r.breaks);

  const durationMs = service.durationMinutes * MIN;
  const bufferBeforeMs = service.bufferBeforeMinutes * MIN;
  const bufferAfterMs = service.bufferAfterMinutes * MIN;
  const stepMs = grid.intervalMinutes * MIN;
  const earliestBookable = (now + minimumLeadMinutes * MIN) as Instant;

  // ── candidate generation ──
  // Anchored to window-open by default (D-4): local-midnight anchoring shifts
  // the whole grid twice a year, because local midnight is not a fixed distance
  // from the window on a transition day.
  const candidates: Instant[] = [];
  if (grid.anchor === 'local-midnight') {
    const dayStart = startOfDay(day, zone);
    const dayEnd = (dayStart + localDayLength * MIN) as Instant;
    for (let t = dayStart; t < dayEnd; t = (t + stepMs) as Instant) candidates.push(t);
  } else {
    for (const window of windows) {
      for (let t = window.start; t < window.end; t = (t + stepMs) as Instant) candidates.push(t);
    }
  }

  const slots: Slot[] = [];
  const excluded: Exclusion[] = [];

  for (const start of candidates) {
    const end = (start + durationMs) as Instant;
    const blockedStart = (start - bufferBeforeMs) as Instant;
    const blockedEnd = (end + bufferAfterMs) as Instant;
    const body: Span = { start, end };
    const blocked: Span = { start: blockedStart, end: blockedEnd };

    const reasons: ExclusionReason[] = [];
    const conflictIds = new Set<string>();

    // ── window membership and closing time ──
    const window = windows.find((w) => start >= w.start && start < w.end);
    if (!window) {
      reasons.push('outside-working-window');
    } else if (end > window.end) {
      reasons.push('crosses-window-close');
    } else if (!policy.bufferMayExtendPastClose && blockedEnd > window.end) {
      // BF-6: the default lets a trailing buffer run past close — the provider
      // tidying up after the last client is not a reason to refuse the booking.
      reasons.push('crosses-window-close');
    }

    // ── breaks ──
    for (const brk of breaks) {
      if (overlaps(body, brk)) {
        reasons.push('inside-break');
        break;
      }
      if (!policy.bufferMayOverlapBreak && overlaps(blocked, brk)) {
        reasons.push('inside-break');
        break;
      }
    }

    // ── the busy set ──
    // Body overlap and buffer-only overlap are DIFFERENT reasons, because an
    // absence test that cannot tell them apart passes when the engine is using
    // the wrong interval (BF-4).
    let bodyHitsBooking = false;
    let bufferHitsBooking = false;
    let hitsTimeOff = false;
    for (const busy of query.busy) {
      if (!overlaps(blocked, busy)) continue;
      conflictIds.add(busy.id);
      const isBooking = busy.kind === 'booking';
      if (isBooking) {
        if (overlaps(body, busy)) bodyHitsBooking = true;
        else bufferHitsBooking = true;
      } else {
        hitsTimeOff = true;
      }
    }
    if (bodyHitsBooking) reasons.push('overlaps-booking');
    else if (bufferHitsBooking) reasons.push('overlaps-buffer');
    if (hitsTimeOff) reasons.push('overlaps-time-off');

    // ── now and lead time (§3.K) ──
    if (start < now) reasons.push('in-the-past');
    else if (start < earliestBookable) reasons.push('inside-lead-time');

    // ── the label, and the fall-back policy ──
    const label = toLabel(start, zone) as SlotLabel;
    const resolution = resolve(label.day, label.time, zone);
    const labelIsAmbiguous = resolution.kind === 'ambiguous';
    if (
      labelIsAmbiguous &&
      policy.ambiguousLocalTime === 'offer-earlier-only' &&
      resolution.later === start
    ) {
      // FB-7. Note the reason is 'ambiguous-suppressed', NOT
      // 'nonexistent-local-time': this instant exists and is bookable, it is
      // policy that is declining to offer it.
      reasons.push('ambiguous-suppressed');
    }

    if (reasons.length === 0) {
      slots.push({ start, end, blockedStart, blockedEnd, label, labelIsAmbiguous });
    } else if (query.explain === true) {
      excluded.push({
        candidateStart: start,
        label,
        reasons,
        conflictIds: [...conflictIds].sort(),
      });
    }
  }

  slots.sort((a, b) => a.start - b.start);

  return {
    slots,
    excluded,
    meta: {
      windowInstants: windows.map((w) => ({ start: w.start, end: w.end })),
      localDayLengthMinutes: localDayLength,
      candidatesConsidered: candidates.length,
    },
  };
}
