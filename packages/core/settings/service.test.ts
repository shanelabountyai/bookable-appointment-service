import { describe, expect, it } from 'vitest';
import {
  effectiveDurationMinutes,
  effectivePriceCents,
  validateQualificationOverride,
  validateService,
} from './service';

const service = (over: Partial<Parameters<typeof validateService>[0]> = {}) => ({
  name: 'Cut',
  durationMinutes: 45,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  priceCents: 5500,
  ...over,
});

describe('validateService', () => {
  it('accepts a well-formed service', () => {
    expect(validateService(service())).toEqual([]);
  });

  it('accepts a zero price (a complimentary consult)', () => {
    expect(validateService(service({ priceCents: 0 }))).toEqual([]);
  });

  it('accepts zero buffers', () => {
    expect(validateService(service({ bufferBeforeMinutes: 0, bufferAfterMinutes: 0 }))).toEqual([]);
  });

  it.each([
    ['name', { name: '' }],
    ['name', { name: '   ' }],
    ['durationMinutes', { durationMinutes: 0 }],
    ['durationMinutes', { durationMinutes: -30 }],
    ['durationMinutes', { durationMinutes: 45.5 }],
    ['bufferBeforeMinutes', { bufferBeforeMinutes: -5 }],
    ['bufferAfterMinutes', { bufferAfterMinutes: -1 }],
    ['priceCents', { priceCents: -100 }],
    ['priceCents', { priceCents: 55.5 }],
  ])('rejects a bad %s', (field, over) => {
    const violations = validateService(service(over));
    expect(violations.map((v) => v.field)).toContain(field);
  });

  it('trims a name that is only whitespace to nothing and reports it', () => {
    const violations = validateService(service({ name: '  ' }));
    expect(violations).toHaveLength(1);
    expect(violations[0]!.field).toBe('name');
  });
});

describe('validateQualificationOverride', () => {
  it('accepts no overrides (inherit everything)', () => {
    expect(validateQualificationOverride({ durationOverrideMinutes: null, priceOverrideCents: null })).toEqual([]);
  });

  it('accepts a duration-only override', () => {
    expect(validateQualificationOverride({ durationOverrideMinutes: 60, priceOverrideCents: null })).toEqual([]);
  });

  it('accepts a price-only override, including zero', () => {
    expect(validateQualificationOverride({ durationOverrideMinutes: null, priceOverrideCents: 0 })).toEqual([]);
  });

  it('accepts both overrides together', () => {
    expect(validateQualificationOverride({ durationOverrideMinutes: 60, priceOverrideCents: 8000 })).toEqual([]);
  });

  it('rejects a zero or negative duration override — unlike price, zero duration is never valid', () => {
    expect(validateQualificationOverride({ durationOverrideMinutes: 0, priceOverrideCents: null })).toHaveLength(1);
    expect(validateQualificationOverride({ durationOverrideMinutes: -10, priceOverrideCents: null })).toHaveLength(1);
  });

  it('rejects a negative price override', () => {
    expect(validateQualificationOverride({ durationOverrideMinutes: null, priceOverrideCents: -1 })).toHaveLength(1);
  });

  it('rejects a fractional override', () => {
    expect(validateQualificationOverride({ durationOverrideMinutes: 60.5, priceOverrideCents: null })).toHaveLength(1);
  });

  it('reports both violations at once when both fields are bad', () => {
    const violations = validateQualificationOverride({ durationOverrideMinutes: 0, priceOverrideCents: -5 });
    expect(violations).toHaveLength(2);
  });
});

describe('effectiveDurationMinutes / effectivePriceCents (SVC-02)', () => {
  it('uses the base value when there is no override', () => {
    expect(effectiveDurationMinutes(45, null)).toBe(45);
    expect(effectiveDurationMinutes(45, undefined)).toBe(45);
    expect(effectivePriceCents(5500, null)).toBe(5500);
  });

  it('uses the override when present, even when it is zero', () => {
    expect(effectiveDurationMinutes(45, 60)).toBe(60);
    expect(effectivePriceCents(5500, 0)).toBe(0);
  });
});
