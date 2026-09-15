import { describe, expect, it } from 'vitest';
import { calendarDay, wallTime } from '../time';
import { DAY_PART_TAGS, dayPartWords, matchesDayParts, tagsFor } from './day-parts';

describe('tagsFor', () => {
  it('tags a Saturday morning', () => {
    // 2026-08-22 is a Saturday.
    expect(tagsFor(calendarDay('2026-08-22'), wallTime('09:00'))).toEqual(['saturday', 'morning']);
  });

  it('tags noon as afternoon, and 17:00 sharp as evening', () => {
    const day = calendarDay('2026-08-18'); // Tuesday
    expect(tagsFor(day, wallTime('12:00'))).toEqual(['tuesday', 'afternoon']);
    expect(tagsFor(day, wallTime('17:00'))).toEqual(['tuesday', 'evening']);
  });

  it('every tag it can produce is in the closed vocabulary', () => {
    for (const time of ['00:00', '11:59', '12:00', '16:59', '17:00', '23:59']) {
      for (const tag of tagsFor(calendarDay('2026-08-22'), wallTime(time))) {
        expect(DAY_PART_TAGS).toContain(tag);
      }
    }
  });
});

describe('matchesDayParts', () => {
  it('no preference matches anything', () => {
    expect(matchesDayParts([], ['tuesday', 'evening'])).toBe(true);
  });

  it('requires every wanted tag present — a conjunction, not an either/or', () => {
    expect(matchesDayParts(['saturday', 'morning'], ['saturday', 'morning'])).toBe(true);
    expect(matchesDayParts(['saturday', 'morning'], ['saturday', 'afternoon'])).toBe(false);
    expect(matchesDayParts(['saturday', 'morning'], ['sunday', 'morning'])).toBe(false);
  });
});

/**
 * A-119 ride-along — the standing queue's words.
 *
 * The queue printed the stored cell (`· saturday, morning`), which is a
 * database row rather than something anybody at a desk says. The conjunction
 * `matchesDayParts` enforces is what the wording has to carry: "Saturday
 * mornings" is ONE preference.
 */
describe('dayPartWords', () => {
  it('attaches the band to the day, because that is the conjunction', () => {
    expect(dayPartWords(['saturday', 'morning'])).toBe('Saturday mornings');
  });

  it('pluralises a bare weekday, and reads the same however the cell is ordered', () => {
    expect(dayPartWords(['tuesday'])).toBe('Tuesdays');
    expect(dayPartWords(['morning', 'saturday'])).toBe('Saturday mornings');
  });

  it('says "no preference" out loud rather than rendering nothing', () => {
    // The raw join printed an empty string here, which on screen is
    // indistinguishable from a field that failed to load.
    expect(dayPartWords([])).toBe('Any day, any time');
    expect(dayPartWords(['afternoon'])).toBe('Any day, afternoons');
  });

  it('joins several of a kind with "or", the way the desk would say it', () => {
    expect(dayPartWords(['saturday', 'friday'])).toBe('Fridays or Saturdays');
    expect(dayPartWords(['friday', 'morning', 'afternoon'])).toBe('Friday mornings or afternoons');
  });
});
