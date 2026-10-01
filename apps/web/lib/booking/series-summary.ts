/**
 * A-049's read-back of a standing appointment, shared since A-152: creating a
 * series and extending one (C11) are the same partial booking, so the desk
 * reads the same list for both — every week, booked or not, with the reason.
 */
import type { CreateSeriesResult, SeriesOccurrenceResult, SkipReason } from '@bookable/db/booking';
import { readableDay } from '@/lib/customer-format';
import { readableReason } from '@/lib/scheduling-words';

/** One week of a standing appointment, as the desk reads it back. */
export interface SeriesLine {
  /** "Tuesday 9 June", in the salon's zone. */
  day: string;
  /** Set when that week booked — the desk taps through to it. */
  appointmentId?: string;
  /**
   * Why it did not book, or what was odd about the week it did. Empty on an
   * ordinary occurrence. A SENTENCE, never a code: this list is read at a desk
   * with a client standing at it, and "not-offered" is not an answer.
   */
  note?: string;
}

export interface SeriesSummary {
  booked: number;
  requested: number;
  intervalWeeks: number;
  lines: SeriesLine[];
}

/** The result as the desk reads it: one line per week, in order. */
export function describeSeries(
  result: CreateSeriesResult,
  rule: { requested: number; intervalWeeks: number; time: string },
): SeriesSummary {
  return {
    booked: result.booked,
    requested: rule.requested,
    intervalWeeks: rule.intervalWeeks,
    lines: result.occurrences.map((occurrence) => {
      const note = seriesNote(occurrence, rule.time);
      return {
        day: readableDay(occurrence.day),
        ...(occurrence.appointmentId ? { appointmentId: occurrence.appointmentId } : {}),
        ...(note ? { note } : {}),
      };
    }),
  };
}

/** A week's outcome as a sentence somebody can act on, never a code. */
function seriesNote(occurrence: SeriesOccurrenceResult, time: string): string | null {
  if (occurrence.doubledHour) return `the clocks go back — booked the first ${time}`;
  if (!occurrence.skipped) return null;
  const skipped: SkipReason = occurrence.skipped;
  switch (skipped.kind) {
    case 'no-such-time':
      return `there is no ${time} that day — the clocks go forward`;
    case 'taken':
      return readableReason('overlaps-booking');
    case 'no-chair':
      return readableReason('no-resource-free');
    case 'not-offered':
      // The engine's OWN words, carried through. An empty list means this time
      // was never a candidate at all — outside her hours entirely.
      return skipped.reasons.length > 0
        ? skipped.reasons.map(readableReason).join('; ')
        : readableReason('outside-working-window');
  }
}
