import { describe, expect, it } from 'vitest';
import { calendarDay, wallTime } from '../time';
import { DAY_PART_TAGS, matchesDayParts, tagsFor } from './day-parts';

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
