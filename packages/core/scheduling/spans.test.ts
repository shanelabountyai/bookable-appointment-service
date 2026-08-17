/**
 * A-016's gap arithmetic.
 *
 * `resolveWindow`/`union` are not re-tested here — they moved out of the
 * engine unchanged and A-008's DST matrix is still their test, which is the
 * point of moving rather than copying them. What is new is `subtractSpans`,
 * and every case below is a way a day grid lies to the front desk.
 */
import { describe, expect, it } from 'vitest';
import { instant } from './types';
import { subtractSpans } from './spans';

/** Minutes past an arbitrary epoch — the arithmetic is integer milliseconds
 *  and has no calendar in it, so the origin does not matter. */
const t = (minutes: number) => instant(minutes * 60_000);
const span = (from: number, to: number) => ({ start: t(from), end: t(to) });
const shape = (spans: { start: number; end: number }[]) => spans.map((s) => [s.start / 60_000, s.end / 60_000]);

describe('subtractSpans (the day grid’s gaps)', () => {
  it('returns the whole window when nothing is booked', () => {
    expect(shape(subtractSpans([span(540, 1020)], []))).toEqual([[540, 1020]]);
  });

  it('splits a window around one appointment', () => {
    // 09:00–17:00 with 10:00–11:00 booked.
    expect(shape(subtractSpans([span(540, 1020)], [span(600, 660)]))).toEqual([
      [540, 600],
      [660, 1020],
    ]);
  });

  it('drops a gap that closes to nothing', () => {
    // Booked right up to the edges: no zero-length gap survives, because an
    // invisible focusable target in the grid is worse than no target.
    expect(shape(subtractSpans([span(540, 600)], [span(540, 600)]))).toEqual([]);
  });

  it('treats touching appointments as one block, leaving no phantom gap', () => {
    // Back-to-back clients, 10:00–11:00 and 11:00–12:00. A naive subtraction
    // that handled them one at a time could leave a 0-minute gap at 11:00 —
    // which the grid would render as "0 minutes free" between two clients.
    const free = subtractSpans([span(540, 1020)], [span(600, 660), span(660, 720)]);
    expect(shape(free)).toEqual([
      [540, 600],
      [720, 1020],
    ]);
  });

  it('handles overlapping busy intervals — an appointment inside a block', () => {
    // Time off 12:00–14:00 with an appointment 12:30–13:00 inside it (staff
    // booked over the absence, D-8). The gap either side must not reappear.
    const free = subtractSpans([span(540, 1020)], [span(720, 840), span(750, 780)]);
    expect(shape(free)).toEqual([
      [540, 720],
      [840, 1020],
    ]);
  });

  it('subtracts across two windows, not just the first', () => {
    // A split shift, with something booked in each half.
    const free = subtractSpans([span(540, 720), span(840, 1020)], [span(600, 660), span(900, 960)]);
    expect(shape(free)).toEqual([
      [540, 600],
      [660, 720],
      [840, 900],
      [960, 1020],
    ]);
  });

  it('ignores busy time outside the working windows', () => {
    // An appointment before opening — a staff override (D-8) — must not carve
    // a hole out of a window it does not touch.
    expect(shape(subtractSpans([span(540, 1020)], [span(400, 480)]))).toEqual([[540, 1020]]);
  });

  it('clips a busy interval that starts before the window opens', () => {
    // A booking that runs 08:30–09:30 into a 09:00 open: the gap starts at
    // 09:30, not at 09:00, or the grid offers time the stylist is working.
    expect(shape(subtractSpans([span(540, 1020)], [span(510, 570)]))).toEqual([[570, 1020]]);
  });

  it('returns nothing when the day is entirely taken', () => {
    expect(shape(subtractSpans([span(540, 1020)], [span(500, 1100)]))).toEqual([]);
  });

  it('returns nothing when there are no windows at all', () => {
    // A closed day is not a day full of gaps.
    expect(shape(subtractSpans([], [span(600, 660)]))).toEqual([]);
  });
});
