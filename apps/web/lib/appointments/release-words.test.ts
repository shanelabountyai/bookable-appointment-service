/** A-131 — the release sentence names every piece and never claims a listing that is not there. */
import { describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '@bookable/core/time';
import { releaseWords } from './release-words';

const t = (hhmm: string) => toDate(instantFromIso(`2026-06-09T${hhmm}:00-05:00`));
const piece = (a: string, b: string, minutes: number) => ({ start: t(a), end: t(b), minutes });
const ZONE = 'America/Chicago';

describe('releaseWords', () => {
  it('names both pieces of a segmented release and the one that is listed', () => {
    const early = piece('13:35', '14:15', 40);
    const late = piece('14:30', '15:35', 65);
    expect(releaseWords({ pieces: [early, late], minutes: 105, listed: late }, ZONE, 'after')).toBe(
      "105 min back on the market: 13:35–14:15 and 14:30–15:35. 14:30–15:35 is on What's opened up.",
    );
  });

  it('never says "is on What\'s opened up" when nothing is long enough to list', () => {
    const words = releaseWords({ pieces: [piece('11:00', '11:50', 50)], minutes: 50, listed: null }, ZONE, 'before');
    expect(words).not.toMatch(/(It|–\d\d:\d\d) (is|goes) on What's opened up/);
    expect(words).toBe("Giving it back frees 11:00–11:50. None of it is on What's opened up.");
  });

  it('says "it" only when the one piece is the listed one', () => {
    const whole = piece('10:20', '11:50', 90);
    expect(releaseWords({ pieces: [whole], minutes: 90, listed: whole }, ZONE, 'after')).toBe(
      "90 min back on the market: 10:20–11:50. It is on What's opened up.",
    );
  });
});
