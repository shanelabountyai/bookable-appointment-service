/**
 * A-049 — the series rule, on the calendar axis.
 *
 * Every fixture is a FROZEN rule against a FROZEN zone. Nothing here reads the
 * clock, so the DST cases exist in March and in July alike — the failure mode
 * the seed's fixed anchor exists to prevent (CLAUDE.md), applied to the module
 * that generates the dates rather than to the one that seeds them.
 *
 * The DST instants come from `docs/reviews/03-slot-engine-spec.md` §3 and are
 * not re-derived here.
 */
import { describe, expect, it } from 'vitest';
import { InvalidSeries, bookableInstant, planOccurrences } from './series';
import { type Instant, calendarDay, instantFromIso, toLabel, wallTime, weekdayOf, zoneId } from '../time';

const CHICAGO = zoneId('America/Chicago');

/** The wall time an instant lands on, in the salon's zone. */
const wallOf = (at: Instant) => toLabel(at, CHICAGO).time;
const rule = (over: Partial<Parameters<typeof planOccurrences>[0]> = {}) => ({
  anchorDay: calendarDay('2026-06-09'),
  time: wallTime('14:00'),
  intervalWeeks: 4,
  count: 3,
  ...over,
});

describe('planOccurrences — the calendar arithmetic', () => {
  it('counts the anchor as the first appointment, not as one before them', () => {
    const planned = planOccurrences(rule({ count: 3 }), CHICAGO);
    expect(planned).toHaveLength(3);
    expect(planned.map((o) => o.day)).toEqual(['2026-06-09', '2026-07-07', '2026-08-04']);
  });

  it('repeats weekly, fortnightly and four-weekly from the same anchor', () => {
    const days = (intervalWeeks: number) =>
      planOccurrences(rule({ intervalWeeks, count: 3 }), CHICAGO).map((o) => o.day);
    expect(days(1)).toEqual(['2026-06-09', '2026-06-16', '2026-06-23']);
    expect(days(2)).toEqual(['2026-06-09', '2026-06-23', '2026-07-07']);
    expect(days(4)).toEqual(['2026-06-09', '2026-07-07', '2026-08-04']);
  });

  it('keeps the weekday, which is the whole point of a standing appointment', () => {
    // Tuesday, every time — a client who comes on Tuesdays does not want the
    // fourth one landing on a Wednesday because a month is not 28 days.
    const planned = planOccurrences(rule({ count: 6, intervalWeeks: 4 }), CHICAGO);
    // Through the one conversion module — `new Date('2026-06-09')` is the
    // exact axis-crossing this repo bans, and it would be banned in a test for
    // the same reason it is banned in the engine.
    for (const occurrence of planned) {
      expect(weekdayOf(occurrence.day)).toBe(2);
    }
  });

  it('refuses a nonsense rule at the field that caused it', () => {
    expect(() => planOccurrences(rule({ intervalWeeks: 0 }), CHICAGO)).toThrow(InvalidSeries);
    expect(() => planOccurrences(rule({ count: 0 }), CHICAGO)).toThrow(InvalidSeries);
    const tooMany = planOccurrences.bind(null, rule({ count: 105 }), CHICAGO);
    expect(tooMany).toThrow(InvalidSeries);
    expect(() => planOccurrences(rule({ count: 104 }), CHICAGO)).not.toThrow();
  });
});

/**
 * THE REASON THIS MODULE IS NOT A ONE-LINE `addDays`.
 *
 * A standing appointment is the one ordinary feature in this product that
 * meets all three arms of `resolve()` in a real book: repeat anything for long
 * enough and it eventually lands on a day where its wall time does not exist,
 * or happens twice.
 */
describe('the DST weeks a standing appointment eventually hits', () => {
  it('WALL TIME is preserved across spring-forward, not the physical offset', () => {
    // 2026-03-08 is spring-forward in Chicago. A fortnightly 14:00 that spans
    // it must still be 14:00 on the wall the following fortnight — an
    // instant-plus-28-days rule would say 15:00 and tell the client so.
    const planned = planOccurrences(
      { anchorDay: calendarDay('2026-03-03'), time: wallTime('14:00'), intervalWeeks: 1, count: 2 },
      CHICAGO,
    );
    expect(planned.map((o) => o.day)).toEqual(['2026-03-03', '2026-03-10']);
    expect(planned.every((o) => o.kind === 'unique')).toBe(true);

    const [before, after] = planned as unknown as [{ at: Instant }, { at: Instant }];
    // Both are 14:00 local...
    expect(wallOf(before.at)).toBe('14:00');
    expect(wallOf(after.at)).toBe('14:00');
    // ...and therefore 167 hours apart in PHYSICAL time, not 168. A rule that
    // added seven times twenty-four hours would land an hour late, and the
    // client would be told 15:00. That one hour is the whole bug.
    expect(after.at - before.at).toBe((7 * 24 - 1) * 60 * 60 * 1000);
  });

  it('reports the week where the time does not exist, and refuses to invent one', () => {
    // 02:30 on 2026-03-08 names no instant (spec Fact 2).
    const planned = planOccurrences(
      { anchorDay: calendarDay('2026-03-01'), time: wallTime('02:30'), intervalWeeks: 1, count: 2 },
      CHICAGO,
    );
    expect(planned[0]!.kind).toBe('unique');

    const skipped = planned[1]!;
    expect(skipped.kind).toBe('gap');
    expect(skipped.day).toBe('2026-03-08');
    // No instant is offered for it — the caller must look at `kind`. Coercing
    // to "the nearest real time" is the defect spec DST-8 names.
    expect(bookableInstant(skipped)).toBeNull();
  });

  it('reports the week where the time happens twice, and takes the earlier one', () => {
    // 01:30 on 2026-11-01 names two instants, an hour apart (spec Fact 2).
    const planned = planOccurrences(
      { anchorDay: calendarDay('2026-10-25'), time: wallTime('01:30'), intervalWeeks: 1, count: 2 },
      CHICAGO,
    );
    const doubled = planned[1]!;
    expect(doubled.kind).toBe('ambiguous');
    expect(doubled.day).toBe('2026-11-01');

    // Both are real and bookable — collapsing them would destroy an hour of
    // the salon's capacity (spec FB-1/FB-4).
    const both = doubled as { earlier: Instant; later: Instant };
    expect(both.later - both.earlier).toBe(60 * 60 * 1000);
    // The chosen side is the EARLIER, reusing `ambiguousLocalTime`'s existing
    // `offer-earlier-only` policy rather than inventing a new rule.
    expect(bookableInstant(doubled)).toBe(both.earlier);
  });

  it('a fortnightly series spanning BOTH transitions keeps its wall time throughout', () => {
    // Anchored before spring-forward and long enough to cross fall-back too.
    const planned = planOccurrences(
      { anchorDay: calendarDay('2026-03-03'), time: wallTime('09:15'), intervalWeeks: 4, count: 10 },
      CHICAGO,
    );
    expect(planned).toHaveLength(10);
    // 09:15 is nowhere near either transition, so every week resolves — and
    // every one of them is 09:15 on the wall, which an instant-offset rule
    // could not manage across two clock changes in opposite directions.
    for (const occurrence of planned) {
      expect(occurrence.kind).toBe('unique');
      expect(wallOf((occurrence as { at: Instant }).at)).toBe('09:15');
    }
    // And it really did cross both.
    expect(planned.some((o) => o.day < '2026-03-08')).toBe(true);
    expect(planned.some((o) => o.day > '2026-11-01')).toBe(true);
  });
});

describe('bookableInstant', () => {
  it('is the instant itself for an ordinary week', () => {
    const planned = planOccurrences(rule({ count: 1 }), CHICAGO);
    expect(bookableInstant(planned[0]!)).toBe(instantFromIso('2026-06-09T14:00:00-05:00'));
  });
});
