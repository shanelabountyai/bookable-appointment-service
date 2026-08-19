/**
 * A-024 — RPT-02's frozen formula, pure.
 *
 * `Σ minutes of appointments in {completed, no_show} ÷ Σ (working minutes −
 * breaks − time off)`, per provider per business date. This file owns the
 * denominator's arithmetic; the numerator is a plain sum of appointment
 * durations and needs no pure module of its own.
 *
 * Deliberately NOT run through the slot grid: a window's unbookable tail
 * shorter than one grid interval is real working time, not idle time (RPT-02:
 * "grid dead-zones count as unbookable, not idle"). `computeSlots` would
 * quantize it away, so this works directly off the resolved window spans —
 * the same `resolveWindow`/`union`/`subtractSpans` the day grid's gaps and
 * the engine both already use (A-016's extraction comment in `spans.ts`).
 */
import { type CalendarDay, type ZoneId } from '../time';
import { type Span, type WorkingWindow, resolveWindow, subtractSpans, union } from '../scheduling';

/** One provider, one business date: working minutes with breaks and
 *  absences (time off / ad-hoc blocks) already removed. */
export function availableMinutesForDay(
  windows: readonly WorkingWindow[],
  day: CalendarDay,
  zone: ZoneId,
  absences: readonly Span[],
): number {
  const resolved = windows.map((w) => resolveWindow(w, day, zone));
  const working = union(resolved.map((r) => r.span));
  const withoutBreaks = subtractSpans(working, resolved.flatMap((r) => r.breaks));
  const withoutAbsences = subtractSpans(withoutBreaks, absences);
  return sumMinutes(withoutAbsences);
}

function sumMinutes(spans: readonly Span[]): number {
  return spans.reduce((total, span) => total + (span.end - span.start) / 60_000, 0);
}

/**
 * The formula itself. `null` — never `0` — when there was nothing to work
 * with (RPT-02's explicit "zero denominator renders 'n/a', never 0%"): a
 * provider off the roster that week is undefined utilization, not 0%
 * utilization, and the difference matters to whoever reads the tile.
 */
export function utilizationFraction(occupiedMinutes: number, availableMinutes: number): number | null {
  return availableMinutes > 0 ? occupiedMinutes / availableMinutes : null;
}
