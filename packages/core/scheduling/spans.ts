/**
 * WALL-CLOCK WINDOWS → INSTANTS, and the interval arithmetic over them.
 *
 * EXTRACTED FROM THE ENGINE (A-016), not rewritten. The day grid has to place
 * a provider's working hours on a physical timeline, which is the same axis
 * crossing the engine performs — and the rules for performing it are subtle
 * enough that a second implementation would be a second set of DST bugs:
 * a gap resolves to the instant AFTER it for BOTH edges, an ambiguous open
 * takes `earlier` while an ambiguous close takes `later`, and windows are
 * unioned only AFTER resolution (spec DST-7). Every one of those was decided
 * with a test in A-008, and none of them is guessable from the outside.
 *
 * So the engine now calls this and so does the grid. Nothing here reads a
 * clock or touches the database; it is the same pure, integer-millisecond
 * arithmetic, and the only Temporal use is inside `packages/core/time`.
 */
import { addDays, resolve } from '../time/zone';
import type { CalendarDay, Instant, WallTime, ZoneId } from '../time/types';
import type { WorkingWindow } from './types';

/** A half-open [start, end) interval on the physical axis. */
export interface Span {
  readonly start: Instant;
  readonly end: Instant;
}

export const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

export interface ResolvedWindow {
  readonly span: Span;
  readonly breaks: readonly Span[];
}

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
export function resolveEdge(day: CalendarDay, time: WallTime, zone: ZoneId, edge: 'open' | 'close'): Instant {
  const r = resolve(day, time, zone);
  if (r.kind === 'unique') return r.at;
  if (r.kind === 'gap') return r.later;
  return edge === 'open' ? r.earlier : r.later;
}

export function resolveWindow(window: WorkingWindow, day: CalendarDay, zone: ZoneId): ResolvedWindow {
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
 * Union spans ON THE INSTANT AXIS — never before resolution (spec DST-7).
 * Ranges that merely touch (`a.end === b.start`) are merged too: they are
 * contiguous in physical time, and treating them as two windows would reject
 * any service spanning the join.
 */
export function union(spans: readonly Span[]): Span[] {
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

/**
 * What is LEFT of `spans` once `busy` is taken out — the day grid's gaps
 * (A-016, BOOK-04's view half).
 *
 * Interval subtraction rather than the engine's candidate-then-filter shape,
 * and deliberately so: a gap is not a slot. A slot is "somewhere this
 * 45-minute service fits, on the grid, with buffers"; a gap is "nobody is in
 * this chair between 2:15 and 3:00". The front desk needs the second to answer
 * "what can you fit me in for?" — a question that has no service in it yet.
 *
 * Zero-length results are dropped: a gap of no minutes is not a gap, and
 * rendering one puts an invisible, focusable target in the grid.
 */
export function subtractSpans(spans: readonly Span[], busy: readonly Span[]): Span[] {
  const taken = union(busy);
  let remaining = union(spans);

  for (const block of taken) {
    const next: Span[] = [];
    for (const span of remaining) {
      if (!overlaps(span, block)) {
        next.push(span);
        continue;
      }
      if (block.start > span.start) next.push({ start: span.start, end: block.start });
      if (block.end < span.end) next.push({ start: block.end, end: span.end });
    }
    remaining = next;
  }

  return remaining.filter((span) => span.end > span.start);
}
