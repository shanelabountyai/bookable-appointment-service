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
import { localDayLengthMinutes, resolve, startOfDay, toLabel } from '../time/zone';
import type { Instant } from '../time/types';
import { InvalidTimeValue } from '../time/types';
import {
  type BusyInterval,
  type Exclusion,
  type ExclusionReason,
  InvalidSlotQuery,
  type Slot,
  type SlotLabel,
  type SlotQuery,
  type SlotResult,
} from './types';

import { type ResolvedWindow, type Span, overlaps, resolveWindow, union } from './spans';

const MIN = 60_000;

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
// It lives in `spans.ts` now, shared with A-016's day grid: the resolution
// rules (gap -> after, ambiguous open -> earlier / close -> later, union only
// AFTER resolving) are subtle enough that a second copy would be a second set
// of DST bugs. Nothing about the behaviour changed when it moved.

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
    resolved = query.windows.map((w) => resolveWindow(w, day, zone));
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
    // Each non-booking kind reports ITS OWN reason. Collapsing them all to
    // 'overlaps-time-off' — which this engine did until the Milestone 1
    // operator review — tells the front desk a stylist is away when she is
    // standing right there with an ad-hoc block, or behind schedule. A screen
    // that explains itself wrongly is worse than one that stays silent,
    // because staff stop reading it.
    let bodyHitsBooking = false;
    let bufferHitsBooking = false;
    const otherKinds = new Set<BusyInterval['kind']>();
    for (const busy of query.busy) {
      if (!overlaps(blocked, busy)) continue;
      conflictIds.add(busy.id);
      if (busy.kind === 'booking') {
        if (overlaps(body, busy)) bodyHitsBooking = true;
        else bufferHitsBooking = true;
      } else {
        otherKinds.add(busy.kind);
      }
    }
    if (bodyHitsBooking) reasons.push('overlaps-booking');
    else if (bufferHitsBooking) reasons.push('overlaps-buffer');
    // Ordered, not iteration-ordered: `reasons` is asserted with toEqual in
    // the matrix, so it must not depend on the order of the busy array (§2.3).
    if (otherKinds.has('time_off')) reasons.push('overlaps-time-off');
    if (otherKinds.has('ad_hoc_block')) reasons.push('overlaps-block');
    if (otherKinds.has('running-late')) reasons.push('provider-running-late');

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
