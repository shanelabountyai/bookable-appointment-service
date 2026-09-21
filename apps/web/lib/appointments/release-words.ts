import type { ReleasePieces } from '@bookable/db/appointments';
import { type ZoneId, fromDate, toLabel } from '@bookable/core/time';

/**
 * A-131 — ONE SENTENCE FOR A RELEASE, before the press and after it.
 *
 * Names every free piece, because a segmented service's time comes back in
 * pieces around whatever was sold into its processing gap, and says which ONE
 * is on What's opened up (D-60(3) lists one row per freed range) — or that
 * none is (too short for A-109's floor, sold, or past). "It is on What's opened up" is only said when it
 * is true of all of it.
 */
export function releaseWords(release: ReleasePieces, zone: string, when: 'before' | 'after'): string {
  const time = (at: Date) => toLabel(fromDate(at), zone as ZoneId).time;
  const range = (piece: { start: Date; end: Date }) => `${time(piece.start)}–${time(piece.end)}`;
  const ranges = release.pieces.map(range);
  const where = ranges.length > 1 ? `${ranges.slice(0, -1).join(', ')} and ${ranges.at(-1)}` : (ranges[0] ?? '');
  const verb = when === 'after' ? 'is' : 'goes';

  const { listed } = release;
  const listing =
    listed === null
      ? "None of it is on What's opened up."
      : ranges.length === 1 && range(listed) === ranges[0]
        ? `It ${verb} on What's opened up.`
        : `${range(listed)} ${verb} on What's opened up.`;
  return when === 'after'
    ? `${release.minutes} min back on the market: ${where}. ${listing}`
    : `Giving it back frees ${where}. ${listing}`;
}
