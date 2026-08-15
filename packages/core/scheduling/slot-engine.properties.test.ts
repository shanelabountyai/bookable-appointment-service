/**
 * A-008, second half: the spec §2 invariants as PROPERTY tests.
 *
 * The starter suite (slot-engine.test.ts) is a matrix of hand-picked cases. It
 * catches the bugs someone thought of. These generate thousands of queries and
 * assert the statements that must hold for ALL of them — which is what catches
 * the case nobody thought of, and is the difference between "the examples pass"
 * and "the invariant holds".
 *
 * Every generated query still supplies a frozen `now` (CLAUDE.md): a property
 * test that reads the clock is wrong even when it passes.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeSlots } from './slot-engine';
import {
  type BusyInterval,
  type SlotQuery,
  type WorkingWindow,
  calendarDay,
  instantFromIso,
  wallTime,
  zoneId,
} from './types';

const MIN = 60_000;
const CHI = zoneId('America/Chicago');

/** Days chosen so the generator spends a real fraction of its time on the two
 *  transitions and a leap day, not just on ordinary Tuesdays. */
const DAYS = ['2026-06-09', '2026-03-08', '2026-11-01', '2028-02-29', '2026-01-31', '2026-12-31'] as const;

const hhmm = (totalMinutes: number): string =>
  `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;

/** A window generator that only ever produces well-formed windows — malformed
 *  input has its own (example-based) tests, and mixing the two would just make
 *  every property test assert "it threw". */
const arbWindow = fc
  .record({
    openMinutes: fc.integer({ min: 0, max: 20 * 60 }),
    lengthMinutes: fc.integer({ min: 15, max: 10 * 60 }),
    breakCount: fc.integer({ min: 0, max: 2 }),
  })
  .map(({ openMinutes, lengthMinutes, breakCount }): WorkingWindow => {
    const closeMinutes = Math.min(openMinutes + lengthMinutes, 23 * 60 + 45);
    const breaks: { open: string; close: string }[] = [];
    const span = closeMinutes - openMinutes;
    for (let i = 0; i < breakCount && span > 60; i++) {
      const bOpen = openMinutes + Math.floor((span * (i + 1)) / (breakCount + 2));
      breaks.push({ open: hhmm(bOpen), close: hhmm(Math.min(bOpen + 30, closeMinutes)) });
    }
    return {
      open: wallTime(hhmm(openMinutes)),
      close: wallTime(hhmm(closeMinutes)),
      endsNextDay: false,
      breaks: breaks.map((b) => ({ open: wallTime(b.open), close: wallTime(b.close) })),
    };
  })
  .filter((w) => w.close > w.open);

const arbBusy = fc
  .record({
    offsetMinutes: fc.integer({ min: -120, max: 26 * 60 }),
    lengthMinutes: fc.integer({ min: 5, max: 180 }),
    kind: fc.constantFrom<BusyInterval['kind']>('booking', 'time_off', 'ad_hoc_block'),
  })
  .map(({ offsetMinutes, lengthMinutes, kind }, ) => ({ offsetMinutes, lengthMinutes, kind }));

const arbQuery = fc
  .record({
    day: fc.constantFrom(...DAYS),
    windows: fc.array(arbWindow, { minLength: 0, maxLength: 3 }),
    durationMinutes: fc.integer({ min: 5, max: 180 }),
    bufferBeforeMinutes: fc.integer({ min: 0, max: 30 }),
    bufferAfterMinutes: fc.integer({ min: 0, max: 30 }),
    intervalMinutes: fc.constantFrom(5, 10, 15, 20, 30, 60),
    busySpecs: fc.array(arbBusy, { minLength: 0, maxLength: 6 }),
    leadMinutes: fc.constantFrom(0, 30, 120),
    anchor: fc.constantFrom<'window-open' | 'local-midnight'>('window-open', 'local-midnight'),
    ambiguousLocalTime: fc.constantFrom<'offer-both' | 'offer-earlier-only'>('offer-both', 'offer-earlier-only'),
    bufferMayOverlapBreak: fc.boolean(),
    bufferMayExtendPastClose: fc.boolean(),
    nowOffsetHours: fc.integer({ min: -48, max: 48 }),
  })
  .map((spec): SlotQuery => {
    // A frozen `now`, derived from the day rather than from the clock.
    const dayStart = instantFromIso(`${spec.day}T00:00:00Z`);
    const now = (dayStart + spec.nowOffsetHours * 60 * MIN) as typeof dayStart;
    const busy: BusyInterval[] = spec.busySpecs.map((b, i) => {
      const start = (dayStart + b.offsetMinutes * MIN) as typeof dayStart;
      return {
        start,
        end: (start + b.lengthMinutes * MIN) as typeof dayStart,
        kind: b.kind,
        id: `busy-${i}`,
      };
    });
    return {
      day: calendarDay(spec.day),
      businessZone: CHI,
      service: {
        durationMinutes: spec.durationMinutes,
        bufferBeforeMinutes: spec.bufferBeforeMinutes,
        bufferAfterMinutes: spec.bufferAfterMinutes,
      },
      windows: spec.windows,
      busy,
      grid: { intervalMinutes: spec.intervalMinutes, anchor: spec.anchor },
      now,
      minimumLeadMinutes: spec.leadMinutes,
      policy: {
        bufferMayOverlapBreak: spec.bufferMayOverlapBreak,
        bufferMayExtendPastClose: spec.bufferMayExtendPastClose,
        ambiguousLocalTime: spec.ambiguousLocalTime,
      },
    };
  });

// Deterministic by construction, matching the repo convention that gate tests
// never flake: a fixed seed means a failure here is always reproducible from the
// same command. Random-seed exploration belongs in the nightly fuzz job (the
// same split the spec uses for the race tests vs. the nightly SQL-invariant
// fuzz) — set FC_RANDOM_SEED=1 to explore locally.
/** 300 generated cases per property is real work — 1-3s locally, several times
 *  that on a CI runner. Vitest's 5s default is sized for unit tests, so these
 *  get their own budget rather than the suite losing coverage to fit it. Unit
 *  tests keep the tight default, where a hang should fail fast. */
const PROP_TIMEOUT = 60_000;

const RUNS = process.env.FC_RANDOM_SEED
  ? { numRuns: 300 }
  : { numRuns: 300, seed: 20260815, endOnFailure: true };

describe('§2.1–2.3 — purity, determinism, order-insensitivity', () => {
  it('returns an equal result for equal input, every time', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        expect(computeSlots(q)).toEqual(computeSlots(q));
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('is insensitive to the order of the busy array', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        const reversed = { ...q, busy: [...q.busy].reverse() };
        expect(computeSlots(reversed).slots).toEqual(computeSlots(q).slots);
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('is insensitive to the order of the windows array', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        const reversed = { ...q, windows: [...q.windows].reverse() };
        expect(computeSlots(reversed).slots).toEqual(computeSlots(q).slots);
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);
});

describe('§2.4–2.8 — the shape of every returned slot', () => {
  it('end is exactly start + duration, on the PHYSICAL axis (never a wall-clock delta)', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        for (const slot of computeSlots(q).slots) {
          expect(slot.end - slot.start).toBe(q.service.durationMinutes * MIN);
        }
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('blocked range is exactly body ± the SERVICE’s own buffers', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        for (const slot of computeSlots(q).slots) {
          expect(slot.start - slot.blockedStart).toBe(q.service.bufferBeforeMinutes * MIN);
          expect(slot.blockedEnd - slot.end).toBe(q.service.bufferAfterMinutes * MIN);
        }
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('slots are strictly increasing and never duplicated', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        const { slots } = computeSlots(q);
        for (let i = 1; i < slots.length; i++) {
          expect(slots[i]!.start).toBeGreaterThan(slots[i - 1]!.start);
        }
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('every slot start sits on the grid relative to a window open', () => {
    fc.assert(
      fc.property(
        arbQuery.filter((q) => q.grid.anchor === 'window-open' && q.windows.length > 0),
        (q) => {
          const { slots, meta } = computeSlots(q);
          const step = q.grid.intervalMinutes * MIN;
          for (const slot of slots) {
            const onGrid = meta.windowInstants.some(
              (w) => slot.start >= w.start && (slot.start - w.start) % step === 0,
            );
            expect(onGrid).toBe(true);
          }
        },
      ),
      RUNS,
    );
  }, PROP_TIMEOUT);
});

describe('§2.9–2.16 — no returned slot ever violates a constraint', () => {
  it('NEVER returns a slot whose blocked range overlaps a busy interval', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        for (const slot of computeSlots(q).slots) {
          for (const busy of q.busy) {
            const overlap = slot.blockedStart < busy.end && busy.start < slot.blockedEnd;
            expect(overlap).toBe(false);
          }
        }
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('NEVER returns a slot outside a working window, or one that crosses close', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        const { slots, meta } = computeSlots(q);
        for (const slot of slots) {
          const inside = meta.windowInstants.some((w) => slot.start >= w.start && slot.end <= w.end);
          expect(inside).toBe(true);
        }
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('NEVER returns a slot before now, or inside the lead time', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        const earliest = q.now + q.minimumLeadMinutes * MIN;
        for (const slot of computeSlots(q).slots) {
          expect(slot.start).toBeGreaterThanOrEqual(earliest);
        }
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('consecutive starts WITHIN one window differ by a whole number of grid steps', () => {
    // Deliberately scoped to a single window. The looser "any two consecutive
    // slots are a grid step apart" is FALSE and a random seed caught it:
    // windows 00:00-07:05 and 07:06-07:21 on a 60-minute grid legitimately
    // yield starts at 07:00 and 07:06, six minutes apart, because each window
    // anchors its own grid (D-4). Asserting the stronger property would have
    // forced a "fix" that broke split-shift providers.
    fc.assert(
      fc.property(arbQuery, (q) => {
        const { slots, meta } = computeSlots(q);
        const step = q.grid.intervalMinutes * MIN;
        const windowOf = (start: number) =>
          meta.windowInstants.findIndex((w) => start >= w.start && start < w.end);
        for (let i = 1; i < slots.length; i++) {
          const prev = slots[i - 1]!;
          const curr = slots[i]!;
          if (windowOf(prev.start) !== windowOf(curr.start)) continue;
          const gap = curr.start - prev.start;
          expect(gap).toBeGreaterThanOrEqual(step);
          expect(gap % step).toBe(0);
        }
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);
});

describe('§2.17–2.20 — monotonicity', () => {
  it('adding a busy interval NEVER adds a slot', () => {
    fc.assert(
      fc.property(arbQuery, fc.integer({ min: 0, max: 20 * 60 }), (q, offsetMinutes) => {
        const before = new Set(computeSlots(q).slots.map((s) => s.start));
        const dayStart = instantFromIso(`${q.day}T00:00:00Z`);
        const extra: BusyInterval = {
          start: (dayStart + offsetMinutes * MIN) as typeof dayStart,
          end: (dayStart + (offsetMinutes + 45) * MIN) as typeof dayStart,
          kind: 'booking',
          id: 'extra',
        };
        const after = computeSlots({ ...q, busy: [...q.busy, extra] }).slots;
        for (const slot of after) expect(before.has(slot.start)).toBe(true);
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('increasing the duration NEVER adds a slot', () => {
    fc.assert(
      fc.property(arbQuery, fc.integer({ min: 1, max: 120 }), (q, extraMinutes) => {
        const shorter = new Set(computeSlots(q).slots.map((s) => s.start));
        const longer = computeSlots({
          ...q,
          service: { ...q.service, durationMinutes: q.service.durationMinutes + extraMinutes },
        }).slots;
        for (const slot of longer) expect(shorter.has(slot.start)).toBe(true);
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('increasing a buffer NEVER adds a slot', () => {
    fc.assert(
      fc.property(arbQuery, fc.integer({ min: 1, max: 60 }), (q, extraMinutes) => {
        const before = new Set(computeSlots(q).slots.map((s) => s.start));
        const after = computeSlots({
          ...q,
          service: { ...q.service, bufferAfterMinutes: q.service.bufferAfterMinutes + extraMinutes },
        }).slots;
        for (const slot of after) expect(before.has(slot.start)).toBe(true);
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('advancing `now` NEVER adds a slot', () => {
    fc.assert(
      fc.property(arbQuery, fc.integer({ min: 1, max: 12 * 60 }), (q, extraMinutes) => {
        const before = new Set(computeSlots(q).slots.map((s) => s.start));
        const after = computeSlots({ ...q, now: (q.now + extraMinutes * MIN) as typeof q.now }).slots;
        for (const slot of after) expect(before.has(slot.start)).toBe(true);
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);
});

describe('§2 — explanations agree with results', () => {
  it('every candidate is either a slot or an exclusion, never both and never neither', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        const result = computeSlots({ ...q, explain: true });
        const slotStarts = new Set(result.slots.map((s) => s.start));
        const excludedStarts = new Set(result.excluded.map((e) => e.candidateStart));
        expect(result.slots.length + result.excluded.length).toBe(result.meta.candidatesConsidered);
        for (const start of slotStarts) expect(excludedStarts.has(start)).toBe(false);
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('every exclusion carries at least one reason — never an empty array', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        for (const exclusion of computeSlots({ ...q, explain: true }).excluded) {
          expect(exclusion.reasons.length).toBeGreaterThan(0);
        }
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  // Calendar privacy (spec §1.3): 'overlaps-booking' tells an anonymous visitor
  // exactly when the provider is with a client. Turning explain off must remove
  // the information, not just hide it behind a flag the route forgets to set.
  it('explain=false yields NO exclusions at all, whatever the query', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        expect(computeSlots(q).excluded).toEqual([]);
        expect(computeSlots({ ...q, explain: false }).excluded).toEqual([]);
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('turning explain on never changes the slots themselves', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        expect(computeSlots({ ...q, explain: true }).slots).toEqual(computeSlots(q).slots);
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);
});

describe('§2 — DST-day accounting', () => {
  it('localDayLengthMinutes is 1380 / 1500 / 1440 and nothing else, for these zones', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        const { localDayLengthMinutes } = computeSlots(q).meta;
        expect([1380, 1440, 1500]).toContain(localDayLengthMinutes);
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);

  it('window instants are disjoint, ordered, and non-empty after the union', () => {
    fc.assert(
      fc.property(arbQuery, (q) => {
        const { windowInstants } = computeSlots(q).meta;
        for (const w of windowInstants) expect(w.end).toBeGreaterThan(w.start);
        for (let i = 1; i < windowInstants.length; i++) {
          // Strictly after, not merely non-overlapping: touching ranges must
          // have been merged (DST-7), or a service spanning the join is lost.
          expect(windowInstants[i]!.start).toBeGreaterThan(windowInstants[i - 1]!.end);
        }
      }),
      RUNS,
    );
  }, PROP_TIMEOUT);
});
