/**
 * Segmented durations (SEG-01, SEG-02, D-12). Pure: no database, no clock.
 *
 * A service's body is an ordered list of segments. `isGap` marks a stretch the
 * CLIENT occupies but the PROVIDER does not — colour developing, a perm
 * setting. In A-029 nothing consumes that distinction for booking: the engine
 * and the exclusion constraint still see one continuous footprint, and the gap
 * is rendered so the desk can see it and book it by hand. A-030 makes the
 * engine offer it, which is a constraint migration (OQ-7) and deliberately not
 * this item.
 *
 * A service with no segment rows has exactly one implicit segment — its whole
 * duration, active. That is what makes this additive rather than a backfill:
 * every service built before A-029 is already correct.
 */
import type { PolicyViolation } from './policy';

export interface Segment {
  readonly durationMinutes: number;
  readonly isGap: boolean;
}

/** The one implicit segment of an unsegmented service. Never stored. */
export function segmentsOrWhole(segments: readonly Segment[], durationMinutes: number): readonly Segment[] {
  return segments.length > 0 ? segments : [{ durationMinutes, isGap: false }];
}

export const sumMinutes = (segments: readonly Segment[]): number =>
  segments.reduce((total, s) => total + s.durationMinutes, 0);

/**
 * The rules a segment list has to satisfy on its own terms, whatever it adds
 * up to. Split from the sum check because `replaceSegments` (A-029) SETS the
 * service duration from the parts — checking the proposed list against the old
 * total there would deadlock a segmented service, which could then never have
 * its length changed at all.
 */
export function validateSegmentStructure(segments: readonly Segment[]): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const bad = (message: string) => violations.push({ field: 'segments', message });

  // Zero rows is legal and means "unsegmented" — the caller deletes the rows.
  if (segments.length === 0) return violations;

  if (segments.length === 1) {
    bad('A segmented service needs at least two parts. Remove the segments to go back to one duration.');
  }
  if (segments.some((s) => !Number.isInteger(s.durationMinutes) || s.durationMinutes <= 0)) {
    bad('Every part must be a whole number of minutes above zero.');
  }
  // A gap at either end is not a gap, it is a buffer or nothing: a service
  // that STARTS with provider-free time starts later, and one that ENDS with
  // it has the client sitting in a chair the provider has already left. Both
  // belong in the service's buffers, which already exist and which the
  // constraint already ranges over.
  if (segments[0]!.isGap || segments[segments.length - 1]!.isGap) {
    bad('A service cannot start or end with a gap — that time belongs in the buffers.');
  }
  if (segments.some((s, i) => i > 0 && s.isGap && segments[i - 1]!.isGap)) {
    bad('Two gaps in a row are one gap. Merge them.');
  }
  return violations;
}

/**
 * The full invariant: structure, plus the parts summing to the service's own
 * `durationMinutes` (SEG-01).
 *
 * The sum rule is the load-bearing one. `Appointment.blockedStart/blockedEnd`
 * — the range the exclusion constraint actually enforces — is derived from
 * `durationMinutes`, so segments that did not add up would draw a stripe in a
 * place the database is not defending. `replaceSegments` keeps it true by
 * construction (it writes both in one transaction); this function is how a
 * test, a seed, or a later consistency check ASSERTS it, which is the half
 * that catches a row written any other way.
 *
 * Not a trigger, because in A-029 a drifted sum is a display defect. It becomes
 * a correctness one at A-030, where the engine reads these rows.
 * ponytail: validation + assertion test, upgrade to a trigger when the engine consumes it.
 */
export function validateSegments(segments: readonly Segment[], durationMinutes: number): PolicyViolation[] {
  const violations = validateSegmentStructure(segments);
  if (segments.length === 0 || violations.length > 0) return violations;

  const total = sumMinutes(segments);
  if (total !== durationMinutes) {
    violations.push({
      field: 'segments',
      message: `The parts add up to ${total} minutes but the service is ${durationMinutes}. They have to match.`,
    });
  }
  return violations;
}

/**
 * Re-times a segment list to a provider's effective duration (SEG-02).
 *
 * GAPS NEVER SCALE. Colour develops for 35 minutes regardless of who mixed it,
 * so applying a stylist's speed to chemistry would silently mis-time every
 * segmented booking — the gap would move, and the free minutes the desk can
 * see would not be the free minutes that exist. Only active segments absorb
 * the difference, proportionally, with the rounding remainder landing on the
 * last one so the total is exact.
 *
 * Returns null when the target cannot be met with every active segment at one
 * minute or more — the caller refuses the override at save time rather than
 * discovering it at booking time.
 */
export function scaleSegments(segments: readonly Segment[], totalMinutes: number): Segment[] | null {
  const gapTotal = sumMinutes(segments.filter((s) => s.isGap));
  const activeTotal = sumMinutes(segments.filter((s) => !s.isGap));
  const target = totalMinutes - gapTotal;
  const activeCount = segments.length - segments.filter((s) => s.isGap).length;
  if (activeTotal <= 0 || target < activeCount) return null;

  const lastActive = segments.reduce((last, s, i) => (s.isGap ? last : i), -1);
  let assigned = 0;
  const scaled = segments.map((s, i) => {
    if (s.isGap) return s;
    // The last active segment takes whatever is left, so rounding cannot make
    // the parts disagree with the total the constraint is enforcing.
    const minutes =
      i === lastActive ? target - assigned : Math.max(1, Math.round((s.durationMinutes * target) / activeTotal));
    assigned += minutes;
    return { durationMinutes: minutes, isGap: false };
  });
  return scaled.some((s) => s.durationMinutes <= 0) ? null : scaled;
}

export interface SegmentSpan {
  /** Minutes from the start of the BODY — never from `blockedStart`. Buffers
   *  are not part of the segment sequence (SEG-01). */
  readonly offsetMinutes: number;
  readonly minutes: number;
}

/**
 * Where the gaps sit inside a segment sequence, for rendering (SEG-03).
 *
 * Offsets accumulate over EVERY segment, gaps included — walking only the
 * active ones is the obvious way to draw the second stripe in the wrong place.
 */
export function gapSpans(segments: readonly Segment[]): SegmentSpan[] {
  const spans: SegmentSpan[] = [];
  let offset = 0;
  for (const segment of segments) {
    if (segment.isGap) spans.push({ offsetMinutes: offset, minutes: segment.durationMinutes });
    offset += segment.durationMinutes;
  }
  return spans;
}

export interface SegmentedLine {
  /** The D-18 snapshot: what this line's duration actually IS on this
   *  appointment, already carrying any provider override. */
  readonly durationMinutes: number;
  /** The service's current duration, only so an unsegmented service's one
   *  implicit segment has a length. */
  readonly serviceDurationMinutes: number;
  readonly segments: readonly Segment[];
}

/**
 * The gaps inside a whole visit, offset from the start of its BODY (SEG-03).
 *
 * A visit is several lines in order (VISIT-01), so the offsets accumulate
 * across lines as well as within one, and each line's segments are re-timed to
 * that line's snapshotted duration — a provider who is quicker at colour has a
 * shorter first part and the SAME developing gap.
 *
 * A line whose snapshot cannot be met with these segments contributes no gaps
 * rather than throwing: the segments may have been edited since the booking was
 * taken, and a stripe this function cannot place is not worth a broken day
 * grid. Nothing about correctness rides on it in A-029 — the database is still
 * defending the whole footprint.
 */
export function visitGapSpans(lines: readonly SegmentedLine[]): SegmentSpan[] {
  const spans: SegmentSpan[] = [];
  let offset = 0;
  for (const line of lines) {
    const scaled = scaleSegments(segmentsOrWhole(line.segments, line.serviceDurationMinutes), line.durationMinutes);
    if (scaled) {
      for (const span of gapSpans(scaled)) {
        spans.push({ offsetMinutes: offset + span.offsetMinutes, minutes: span.minutes });
      }
    }
    offset += line.durationMinutes;
  }
  return spans;
}
