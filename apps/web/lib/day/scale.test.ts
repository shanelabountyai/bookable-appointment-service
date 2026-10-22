import { describe, expect, it } from 'vitest';
import { PX_PER_MINUTE, bookHrefAt, clickedStartMs } from './scale';

const MIN = 60_000;
// 2026-03-08 is spring-forward in America/Chicago: 08:00Z is 02:00 CST, which
// does not exist, and 08:00Z is the instant the wall jumps to 03:00 CDT
// (spec §3). A gap from 07:40Z (01:40 CST) for 80 minutes runs to 09:00Z (04:00 CDT).
const GAP_START = Date.UTC(2026, 2, 8, 7, 40);

describe('clickedStartMs (A-162)', () => {
  it('a click at the very top books the gap start, not the quarter before it', () => {
    expect(clickedStartMs(GAP_START, 80, 0)).toBe(GAP_START);
    expect(clickedStartMs(GAP_START, 80, 4 * PX_PER_MINUTE)).toBe(GAP_START);
  });

  it('snaps DOWN to the quarter hour under the pointer, on the physical axis across the DST jump', () => {
    // 22 physical minutes in = 08:02Z = 03:02 CDT → 08:00Z, 03:00 CDT.
    expect(clickedStartMs(GAP_START, 80, 22 * PX_PER_MINUTE)).toBe(Date.UTC(2026, 2, 8, 8, 0));
    // 50 minutes in = 08:30Z → 08:30Z.
    expect(clickedStartMs(GAP_START, 80, 50 * PX_PER_MINUTE)).toBe(Date.UTC(2026, 2, 8, 8, 30));
  });

  it('a click below the gap (the chip is drawn taller than a short gap) stays inside it', () => {
    expect(clickedStartMs(GAP_START, 80, 500 * PX_PER_MINUTE)).toBe(Date.UTC(2026, 2, 8, 8, 45));
    // 07:50Z–08:00Z has no quarter inside it: the start is the only answer.
    const short = Date.UTC(2026, 2, 8, 7, 50);
    expect(clickedStartMs(short, 10, 9 * PX_PER_MINUTE)).toBe(short);
    expect(clickedStartMs(GAP_START, 80, -5)).toBe(GAP_START);
  });

  it('the gap end is exclusive: a quarter that starts exactly at the end is not offered', () => {
    const start = Date.UTC(2026, 2, 10, 15, 0);
    expect(clickedStartMs(start, 60, 60 * PX_PER_MINUTE)).toBe(start + 45 * MIN);
  });
});

describe('bookHrefAt', () => {
  it('replaces only `at`, keeping provider and day', () => {
    const href = `/staff/book?provider=p1&at=${encodeURIComponent('2026-03-10T15:00:00.000Z')}&day=2026-03-10`;
    const out = bookHrefAt(href, Date.UTC(2026, 2, 10, 16, 30));
    const params = new URLSearchParams(out.split('?')[1]);
    expect(out.startsWith('/staff/book?')).toBe(true);
    expect(params.get('provider')).toBe('p1');
    expect(params.get('day')).toBe('2026-03-10');
    expect(params.get('at')).toBe('2026-03-10T16:30:00.000Z');
  });
});
