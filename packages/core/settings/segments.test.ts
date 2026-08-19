import { describe, expect, it } from 'vitest';
import {
  type Segment,
  gapSpans,
  scaleSegments,
  segmentsOrWhole,
  validateSegments,
  visitGapSpans,
} from './segments';

/** A colour: apply, develop, finish. The sample salon's only three-part
 *  service, and the one the whole feature exists for. */
const COLOUR: Segment[] = [
  { durationMinutes: 45, isGap: false },
  { durationMinutes: 35, isGap: true },
  { durationMinutes: 30, isGap: false },
];

describe('segmentsOrWhole', () => {
  it('gives an unsegmented service one implicit active segment', () => {
    expect(segmentsOrWhole([], 45)).toEqual([{ durationMinutes: 45, isGap: false }]);
  });

  it('leaves a segmented service alone', () => {
    expect(segmentsOrWhole(COLOUR, 110)).toBe(COLOUR);
  });
});

describe('validateSegments', () => {
  it('accepts the colour against its own duration', () => {
    expect(validateSegments(COLOUR, 110)).toEqual([]);
  });

  it('accepts an empty list — that is how a service goes back to unsegmented', () => {
    expect(validateSegments([], 45)).toEqual([]);
  });

  it('refuses parts that do not add up to the service duration, and says both numbers', () => {
    const [violation] = validateSegments(COLOUR, 120);
    expect(violation?.message).toContain('110');
    expect(violation?.message).toContain('120');
  });

  it('refuses a leading gap', () => {
    const segments = [{ durationMinutes: 10, isGap: true }, ...COLOUR];
    expect(validateSegments(segments, 120)[0]?.message).toMatch(/cannot start or end with a gap/);
  });

  it('refuses a trailing gap', () => {
    const segments = [...COLOUR, { durationMinutes: 10, isGap: true }];
    expect(validateSegments(segments, 120)[0]?.message).toMatch(/cannot start or end with a gap/);
  });

  it('refuses two adjacent gaps', () => {
    const segments: Segment[] = [
      { durationMinutes: 45, isGap: false },
      { durationMinutes: 20, isGap: true },
      { durationMinutes: 15, isGap: true },
      { durationMinutes: 30, isGap: false },
    ];
    expect(validateSegments(segments, 110)[0]?.message).toMatch(/Two gaps in a row/);
  });

  it('refuses a single segment — that is an unsegmented service with extra rows', () => {
    expect(validateSegments([{ durationMinutes: 45, isGap: false }], 45)[0]?.message).toMatch(/at least two parts/);
  });

  it('refuses a fractional or zero part', () => {
    const segments: Segment[] = [
      { durationMinutes: 45.5, isGap: false },
      { durationMinutes: 35, isGap: true },
      { durationMinutes: 29.5, isGap: false },
    ];
    expect(validateSegments(segments, 110)[0]?.message).toMatch(/whole number of minutes/);
  });
});

describe('scaleSegments (SEG-02)', () => {
  it('leaves everything alone at the service duration', () => {
    expect(scaleSegments(COLOUR, 110)).toEqual(COLOUR);
  });

  it('HOLDS THE GAP FIXED and shortens only the active parts', () => {
    // 110 → 95 takes 15 minutes off the 75 active minutes, never off the 35
    // minutes the colour spends developing.
    const scaled = scaleSegments(COLOUR, 95)!;
    expect(scaled[1]).toEqual({ durationMinutes: 35, isGap: true });
    expect(scaled[0]!.durationMinutes + scaled[2]!.durationMinutes).toBe(60);
  });

  it('is exact under rounding — the parts always re-add to the target', () => {
    // 97 is chosen because 45 and 30 do not scale to whole minutes against it:
    // the remainder has to land somewhere, and the total must still be right.
    for (const total of [83, 91, 97, 101, 109, 137]) {
      const scaled = scaleSegments(COLOUR, total)!;
      expect(scaled.reduce((n, s) => n + s.durationMinutes, 0)).toBe(total);
      expect(scaled[1]!.durationMinutes).toBe(35);
    }
  });

  it('keeps the active parts in proportion', () => {
    // 45:30 is 3:2, so 150 active minutes should split 90:60.
    const scaled = scaleSegments(COLOUR, 185)!;
    expect(scaled.map((s) => s.durationMinutes)).toEqual([90, 35, 60]);
  });

  it('refuses a total that cannot leave every active part at least a minute', () => {
    // 36 leaves one minute for two active segments.
    expect(scaleSegments(COLOUR, 36)).toBeNull();
    expect(scaleSegments(COLOUR, 35)).toBeNull();
    expect(scaleSegments(COLOUR, 37)).not.toBeNull();
  });

  it('scales an unsegmented service to exactly the override', () => {
    expect(scaleSegments([{ durationMinutes: 45, isGap: false }], 60)).toEqual([
      { durationMinutes: 60, isGap: false },
    ]);
  });
});

describe('gapSpans (SEG-03)', () => {
  it('places the colour gap at 45 minutes in, for 35', () => {
    expect(gapSpans(COLOUR)).toEqual([{ offsetMinutes: 45, minutes: 35 }]);
  });

  it('offsets accumulate over gaps too, so a second gap is not drawn early', () => {
    const twoGaps: Segment[] = [
      { durationMinutes: 20, isGap: false },
      { durationMinutes: 30, isGap: true },
      { durationMinutes: 10, isGap: false },
      { durationMinutes: 25, isGap: true },
      { durationMinutes: 15, isGap: false },
    ];
    expect(gapSpans(twoGaps)).toEqual([
      { offsetMinutes: 20, minutes: 30 },
      // 20 + 30 + 10 — walking only the active segments would say 30.
      { offsetMinutes: 60, minutes: 25 },
    ]);
  });

  it('is empty for an unsegmented service', () => {
    expect(gapSpans([{ durationMinutes: 45, isGap: false }])).toEqual([]);
  });
});

describe('visitGapSpans (SEG-03 across a VISIT-01 visit)', () => {
  const line = (durationMinutes: number, segments: Segment[] = [], serviceDurationMinutes = durationMinutes) => ({
    durationMinutes,
    serviceDurationMinutes,
    segments,
  });

  it('places a single colour gap from the start of the body', () => {
    expect(visitGapSpans([line(110, COLOUR)])).toEqual([{ offsetMinutes: 45, minutes: 35 }]);
  });

  it('offsets the second line by the FIRST line, not by its own segments', () => {
    // Cut (30, unsegmented) then colour. The gap is 30 + 45 in, not 45.
    expect(visitGapSpans([line(30), line(110, COLOUR)])).toEqual([{ offsetMinutes: 75, minutes: 35 }]);
  });

  it('an unsegmented visit has no gaps at all', () => {
    expect(visitGapSpans([line(45), line(30)])).toEqual([]);
  });

  it('re-times each line to its own snapshot, holding the gap fixed', () => {
    // A quicker colourist: the 110-minute service was booked as 95, so the
    // active parts shrank and the 35 developing minutes did not.
    const spans = visitGapSpans([line(95, COLOUR, 110)]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.minutes).toBe(35);
    // 45 scaled against 60 target active minutes = 36.
    expect(spans[0]!.offsetMinutes).toBe(36);
  });

  it('drops a line whose snapshot no longer fits its segments, rather than throwing', () => {
    // Booked at 30 minutes, then someone gave the service a 35-minute gap.
    expect(visitGapSpans([line(30, COLOUR, 110)])).toEqual([]);
  });
});
