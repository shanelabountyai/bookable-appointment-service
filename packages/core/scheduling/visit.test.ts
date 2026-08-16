import { describe, expect, it } from 'vitest';
import { InvalidVisit, type VisitLine, composeVisit, isSingleService } from './visit';

const line = (over: Partial<VisitLine> = {}): VisitLine => ({
  serviceId: 'svc',
  durationMinutes: 45,
  bufferBeforeMinutes: 5,
  bufferAfterMinutes: 10,
  priceCents: 5500,
  ...over,
});

describe('composeVisit (VISIT-01, D-23)', () => {
  it('is the identity for a single service', () => {
    expect(composeVisit([line()])).toEqual({
      durationMinutes: 45,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 10,
      totalPriceCents: 5500,
    });
  });

  /**
   * The rule this module exists for. Cut (45min, 0 before / 10 after) then
   * colour (120min, 15 before / 20 after):
   *
   *   duration = 45 + 120 = 165        — NOT 165 + the inner buffers
   *   before   = 0                     — the CUT's, because it goes first
   *   after    = 20                    — the COLOUR's, because it goes last
   *
   * Stacking the inner buffers would add 25 minutes of dead time to every
   * cut+colour, and the salon would wonder why its book stopped fitting.
   */
  it('sums durations but does NOT stack the buffers between lines', () => {
    const cut = line({ serviceId: 'cut', durationMinutes: 45, bufferBeforeMinutes: 0, bufferAfterMinutes: 10, priceCents: 5500 });
    const colour = line({ serviceId: 'colour', durationMinutes: 120, bufferBeforeMinutes: 15, bufferAfterMinutes: 20, priceCents: 14000 });

    expect(composeVisit([cut, colour])).toEqual({
      durationMinutes: 165,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 20,
      totalPriceCents: 19500,
    });
  });

  it('takes the buffers from the ends, so ORDER changes the blocked range', () => {
    const cut = line({ serviceId: 'cut', durationMinutes: 45, bufferBeforeMinutes: 0, bufferAfterMinutes: 10, priceCents: 5500 });
    const colour = line({ serviceId: 'colour', durationMinutes: 120, bufferBeforeMinutes: 15, bufferAfterMinutes: 20, priceCents: 14000 });

    const cutFirst = composeVisit([cut, colour]);
    const colourFirst = composeVisit([colour, cut]);

    // Same total time with the client, different protection either side.
    expect(cutFirst.durationMinutes).toBe(colourFirst.durationMinutes);
    expect(cutFirst.bufferBeforeMinutes).toBe(0);
    expect(cutFirst.bufferAfterMinutes).toBe(20);
    expect(colourFirst.bufferBeforeMinutes).toBe(15);
    expect(colourFirst.bufferAfterMinutes).toBe(10);
  });

  it('handles three services, taking only the outermost buffers', () => {
    const a = line({ serviceId: 'a', durationMinutes: 30, bufferBeforeMinutes: 5, bufferAfterMinutes: 99, priceCents: 1000 });
    const b = line({ serviceId: 'b', durationMinutes: 20, bufferBeforeMinutes: 99, bufferAfterMinutes: 99, priceCents: 2000 });
    const c = line({ serviceId: 'c', durationMinutes: 10, bufferBeforeMinutes: 99, bufferAfterMinutes: 7, priceCents: 3000 });

    expect(composeVisit([a, b, c])).toEqual({
      durationMinutes: 60,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 7,
      totalPriceCents: 6000,
    });
  });

  it('sums the price across lines', () => {
    expect(composeVisit([line({ priceCents: 5500 }), line({ priceCents: 14000 })]).totalPriceCents).toBe(19500);
  });

  it('refuses an empty visit', () => {
    expect(() => composeVisit([])).toThrow(InvalidVisit);
  });

  it('refuses a line with a non-positive duration', () => {
    expect(() => composeVisit([line({ durationMinutes: 0 })])).toThrow(InvalidVisit);
    expect(() => composeVisit([line(), line({ durationMinutes: -30 })])).toThrow(InvalidVisit);
  });

  it('composes at the PROVIDER-resolved durations it is given (SVC-02)', () => {
    // The caller resolves overrides first; a junior stylist's longer cut
    // composes at her duration, not the catalogue's.
    const juniorCut = line({ serviceId: 'cut', durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 10 });
    expect(composeVisit([juniorCut]).durationMinutes).toBe(60);
  });
});

describe('isSingleService', () => {
  it('distinguishes the ordinary case', () => {
    expect(isSingleService([line()])).toBe(true);
    expect(isSingleService([line(), line()])).toBe(false);
  });
});
