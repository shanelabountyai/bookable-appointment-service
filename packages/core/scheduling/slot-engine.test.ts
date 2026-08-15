/**
 * A-008's STARTING target — shipped red on purpose (Session 0 verifies the red state).
 *
 * Every expected instant on a DST day below is taken verbatim from
 * docs/reviews/03-slot-engine-spec.md §3, where it was verified by execution
 * against the IANA tzdata — do not re-derive these by hand.
 *
 * This file is a subset of the full matrix. A-008's definition of done is the
 * WHOLE matrix (spec §3) plus the §2 invariants as fast-check property tests.
 *
 * House rules exercised here (CLAUDE.md):
 *  - every test supplies a frozen `now` — nothing reads the clock
 *  - adjacent bookings always carry UNEQUAL buffers, so whose-buffer bugs can't hide
 *  - service duration ≠ grid interval in the removal tests, so GR-2 can't hide
 *  - absence assertions check the exclusion REASON, not just non-membership
 */
import { describe, expect, it } from 'vitest';
import { computeSlots } from './slot-engine';
import {
  type BusyInterval,
  InvalidSlotQuery,
  type SlotPolicy,
  type SlotQuery,
  calendarDay,
  instantFromIso,
  wallTime,
  zoneId,
} from './types';

const CHI = zoneId('America/Chicago');
const MIN = 60_000;

const policy: SlotPolicy = {
  bufferMayOverlapBreak: true,
  bufferMayExtendPastClose: true,
  ambiguousLocalTime: 'offer-both',
};

const win = (open: string, close: string, breaks: { open: string; close: string }[] = [], endsNextDay = false) => ({
  open: wallTime(open),
  close: wallTime(close),
  endsNextDay,
  breaks: breaks.map((b) => ({ open: wallTime(b.open), close: wallTime(b.close) })),
});

const booking = (startIso: string, endIso: string, id = 'bk1'): BusyInterval => ({
  start: instantFromIso(startIso),
  end: instantFromIso(endIso),
  kind: 'booking',
  id,
});

/** Ordinary Tuesday, 2026-06-09, America/Chicago (CDT, -05:00 all day). */
const base = (over: Partial<SlotQuery> = {}): SlotQuery => ({
  day: calendarDay('2026-06-09'),
  businessZone: CHI,
  service: { durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
  windows: [win('09:00', '17:00')],
  busy: [],
  grid: { intervalMinutes: 15, anchor: 'window-open' },
  now: instantFromIso('2026-06-09T00:00:00-05:00'),
  minimumLeadMinutes: 0,
  policy,
  ...over,
});

const starts = (q: SlotQuery) => computeSlots(q).slots.map((s) => s.start);
const labels = (q: SlotQuery) => computeSlots(q).slots.map((s) => s.label.time);
const reasonsFor = (q: SlotQuery, startIso: string) => {
  const at = instantFromIso(startIso);
  const ex = computeSlots({ ...q, explain: true }).excluded.find((e) => e.candidateStart === at);
  return ex?.reasons ?? null;
};

describe('purity and determinism (§2.1–2.3)', () => {
  it('returns an equal result for equal input, called twice', () => {
    const q = base({ busy: [booking('2026-06-09T10:00:00-05:00', '2026-06-09T11:15:00-05:00')] });
    expect(computeSlots(q)).toEqual(computeSlots(q));
  });

  it('is insensitive to the order of busy intervals', () => {
    const b1 = booking('2026-06-09T10:00:00-05:00', '2026-06-09T11:15:00-05:00', 'a');
    const b2 = booking('2026-06-09T14:00:00-05:00', '2026-06-09T14:30:00-05:00', 'b');
    expect(computeSlots(base({ busy: [b1, b2] }))).toEqual(computeSlots(base({ busy: [b2, b1] })));
  });
});

describe('ordinary day — grid, windows, breaks', () => {
  it('a free 09:00–17:00 window offers 29 starts for a 60-min service, 09:00 first, 16:00 last (GR-1 shape)', () => {
    const s = starts(base());
    expect(s).toHaveLength(29);
    expect(s[0]).toBe(instantFromIso('2026-06-09T09:00:00-05:00'));
    expect(s[28]).toBe(instantFromIso('2026-06-09T16:00:00-05:00'));
  });

  it('every slot ends exactly start + duration and the list is strictly increasing (§2.5, §2.6)', () => {
    const { slots } = computeSlots(base());
    for (const s of slots) expect(s.end - s.start).toBe(60 * MIN);
    for (let i = 1; i < slots.length; i++) expect(slots[i]!.start).toBeGreaterThan(slots[i - 1]!.start);
  });

  it('OV-1 (PRD AC): a 12:00–13:00 break renders no slots over lunch; last morning start is 11:00, first afternoon 13:00', () => {
    const q = base({ windows: [win('09:00', '17:00', [{ open: '12:00', close: '13:00' }])] });
    const s = starts(q);
    expect(s).toContain(instantFromIso('2026-06-09T11:00:00-05:00'));
    expect(s).not.toContain(instantFromIso('2026-06-09T11:15:00-05:00'));
    expect(s).toContain(instantFromIso('2026-06-09T13:00:00-05:00'));
    expect(s).toHaveLength(22);
    expect(reasonsFor(q, '2026-06-09T12:00:00-05:00')).toContain('inside-break');
  });

  it('GR-5/GR-6: a 60-min service in a 09:00–10:00 window yields exactly one slot; a 61-min service yields none, reason crosses-window-close', () => {
    const tight = base({ windows: [win('09:00', '10:00')] });
    expect(starts(tight)).toEqual([instantFromIso('2026-06-09T09:00:00-05:00')]);
    const over = base({
      windows: [win('09:00', '10:00')],
      service: { durationMinutes: 61, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
    });
    expect(starts(over)).toHaveLength(0);
    expect(reasonsFor(over, '2026-06-09T09:00:00-05:00')).toContain('crosses-window-close');
  });

  it('GR-2: a 09:15–10:05 booking removes EVERY overlapping 50-min candidate (09:00 through 10:00), not just the identical start', () => {
    const q = base({
      service: { durationMinutes: 50, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      busy: [booking('2026-06-09T09:15:00-05:00', '2026-06-09T10:05:00-05:00')],
    });
    const s = starts(q);
    expect(s).toHaveLength(24); // 29 candidates − the 5 that overlap
    expect(s[0]).toBe(instantFromIso('2026-06-09T10:15:00-05:00'));
    expect(reasonsFor(q, '2026-06-09T09:30:00-05:00')).toContain('overlaps-booking');
  });
});

describe('buffers (§3.H) — adjacent buffers deliberately unequal', () => {
  // Existing booking body 10:00–11:00 with ITS OWN buffer-after 15 → arrives as blocked [10:00, 11:15).
  const blocked1015 = booking('2026-06-09T10:00:00-05:00', '2026-06-09T11:15:00-05:00');

  it('BF-1 (PRD AC): with a booking blocked to 11:15, 11:00 is unavailable and 11:15 is the first offered slot after it', () => {
    const q = base({ busy: [blocked1015] });
    const s = starts(q);
    expect(s).not.toContain(instantFromIso('2026-06-09T11:00:00-05:00'));
    expect(s).toContain(instantFromIso('2026-06-09T11:15:00-05:00'));
  });

  it('BF-2: the candidate carries its OWN buffer-after (10, not the neighbour’s 15) into blockedEnd', () => {
    const q = base({
      busy: [blocked1015],
      service: { durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 10 },
    });
    const slot = computeSlots(q).slots.find((s) => s.start === instantFromIso('2026-06-09T11:15:00-05:00'));
    expect(slot).toBeDefined();
    expect(slot!.blockedEnd).toBe(instantFromIso('2026-06-09T12:25:00-05:00'));
  });

  it('BF-3 (half-open): a 15-min service fits EXACTLY between blocked-to-11:15 and a booking at 11:30', () => {
    const q = base({
      service: { durationMinutes: 15, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      busy: [blocked1015, booking('2026-06-09T11:30:00-05:00', '2026-06-09T12:00:00-05:00', 'bk2')],
    });
    expect(starts(q)).toContain(instantFromIso('2026-06-09T11:15:00-05:00'));
  });

  it('BF-4: the same fit dies when the service adds a 5-min buffer, with reason overlaps-buffer', () => {
    const q = base({
      service: { durationMinutes: 15, bufferBeforeMinutes: 0, bufferAfterMinutes: 5 },
      busy: [blocked1015, booking('2026-06-09T11:30:00-05:00', '2026-06-09T12:00:00-05:00', 'bk2')],
    });
    expect(starts(q)).not.toContain(instantFromIso('2026-06-09T11:15:00-05:00'));
    expect(reasonsFor(q, '2026-06-09T11:15:00-05:00')).toEqual(['overlaps-buffer']);
  });

  it('BF-6: buffer past closing is offered under the default policy and excluded when the flag is off', () => {
    const svc = { durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 15 };
    const last = instantFromIso('2026-06-09T16:00:00-05:00'); // body 16:00–17:00, buffer to 17:15
    expect(starts(base({ service: svc }))).toContain(last);
    expect(
      starts(base({ service: svc, policy: { ...policy, bufferMayExtendPastClose: false } })),
    ).not.toContain(last);
  });
});

describe('now and lead time (§3.K, D-11)', () => {
  it('NW-1/NW-4: nothing starts before now; a slot already in progress is gone', () => {
    const q = base({ now: instantFromIso('2026-06-09T10:07:00-05:00') });
    const s = starts(q);
    expect(s[0]).toBe(instantFromIso('2026-06-09T10:15:00-05:00'));
    expect(reasonsFor(q, '2026-06-09T10:00:00-05:00')).toContain('in-the-past');
  });

  it('NW-2/NW-3: the lead-time boundary is inclusive — start === now + lead is offered, one ms earlier is not', () => {
    const now = instantFromIso('2026-06-09T08:00:00-05:00');
    const q = base({ now, minimumLeadMinutes: 120 });
    expect(starts(q)).toContain(instantFromIso('2026-06-09T10:00:00-05:00'));
    expect(reasonsFor(q, '2026-06-09T09:45:00-05:00')).toContain('inside-lead-time');
  });

  it('NW-5: now after close returns empty, not an error', () => {
    expect(starts(base({ now: instantFromIso('2026-06-09T18:00:00-05:00') }))).toHaveLength(0);
  });
});

describe('DST spring-forward — 2026-03-08, America/Chicago, 02:00→03:00, 23-hour day (spec §3.A)', () => {
  const sf = (over: Partial<SlotQuery> = {}) =>
    base({
      day: calendarDay('2026-03-08'),
      windows: [win('01:00', '05:00')],
      now: instantFromIso('2026-03-08T00:00:00-06:00'),
      ...over,
    });

  it('DST-1: a 15-min service yields exactly 12 slots at uniform physical spacing, and no 02:xx label exists', () => {
    const q = sf({ service: { durationMinutes: 15, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 } });
    const result = computeSlots(q);
    expect(result.slots).toHaveLength(12);
    expect(result.slots[0]!.start).toBe(instantFromIso('2026-03-08T01:00:00-06:00')); // 07:00Z
    expect(result.slots[11]!.start).toBe(instantFromIso('2026-03-08T04:45:00-05:00')); // 09:45Z
    for (let i = 1; i < 12; i++) expect(result.slots[i]!.start - result.slots[i - 1]!.start).toBe(15 * MIN);
    expect(labels(q)).toEqual([
      '01:00', '01:15', '01:30', '01:45',
      '03:00', '03:15', '03:30', '03:45',
      '04:00', '04:15', '04:30', '04:45',
    ]);
  });

  it('DST-2: the window is 180 physical minutes and the local day is 1380', () => {
    const { meta } = computeSlots(sf());
    expect(meta.localDayLengthMinutes).toBe(1380);
    const total = meta.windowInstants.reduce((acc, w) => acc + (w.end - w.start), 0);
    expect(total).toBe(180 * MIN);
  });

  it('DST-3: a 90-min service starting 01:30 CST ends at 04:00 CDT — 90 physical minutes, 2h30m on the wall', () => {
    const q = sf({ service: { durationMinutes: 90, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 } });
    const slot = computeSlots(q).slots.find((s) => s.start === instantFromIso('2026-03-08T01:30:00-06:00'));
    expect(slot).toBeDefined();
    expect(slot!.end - slot!.start).toBe(90 * MIN);
    expect(slot!.end).toBe(instantFromIso('2026-03-08T04:00:00-05:00')); // 09:00Z
  });

  it('DST-4: the last valid 90-min start is 03:30 CDT (08:30Z), 7 starts total', () => {
    const q = sf({ service: { durationMinutes: 90, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 } });
    const s = starts(q);
    expect(s).toHaveLength(7);
    expect(s[6]).toBe(instantFromIso('2026-03-08T03:30:00-05:00'));
  });

  it('DST-7: split window rows 01:00–02:00 and 03:00–04:00 are contiguous on the instant axis — a 90-min service starting 01:15 is VALID', () => {
    const q = sf({
      windows: [win('01:00', '02:00'), win('03:00', '04:00')],
      service: { durationMinutes: 90, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
    });
    expect(starts(q)).toContain(instantFromIso('2026-03-08T01:15:00-06:00'));
  });

  it('DST-6 (conservation): the same window on the previous ordinary Sunday yields 13 sixty-min starts; the transition day yields 9', () => {
    const ordinary = base({
      day: calendarDay('2026-03-01'),
      windows: [win('01:00', '05:00')],
      now: instantFromIso('2026-03-01T00:00:00-06:00'),
    });
    expect(starts(ordinary)).toHaveLength(13);
    expect(starts(sf())).toHaveLength(9);
  });
});

describe('DST fall-back — 2026-11-01, America/Chicago, 02:00→01:00, 25-hour day (spec §3.B)', () => {
  const fb = (over: Partial<SlotQuery> = {}) =>
    base({
      day: calendarDay('2026-11-01'),
      windows: [win('00:00', '06:00')],
      service: { durationMinutes: 15, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      now: instantFromIso('2026-11-01T00:00:00-05:00'),
      ...over,
    });

  it('FB-1: the doubled hour is real capacity — 28 slots, with 01:00–01:45 each appearing twice under different offsets', () => {
    const result = computeSlots(fb());
    expect(result.slots).toHaveLength(28);
    const oneThirty = result.slots.filter((s) => s.label.time === '01:30');
    expect(oneThirty).toHaveLength(2);
    expect(oneThirty[0]!.start).toBe(instantFromIso('2026-11-01T01:30:00-05:00')); // 06:30Z CDT
    expect(oneThirty[1]!.start).toBe(instantFromIso('2026-11-01T01:30:00-06:00')); // 07:30Z CST
    expect(oneThirty.map((s) => s.label.offset)).toEqual(['-05:00', '-06:00']);
    expect(oneThirty.every((s) => s.labelIsAmbiguous)).toBe(true);
    expect(result.meta.localDayLengthMinutes).toBe(1500);
  });

  it('FB-3/FB-4: the two 01:30 sixty-min slots are distinct instants with distinct ends', () => {
    const q = fb({ service: { durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 } });
    const first = computeSlots(q).slots.find((s) => s.start === instantFromIso('2026-11-01T01:30:00-05:00'));
    const second = computeSlots(q).slots.find((s) => s.start === instantFromIso('2026-11-01T01:30:00-06:00'));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.end).toBe(instantFromIso('2026-11-01T01:30:00-06:00')); // ends as the hour repeats
    expect(second!.end).toBe(instantFromIso('2026-11-01T02:30:00-06:00'));
  });

  it('FB-7: offer-earlier-only suppresses the four repeated labels, 24 slots, reason ambiguous-suppressed', () => {
    const q = fb({ policy: { ...policy, ambiguousLocalTime: 'offer-earlier-only' } });
    expect(starts(q)).toHaveLength(24);
    expect(reasonsFor(q, '2026-11-01T01:30:00-06:00')).toContain('ambiguous-suppressed');
  });

  it('FB-8: a booking crossing the transition (05:30Z–08:30Z) blocks 12 candidates — physical hours, not wall-clock', () => {
    const q = fb({ busy: [booking('2026-11-01T00:30:00-05:00', '2026-11-01T02:30:00-06:00')] });
    expect(starts(q)).toHaveLength(16); // 28 − 12
  });
});

describe('overnight windows (spec §3.E)', () => {
  it('MN-1/MN-3: Friday 20:00–02:00 (endsNextDay) offers 21 sixty-min starts; post-midnight slots carry label.day of Saturday', () => {
    const q = base({
      day: calendarDay('2026-06-05'),
      windows: [win('20:00', '02:00', [], true)],
      now: instantFromIso('2026-06-05T12:00:00-05:00'),
    });
    const result = computeSlots(q);
    expect(result.slots).toHaveLength(21);
    const lastSlot = result.slots[20]!;
    expect(lastSlot.start).toBe(instantFromIso('2026-06-06T01:00:00-05:00'));
    expect(lastSlot.label.day).toBe('2026-06-06');
    expect(result.slots[0]!.label.day).toBe('2026-06-05');
  });
});

describe('degenerate input — malformed THROWS, semantically-empty returns [] (spec §3.L)', () => {
  it('DEG-1: intervalMinutes = 0 throws InvalidSlotQuery (the non-terminating loop guard)', () => {
    expect(() => computeSlots(base({ grid: { intervalMinutes: 0, anchor: 'window-open' } }))).toThrow(
      InvalidSlotQuery,
    );
  });

  it('DEG-2/DEG-3/DEG-4: zero duration, negative buffer, and fractional minutes each throw', () => {
    expect(() =>
      computeSlots(base({ service: { durationMinutes: 0, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 } })),
    ).toThrow(InvalidSlotQuery);
    expect(() =>
      computeSlots(base({ service: { durationMinutes: 60, bufferBeforeMinutes: -5, bufferAfterMinutes: 0 } })),
    ).toThrow(InvalidSlotQuery);
    expect(() =>
      computeSlots(base({ service: { durationMinutes: 30.5, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 } })),
    ).toThrow(InvalidSlotQuery);
  });

  it('DEG-9: close <= open without endsNextDay throws — never swapped, never silently empty', () => {
    expect(() => computeSlots(base({ windows: [win('17:00', '09:00')] }))).toThrow(InvalidSlotQuery);
  });

  it('DEG-10: a busy interval with end <= start throws', () => {
    expect(() =>
      computeSlots(base({ busy: [booking('2026-06-09T11:00:00-05:00', '2026-06-09T10:00:00-05:00')] })),
    ).toThrow(InvalidSlotQuery);
  });

  it('DEG-12: a fixed-offset or abbreviation zone is rejected', () => {
    expect(() => computeSlots(base({ businessZone: zoneId('CST') }))).toThrow(InvalidSlotQuery);
    expect(() => computeSlots(base({ businessZone: zoneId('America/Chicagoo') }))).toThrow(InvalidSlotQuery);
  });

  it('DEG-6: no windows at all is a legitimate empty day, not an error', () => {
    expect(starts(base({ windows: [] }))).toHaveLength(0);
  });

  it('a full-day time off empties the day without error', () => {
    const off: BusyInterval = {
      start: instantFromIso('2026-06-09T00:00:00-05:00'),
      end: instantFromIso('2026-06-10T00:00:00-05:00'),
      kind: 'time_off',
      id: 'off1',
    };
    const q = base({ busy: [off] });
    expect(starts(q)).toHaveLength(0);
    expect(reasonsFor(q, '2026-06-09T09:00:00-05:00')).toContain('overlaps-time-off');
  });

  it('DEG-11: a duplicated identical booking changes nothing', () => {
    const b = booking('2026-06-09T10:00:00-05:00', '2026-06-09T11:00:00-05:00');
    expect(computeSlots(base({ busy: [b] }))).toEqual(computeSlots(base({ busy: [b, { ...b }] })));
  });

  it('DEG-8: a busy interval from another week is accepted and ignored', () => {
    const stale = booking('2026-05-01T10:00:00-05:00', '2026-05-01T11:00:00-05:00');
    expect(computeSlots(base({ busy: [stale] }))).toEqual(computeSlots(base()));
  });
});

describe('monotonicity spot checks (§2.17–2.20 — full property tests arrive with A-008)', () => {
  it('adding a busy interval never adds a slot', () => {
    const before = new Set(starts(base()));
    const after = starts(base({ busy: [booking('2026-06-09T13:00:00-05:00', '2026-06-09T13:45:00-05:00')] }));
    for (const s of after) expect(before.has(s)).toBe(true);
    expect(after.length).toBeLessThan(before.size);
  });

  it('increasing duration never adds a slot', () => {
    const short = new Set(starts(base({ service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 } })));
    const long = starts(base({ service: { durationMinutes: 90, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 } }));
    for (const s of long) expect(short.has(s)).toBe(true);
  });
});

/**
 * Added after the Milestone 1 operator review (docs/reviews/05-*.md, R-1).
 *
 * The engine collapsed EVERY non-booking busy kind to 'overlaps-time-off'.
 * The matrix never caught it because no fixture used `ad_hoc_block`, and the
 * one time-off test asserted `toContain` — which passes for a dozen wrong
 * reasons. These assert the reason EXACTLY, per the house rule.
 */
describe('each busy kind reports its own reason (operator review R-1)', () => {
  const busyOf = (kind: BusyInterval['kind'], id: string): BusyInterval => ({
    start: instantFromIso('2026-06-09T10:00:00-05:00'),
    end: instantFromIso('2026-06-09T11:00:00-05:00'),
    kind,
    id,
  });

  it.each([
    ['time_off', 'overlaps-time-off'],
    ['ad_hoc_block', 'overlaps-block'],
    ['running-late', 'provider-running-late'],
  ] as const)('a %s interval excludes with exactly ["%s"]', (kind, reason) => {
    const q = base({ busy: [busyOf(kind, `${kind}-1`)] });
    expect(reasonsFor(q, '2026-06-09T10:00:00-05:00')).toEqual([reason]);
    expect(starts(q)).not.toContain(instantFromIso('2026-06-09T10:00:00-05:00'));
  });

  it('a running-late overrun removes the slots the book still shows as free', () => {
    // Dana is 40 minutes behind: her 10:00 is still running at 10:40, so the
    // 10:15/10:30 candidates a customer can currently see are not real.
    const overrun: BusyInterval = {
      start: instantFromIso('2026-06-09T10:00:00-05:00'),
      end: instantFromIso('2026-06-09T10:40:00-05:00'),
      kind: 'running-late',
      id: 'late-dana',
    };
    const q = base({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      busy: [overrun],
    });
    expect(starts(q)).not.toContain(instantFromIso('2026-06-09T10:15:00-05:00'));
    expect(starts(q)).not.toContain(instantFromIso('2026-06-09T10:30:00-05:00'));
    // ...and the first genuinely free slot after the overrun IS offered.
    expect(starts(q)).toContain(instantFromIso('2026-06-09T10:45:00-05:00'));
    expect(reasonsFor(q, '2026-06-09T10:30:00-05:00')).toEqual(['provider-running-late']);
  });

  it('reports every applicable reason, in a stable order, regardless of busy order', () => {
    const timeOff = busyOf('time_off', 'off1');
    const block = busyOf('ad_hoc_block', 'blk1');
    const late = busyOf('running-late', 'late1');
    const expected = ['overlaps-time-off', 'overlaps-block', 'provider-running-late'];
    expect(reasonsFor(base({ busy: [timeOff, block, late] }), '2026-06-09T10:00:00-05:00')).toEqual(expected);
    expect(reasonsFor(base({ busy: [late, block, timeOff] }), '2026-06-09T10:00:00-05:00')).toEqual(expected);
  });
});
