/**
 * A-025 — business policy validation. Pure: no database, no clock.
 *
 * The centrepiece is the D-11/D-19 trap (operator review R-3): the pair that
 * traps a client is only visible when the business lead time and EVERY active
 * service's cutoff override are looked at together.
 */
import { describe, expect, it } from 'vitest';
import {
  type BusinessPolicy,
  type ServiceCutoff,
  formatMinutes,
  validateBusinessPolicy,
  validateServiceCutoff,
  worstCutoff,
} from './policy';

const policy = (over: Partial<BusinessPolicy> = {}): BusinessPolicy => ({
  slotIntervalMinutes: 15,
  minimumLeadMinutes: 120,
  cancellationCutoffMinutes: 120,
  noShowBlockThreshold: 3,
  bookingHorizonDays: 90,
  bufferMayOverlapBreak: true,
  bufferMayExtendPastClose: true,
  ambiguousLocalTime: 'offer-both',
  ...over,
});

const service = (name: string, cutoff: number | null): ServiceCutoff => ({
  id: name.toLowerCase(),
  name,
  cancellationCutoffMinutes: cutoff,
});

describe('validateBusinessPolicy — well-formedness', () => {
  it('accepts the defaults', () => {
    expect(validateBusinessPolicy(policy())).toEqual([]);
  });

  it.each([
    ['slotIntervalMinutes', { slotIntervalMinutes: 0 }],
    ['slotIntervalMinutes', { slotIntervalMinutes: 7.5 }],
    ['minimumLeadMinutes', { minimumLeadMinutes: -1 }],
    ['cancellationCutoffMinutes', { cancellationCutoffMinutes: -30 }],
    ['noShowBlockThreshold', { noShowBlockThreshold: -1 }],
    ['bookingHorizonDays', { bookingHorizonDays: 0 }],
    ['ambiguousLocalTime', { ambiguousLocalTime: 'whatever' as never }],
  ])('rejects a bad %s', (field, over) => {
    const violations = validateBusinessPolicy(policy(over));
    expect(violations.map((v) => v.field)).toContain(field);
  });

  it('allows a zero cutoff and zero lead together — "cancel any time" is a real policy', () => {
    expect(validateBusinessPolicy(policy({ minimumLeadMinutes: 0, cancellationCutoffMinutes: 0 }))).toEqual([]);
  });
});

describe('the D-11 trap: lead time shorter than a cutoff (operator R-3)', () => {
  it('refuses a business cutoff longer than the lead time', () => {
    const violations = validateBusinessPolicy(policy({ minimumLeadMinutes: 60, cancellationCutoffMinutes: 120 }));
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('already unable to cancel');
  });

  // The exact scenario the operator described: both settings individually
  // reasonable, the combination traps the client.
  it('refuses a SERVICE cutoff longer than the lead time, even when the business pair is fine', () => {
    const violations = validateBusinessPolicy(policy({ minimumLeadMinutes: 120, cancellationCutoffMinutes: 120 }), [
      service('Cut', null),
      service('Colour', 24 * 60), // 24h cutoff — entirely reasonable on its own
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('Colour');
    expect(violations[0]!.message).toContain('24 hours');
    expect(violations[0]!.message).toContain('2 hours');
  });

  it('accepts once the lead time covers the longest service cutoff', () => {
    expect(
      validateBusinessPolicy(policy({ minimumLeadMinutes: 24 * 60, cancellationCutoffMinutes: 120 }), [
        service('Colour', 24 * 60),
      ]),
    ).toEqual([]);
  });

  it('ignores services that inherit (null), and inactive ones are never passed in', () => {
    expect(
      validateBusinessPolicy(policy({ minimumLeadMinutes: 120, cancellationCutoffMinutes: 120 }), [
        service('Cut', null),
        service('Blow-dry', null),
      ]),
    ).toEqual([]);
  });

  it('names the WORST offender when several services exceed the lead time', () => {
    const violations = validateBusinessPolicy(policy({ minimumLeadMinutes: 60 }), [
      service('Colour', 12 * 60),
      service('Balayage', 48 * 60),
      service('Cut', 2 * 60),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('Balayage');
    expect(violations[0]!.message).toContain('48 hours');
  });

  it('does not pile a coupling error on top of a malformed value', () => {
    const violations = validateBusinessPolicy(policy({ minimumLeadMinutes: -5, cancellationCutoffMinutes: 120 }));
    expect(violations).toHaveLength(1);
    expect(violations[0]!.field).toBe('minimumLeadMinutes');
  });
});

describe('worstCutoff', () => {
  it('returns the business cutoff when no service overrides it', () => {
    expect(worstCutoff(120, [service('Cut', null)])).toEqual({ minutes: 120, source: 'business' });
  });

  it('returns the longest service override when one exceeds the business cutoff', () => {
    expect(worstCutoff(120, [service('Colour', 1440)])).toEqual({
      minutes: 1440,
      source: 'service',
      serviceName: 'Colour',
    });
  });

  it('keeps the business value when every override is shorter', () => {
    expect(worstCutoff(120, [service('Cut', 30)])).toEqual({ minutes: 120, source: 'business' });
  });
});

describe('validateServiceCutoff — the other write path', () => {
  it('accepts an inherited cutoff', () => {
    expect(validateServiceCutoff(service('Cut', null), { minimumLeadMinutes: 120, cancellationCutoffMinutes: 120 })).toEqual([]);
  });

  it('accepts a cutoff within the lead time', () => {
    expect(validateServiceCutoff(service('Cut', 60), { minimumLeadMinutes: 120, cancellationCutoffMinutes: 120 })).toEqual([]);
  });

  // Saving a service must not be able to create the trap either — this is the
  // half that "startup validation" (D-11 as originally written) would miss.
  it('refuses a service cutoff that exceeds the lead time', () => {
    const violations = validateServiceCutoff(service('Colour', 24 * 60), {
      minimumLeadMinutes: 120,
      cancellationCutoffMinutes: 120,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.field).toBe('cancellationCutoffMinutes');
    expect(violations[0]!.message).toContain('Colour');
  });

  it('rejects a malformed cutoff', () => {
    expect(
      validateServiceCutoff(service('Cut', 12.5), { minimumLeadMinutes: 120, cancellationCutoffMinutes: 120 }),
    ).toHaveLength(1);
  });
});

describe('formatMinutes — owner-facing, not log-facing', () => {
  it.each([
    [0, 'none'],
    [45, '45 minutes'],
    [60, '1 hour'],
    [120, '2 hours'],
    [1440, '24 hours'], // the trade says "24 hours notice", never "1 day"
    [2880, '48 hours'],
    [4320, '3 days'], // days only once hours stop being how anyone says it
    [10080, '7 days'],
    [90, '90 minutes'],
  ])('%i -> %s', (minutes, expected) => {
    expect(formatMinutes(minutes)).toBe(expected);
  });
});
