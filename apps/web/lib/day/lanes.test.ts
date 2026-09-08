import { describe, expect, it } from 'vitest';
import type { GridItem } from './view-model';
import { assignLanes, laneStyle, withLanes } from './lanes';

/**
 * A-099 — the geometry half of "two clients at ten o'clock, drawn as two".
 *
 * Every case here is about a DIFFERENT wrong answer that is invisible on a
 * simple book: back-to-back clients halved (the half-open rule), the whole day
 * halved by one double-booked hour (per-cluster, not per-column), the gap chip
 * laned and the colour underneath it shrunk (appointments only), and the one
 * this item exists for — a pair where the answer is right for the second chip
 * and wrong for the first, which is what "the later one paints over the
 * earlier" looks like from the outside.
 */
const item = (over: Partial<GridItem> & { key: string; top: number; minutes: number }): GridItem => ({
  kind: 'appointment',
  time: '',
  title: over.key,
  label: over.key,
  ...over,
});

describe('assignLanes (A-099)', () => {
  it('gives one lane to spans that only touch — half-open, so back-to-back clients stay whole', () => {
    const laned = assignLanes([
      { top: 0, minutes: 60 },
      { top: 60, minutes: 60 },
      { top: 120, minutes: 30 },
    ]);
    expect(laned.map((s) => s.lanes)).toEqual([1, 1, 1]);
    expect(laned.map((s) => s.lane)).toEqual([0, 0, 0]);
  });

  it('splits an overlapping pair, and splits ONLY their own cluster', () => {
    const laned = assignLanes([
      { top: 0, minutes: 45 },
      { top: 60, minutes: 60 },
      { top: 60, minutes: 90 },
      { top: 210, minutes: 45 },
    ]);
    // The pair, and BOTH of them — an assertion on the second alone passes
    // against the bug this item is about.
    expect(laned.filter((s) => s.top === 60).map((s) => [s.lane, s.lanes])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    // One double-booked hour must not halve the day around it.
    expect(laned.filter((s) => s.top !== 60).map((s) => s.lanes)).toEqual([1, 1]);
  });

  it('reuses a lane once its occupant has ended, rather than opening a third', () => {
    const laned = assignLanes([
      { top: 0, minutes: 180 },
      { top: 0, minutes: 60 },
      { top: 60, minutes: 60 },
    ]);
    expect(laned.map((s) => s.lanes)).toEqual([2, 2, 2]);
    // Back into lane 0, under the 60-minute one that has finished — not a third
    // lane beside the long one, which would leave a third of the column blank.
    expect(laned.find((s) => s.top === 60)!.lane).toBe(0);
  });

  it('opens a third lane for three at once', () => {
    const laned = assignLanes([
      { top: 0, minutes: 60 },
      { top: 10, minutes: 60 },
      { top: 20, minutes: 60 },
    ]);
    expect(laned.map((s) => [s.lane, s.lanes])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
  });
});

describe('withLanes (A-099)', () => {
  const pair = [
    item({ key: 'a', top: 60, minutes: 60, title: 'Mei Chen' }),
    item({ key: 'b', top: 60, minutes: 90, title: 'Ruth Adeyemi', isOverride: true }),
    item({ key: 'later', top: 210, minutes: 45, title: 'Tom Byrne' }),
  ];

  it('names the other client on BOTH halves of the pair, and on nobody else', () => {
    const out = withLanes(pair);
    expect(out.find((i) => i.key === 'a')!.concurrent).toBe('Ruth Adeyemi');
    expect(out.find((i) => i.key === 'b')!.concurrent).toBe('Mei Chen');
    expect(out.find((i) => i.key === 'later')!.concurrent).toBeUndefined();
  });

  it('says it in the accessible name too, where there is no geometry to say it with', () => {
    const out = withLanes(pair);
    expect(out.find((i) => i.key === 'a')!.label).toBe('a, at the same time as Ruth Adeyemi');
  });

  it('returns items in the order it was given, so the caller still owns DOM order', () => {
    expect(withLanes(pair).map((i) => i.key)).toEqual(['a', 'b', 'later']);
  });

  it('leaves a gap chip full width — a colour’s developing hour is drawn OVER it on purpose (A-030)', () => {
    const out = withLanes([
      item({ key: 'colour', top: 0, minutes: 120 }),
      item({ key: 'gap', kind: 'gap', top: 45, minutes: 30 }),
    ]);
    expect(out.map((i) => i.lanes)).toEqual([undefined, undefined]);
    expect(out.find((i) => i.key === 'colour')!.concurrent).toBeUndefined();
  });

  it('names only who actually overlaps, not everyone in the cluster', () => {
    // a–b overlap, b–c overlap, a and c never share an instant.
    const out = withLanes([
      item({ key: 'a', top: 0, minutes: 60, title: 'A' }),
      item({ key: 'b', top: 30, minutes: 60, title: 'B' }),
      item({ key: 'c', top: 60, minutes: 60, title: 'C' }),
    ]);
    expect(out.find((i) => i.key === 'a')!.concurrent).toBe('B');
    expect(out.find((i) => i.key === 'c')!.concurrent).toBe('B');
    expect(out.find((i) => i.key === 'b')!.concurrent).toBe('A, C');
  });
});

describe('laneStyle (A-099)', () => {
  it('emits nothing for one lane, so an ordinary column renders exactly as before', () => {
    expect(laneStyle({ lane: 0, lanes: 1 })).toBeUndefined();
    expect(laneStyle({})).toBeUndefined();
  });

  it('gives each of a pair its own half, offset so they cannot be the same box', () => {
    const first = laneStyle({ lane: 0, lanes: 2 })!;
    const second = laneStyle({ lane: 1, lanes: 2 })!;
    expect(first.width).toBe(second.width);
    expect(first.left).not.toBe(second.left);
    // `inset-x-1` sets `right`; left + width + right is over-constrained and
    // which one CSS drops depends on writing direction.
    expect(first.right).toBe('auto');
  });
});
