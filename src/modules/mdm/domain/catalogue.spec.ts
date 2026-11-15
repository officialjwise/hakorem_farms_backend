import { describe, expect, it } from 'vitest';
import { canChangeProductStatus, defineWeightBandRange, planCategoryArchive, planRangeChange, planReferencedArchive } from './catalogue';

describe('planCategoryArchive (FR-MDM-002)', () => {
  it('refuses a category with live products, naming the count rule', () => {
    expect(planCategoryArchive({ liveProducts: 3, liveChildren: 0 })).toEqual({ ok: false, error: [{ field: null, rule: 'HAS_LIVE_PRODUCTS' }] });
  });

  it('refuses a category with live children', () => {
    expect(planCategoryArchive({ liveProducts: 0, liveChildren: 1 })).toEqual({ ok: false, error: [{ field: null, rule: 'HAS_LIVE_CHILDREN' }] });
  });

  it('names both reasons at once', () => {
    const verdict = planCategoryArchive({ liveProducts: 1, liveChildren: 2 });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.error.map((rule) => rule.rule)).toEqual(['HAS_LIVE_PRODUCTS', 'HAS_LIVE_CHILDREN']);
  });

  it('archives an emptied category', () => {
    expect(planCategoryArchive({ liveProducts: 0, liveChildren: 0 })).toEqual({ ok: true, value: undefined });
  });
});

describe('defineWeightBandRange (FR-MDM-005)', () => {
  it('accepts 10.000 to 20.000 kg, half-open, as exact three-place strings', () => {
    expect(defineWeightBandRange('10.000', '20.000')).toEqual({ ok: true, value: { minKg: '10.000', maxKg: '20.000' } });
  });

  it('accepts a band starting at zero', () => {
    expect(defineWeightBandRange('0.000', '0.001')).toEqual({ ok: true, value: { minKg: '0.000', maxKg: '0.001' } });
  });

  it('refuses an empty band: max equal to min', () => {
    expect(defineWeightBandRange('20.000', '20.000')).toEqual({ ok: false, error: [{ field: '/maxKg', rule: 'NOT_ABOVE_MIN' }] });
  });

  it('refuses max below min', () => {
    expect(defineWeightBandRange('25.000', '19.500')).toEqual({ ok: false, error: [{ field: '/maxKg', rule: 'NOT_ABOVE_MIN' }] });
  });

  it('refuses a weight that is not kilograms to exactly three places, never rounding it', () => {
    expect(defineWeightBandRange('10.0', '20.000')).toEqual({ ok: false, error: [{ field: '/minKg', rule: 'KILOGRAMS_3_PLACES' }] });
    expect(defineWeightBandRange('10.000', '20.0005')).toEqual({ ok: false, error: [{ field: '/maxKg', rule: 'KILOGRAMS_3_PLACES' }] });
  });
});

describe('planReferencedArchive and planRangeChange (A-106)', () => {
  it('refuses to archive a grade or band that a live price list version prices with', () => {
    expect(planReferencedArchive(2)).toEqual({ ok: false, error: [{ field: null, rule: 'USED_BY_LIVE_PRICES' }] });
    expect(planReferencedArchive(0)).toEqual({ ok: true, value: undefined });
  });

  it('refuses to move the range of a band that a live price uses, and allows an unchanged range', () => {
    const current = { minKg: '18.000', maxKg: '28.000' };
    expect(planRangeChange(current, { minKg: '18.000', maxKg: '30.000' }, 1)).toEqual({ ok: false, error: [{ field: '/maxKg', rule: 'USED_BY_LIVE_PRICES' }] });
    expect(planRangeChange(current, { minKg: '18.000', maxKg: '28.000' }, 1)).toEqual({ ok: true, value: undefined });
    expect(planRangeChange(current, { minKg: '17.000', maxKg: '28.000' }, 0)).toEqual({ ok: true, value: undefined });
    expect(planRangeChange(current, { minKg: '17.000', maxKg: '28.000' }, 3)).toEqual({ ok: false, error: [{ field: '/minKg', rule: 'USED_BY_LIVE_PRICES' }] });
  });
});

describe('canChangeProductStatus (A-106)', () => {
  it.each([
    ['DRAFT', 'ACTIVE', true],
    ['DRAFT', 'DISCONTINUED', true],
    ['ACTIVE', 'DISCONTINUED', true],
    ['DISCONTINUED', 'ACTIVE', true],
    ['ACTIVE', 'DRAFT', false],
    ['DISCONTINUED', 'DRAFT', false],
    ['ACTIVE', 'ACTIVE', true],
  ] as const)('%s to %s: %s', (from, to, allowed) => {
    expect(canChangeProductStatus(from, to)).toBe(allowed);
  });
});
