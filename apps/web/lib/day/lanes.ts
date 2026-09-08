/**
 * A-099 — TWO CLIENTS AT TEN O'CLOCK, DRAWN AS TWO CLIENTS.
 *
 * D-8 ends with a promise about a screen: an override writes a zero-width
 * blocked range plus `overriddenFromRange` "so the constraint never lies and
 * the day view renders the true collision". It did not render it. Both chips
 * computed the same `top` and the same `minutes`, and the horizontal extent was
 * not per-item at all — `CHIP_SHELL` is `absolute inset-x-1` for every chip in
 * the product — so the later one in DOM order painted over the earlier one,
 * opaque, `overflow-hidden`. **The client already in the book was the one who
 * disappeared**, under a chip wearing the override marker, which reads as one
 * deliberate override rather than as two people at ten. The desk overrides
 * BECAUSE it intends to see both.
 *
 * THIS FILE IS THE ONLY PLACE THAT DECIDES WHAT "AT ONCE" MEANS, and it is a
 * separate module rather than a private helper in the view model for the reason
 * this repo keeps re-learning: `GridColumn.items` has FOUR readers — the grid,
 * the printed sheet, the stylist's phone list and (through `RoomTrack`) the
 * room strip — and a predicate re-typed in any one of them is a fourth opinion
 * about the same fact. The gallery's hand-built fixtures come through here too,
 * so `/staff/design` cannot draw a pair the product would draw differently.
 *
 * HALF-OPEN, like everything else in this project: 10:00–11:00 and 11:00–12:00
 * are consecutive clients, not two people in one chair. Getting that wrong
 * halves the width of every back-to-back column in the salon.
 */
import type { GridItem } from './view-model';

/** Anything the day surfaces draw as a band: minutes from the top of the grid,
 *  and how many minutes tall. The DRAWN extent, deliberately — the room strip
 *  clamps its blocks to the rendered height, and what covers what is decided by
 *  what is on the screen, not by the instants behind it. */
export interface Spanning {
  top: number;
  minutes: number;
}

export interface Laned {
  /** Which share of the column's width this one takes, 0-based. */
  lane?: number;
  /** How many shares the column is split into HERE — per overlapping cluster,
   *  never per column: one double-booked hour must not halve the whole day. */
  lanes?: number;
}

export const overlapsSpan = (a: Spanning, b: Spanning): boolean =>
  a.top < b.top + b.minutes && b.top < a.top + a.minutes;

/**
 * Greedy interval packing. Walk in time order; a span takes the first lane
 * whose last occupant has ENDED (`<=`, half-open), or opens a new one. When
 * nothing in flight reaches the next span, the cluster closes and its width is
 * shared only among its own members.
 */
export function assignLanes<T extends Spanning>(spans: readonly T[]): (T & { lane: number; lanes: number })[] {
  const sorted = [...spans].sort((a, b) => a.top - b.top || a.minutes - b.minutes);
  const out: (T & { lane: number; lanes: number })[] = [];
  let cluster: (T & { lane: number; lanes: number })[] = [];
  let laneEnds: number[] = [];

  const closeCluster = () => {
    for (const member of cluster) member.lanes = laneEnds.length;
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
  };

  for (const span of sorted) {
    if (laneEnds.length && span.top >= Math.max(...laneEnds)) closeCluster();
    const free = laneEnds.findIndex((end) => end <= span.top);
    const lane = free === -1 ? laneEnds.length : free;
    laneEnds[lane] = span.top + span.minutes;
    cluster.push({ ...span, lane, lanes: 1 });
  }
  closeCluster();
  return out;
}

/**
 * The column's items, with the appointments laned and told who they share the
 * hour with. Returned in the caller's order — the view model sorts afterwards,
 * and that sort is what holds tab order and screen-reader order.
 *
 * ONLY APPOINTMENTS TAKE A LANE. A gap chip is deliberately drawn OVER an
 * appointment (A-030: a colour's developing hour is real bookable time, and
 * A-069's released no-show is the same shape) — giving it a lane would halve
 * the colour underneath it on an ordinary Tuesday and hide nothing. Breaks and
 * absences are bands behind the day, not people in the chair.
 *
 * `concurrent` NAMES THE OTHER CLIENT, and it is computed here rather than
 * left to the renderers because two of the four have no geometry to say it
 * with: the printed sheet and the phone list put the pair on CONSECUTIVE ROWS,
 * which is the shape of SEQUENCE. "10:00 Ada Chen" above "10:00 Ben Ito" on
 * paper reads as a printing error; "at the same time as Ada Chen" reads as
 * what the desk decided. It is real overlap, not cluster membership — A can
 * share a cluster with C without ever being in the room at the same time.
 */
export function withLanes(items: readonly GridItem[]): GridItem[] {
  const appointments = items.filter((item) => item.kind === 'appointment');
  if (appointments.length < 2) return [...items];

  const laned = new Map<string, GridItem>();
  for (const item of assignLanes(appointments)) {
    const others = appointments.filter((other) => other.key !== item.key && overlapsSpan(other, item));
    laned.set(item.key, {
      ...item,
      ...(others.length
        ? {
            concurrent: others.map((other) => other.title).join(', '),
            // The geometry is the answer on screen and there is no geometry in
            // an accessible name, so the name says it in words — §4's "never
            // colour alone", one axis over.
            label: `${item.label}, at the same time as ${others.map((other) => other.title).join(', ')}`,
          }
        : {}),
    });
  }
  return items.map((item) => laned.get(item.key) ?? item);
}

/**
 * The horizontal share, as inline style over `inset-x-1`.
 *
 * NOTHING IS EMITTED FOR THE ONE-LANE CASE, which is every item on almost every
 * day: an ordinary column renders byte-identically to before this item. The
 * `- 0.125rem` is the gutter between two chips — without it they meet edge to
 * edge and read as one wide chip with a line through it.
 *
 * `right: auto` because `inset-x-1` sets it: left + width + right is
 * over-constrained, and which one CSS drops depends on writing direction.
 */
export function laneStyle(item: Laned): { left: string; width: string; right: string } | undefined {
  const lanes = item.lanes ?? 1;
  if (lanes < 2) return undefined;
  return {
    left: `calc(0.25rem + (100% - 0.5rem) * ${item.lane ?? 0} / ${lanes})`,
    width: `calc((100% - 0.5rem) / ${lanes} - 0.125rem)`,
    right: 'auto',
  };
}
