import { Rate } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import {
  applyLinePromotions,
  defineCoupon,
  definePromotion,
  judgeCoupon,
  promotionDiscount,
  type PromotableLine,
  type PromotionDraft,
  type PromotionRule,
} from './promotions';

const AT = new Date('2026-12-10T10:00:00Z');
const FROM = new Date('2026-12-01T00:00:00Z');
const TO = new Date('2027-01-01T00:00:00Z');
const BROILER = 'product-broiler';
const GOAT = 'product-goat';
const POULTRY = 'category-poultry';

let seq = 0;
function rule(fields: Partial<PromotionRule> = {}): PromotionRule {
  seq += 1;
  return {
    id: `promo-${seq}`,
    code: `P${String(seq).padStart(3, '0')}`,
    name: `Promotion ${seq}`,
    kind: 'PERCENT_OFF',
    percentOff: Rate.parsePercent('5'),
    amountOffPesewas: null,
    appliesTo: 'LINE',
    channel: null,
    minOrderPesewas: null,
    stackGroup: 'DEFAULT',
    isExclusive: false,
    requiresCoupon: false,
    validFrom: FROM,
    validTo: TO,
    productIds: [BROILER],
    categoryIds: [],
    ...fields,
  };
}

/** A broiler line of 10 heads at GHS 180.00 list, extended at list: 180,000 pesewas. */
function line(fields: Partial<PromotableLine> = {}): PromotableLine {
  return {
    productId: BROILER,
    categoryIds: [POULTRY, 'category-live-and-poultry'],
    channel: 'POS',
    priceListKind: 'BASE',
    lineAmountPesewas: 180_000n,
    at: AT,
    ...fields,
  };
}

const NO_CONTEXT = { orderAmountPesewas: 180_000n, couponPromotionId: null };

describe('promotionDiscount', () => {
  it('takes a percentage of the line extended at list, rounded half-up once', () => {
    // 5 percent of 180,000 is exactly 9,000.
    expect(promotionDiscount(rule(), 180_000n)).toBe(9_000n);
  });

  it('rounds an exact half pesewa up', () => {
    // 5 percent of 10 is 0.5, which rounds to 1.
    expect(promotionDiscount(rule(), 10n)).toBe(1n);
  });

  it('rounds one pesewa below half down', () => {
    // 5 percent of 9 is 0.45, which rounds to 0.
    expect(promotionDiscount(rule(), 9n)).toBe(0n);
  });

  it('rounds above half up', () => {
    // 2.5 percent of 30 is 0.75, which rounds to 1.
    expect(promotionDiscount(rule({ percentOff: Rate.parsePercent('2.5') }), 30n)).toBe(1n);
  });

  it('gives nothing on a line of zero', () => {
    expect(promotionDiscount(rule(), 0n)).toBe(0n);
  });

  it('takes a fixed amount off the line once', () => {
    expect(
      promotionDiscount(
        rule({
          kind: 'AMOUNT_OFF',
          percentOff: null,
          amountOffPesewas: 2_500n,
        }),
        180_000n,
      ),
    ).toBe(2_500n);
  });

  it('never takes more than the line is worth', () => {
    expect(
      promotionDiscount(
        rule({
          kind: 'AMOUNT_OFF',
          percentOff: null,
          amountOffPesewas: 2_500n,
        }),
        1_000n,
      ),
    ).toBe(1_000n);
  });

  it('handles the largest amount exactly', () => {
    const max = 9_007_199_254_740_991n;
    expect(promotionDiscount(rule({ percentOff: Rate.parsePercent('100') }), max)).toBe(max);
  });

  it('gives a line nothing from a kind that is evaluated on the whole order', () => {
    expect(promotionDiscount(rule({ kind: 'FREE_DELIVERY', percentOff: null }), 180_000n)).toBe(0n);
  });
});

describe('applyLinePromotions', () => {
  it('applies only the larger of two promotions in one stack group', () => {
    const five = rule({ percentOff: Rate.parsePercent('5') });
    const eight = rule({ percentOff: Rate.parsePercent('8') });
    expect(applyLinePromotions(line(), [five, eight], NO_CONTEXT)).toEqual([{ promotion: eight, discountPesewas: 14_400n }]);
  });

  it('breaks a tie inside a group by promotion code, so the answer never depends on load order', () => {
    const first = rule({ code: 'A-FIRST' });
    const second = rule({ code: 'B-SECOND' });
    expect(applyLinePromotions(line(), [second, first], NO_CONTEXT).map((applied) => applied.promotion.code)).toEqual(['A-FIRST']);
    expect(applyLinePromotions(line(), [first, second], NO_CONTEXT).map((applied) => applied.promotion.code)).toEqual(['A-FIRST']);
  });

  it('applies only the exclusive 10 percent when a 5 percent sits in another group', () => {
    const exclusive = rule({
      percentOff: Rate.parsePercent('10'),
      isExclusive: true,
      stackGroup: 'SEASONAL',
    });
    const other = rule({
      percentOff: Rate.parsePercent('5'),
      stackGroup: 'LOYALTY',
    });
    expect(applyLinePromotions(line(), [other, exclusive], NO_CONTEXT)).toEqual([{ promotion: exclusive, discountPesewas: 18_000n }]);
  });

  it('lets an exclusive promotion exclude a larger one that is not exclusive', () => {
    const exclusive = rule({
      percentOff: Rate.parsePercent('2'),
      isExclusive: true,
      stackGroup: 'A',
    });
    const larger = rule({
      percentOff: Rate.parsePercent('20'),
      stackGroup: 'B',
    });
    expect(applyLinePromotions(line(), [larger, exclusive], NO_CONTEXT)).toEqual([{ promotion: exclusive, discountPesewas: 3_600n }]);
  });

  it('takes the larger of two exclusive promotions', () => {
    const small = rule({
      percentOff: Rate.parsePercent('3'),
      isExclusive: true,
      stackGroup: 'A',
    });
    const big = rule({
      percentOff: Rate.parsePercent('4'),
      isExclusive: true,
      stackGroup: 'B',
    });
    expect(applyLinePromotions(line(), [small, big], NO_CONTEXT)).toEqual([{ promotion: big, discountPesewas: 7_200n }]);
  });

  it('stacks one promotion from each group, largest first', () => {
    const loyalty = rule({
      percentOff: Rate.parsePercent('5'),
      stackGroup: 'LOYALTY',
    });
    const seasonal = rule({
      kind: 'AMOUNT_OFF',
      percentOff: null,
      amountOffPesewas: 20_000n,
      stackGroup: 'SEASONAL',
    });
    expect(applyLinePromotions(line(), [loyalty, seasonal], NO_CONTEXT)).toEqual([
      { promotion: seasonal, discountPesewas: 20_000n },
      { promotion: loyalty, discountPesewas: 9_000n },
    ]);
  });

  it('caps stacked discounts at the line, so a line is never priced below nothing', () => {
    const big = rule({
      kind: 'AMOUNT_OFF',
      percentOff: null,
      amountOffPesewas: 150_000n,
      stackGroup: 'A',
    });
    const half = rule({ percentOff: Rate.parsePercent('50'), stackGroup: 'B' });
    const applied = applyLinePromotions(line(), [big, half], NO_CONTEXT);
    expect(applied).toEqual([
      { promotion: big, discountPesewas: 150_000n },
      { promotion: half, discountPesewas: 30_000n },
    ]);
    expect(applied.reduce((sum, item) => sum + item.discountPesewas, 0n)).toBe(180_000n);
  });

  it('drops a promotion the cap leaves nothing for', () => {
    const all = rule({ percentOff: Rate.parsePercent('100'), stackGroup: 'A' });
    const more = rule({ percentOff: Rate.parsePercent('5'), stackGroup: 'B' });
    expect(applyLinePromotions(line(), [all, more], NO_CONTEXT)).toEqual([{ promotion: all, discountPesewas: 180_000n }]);
  });

  it('never discounts a customer contract price', () => {
    expect(applyLinePromotions(line({ priceListKind: 'CUSTOMER' }), [rule()], NO_CONTEXT)).toEqual([]);
  });

  it.each(['TIER', 'CHANNEL', 'BASE'] as const)('discounts a price from a %s list', (priceListKind) => {
    expect(applyLinePromotions(line({ priceListKind }), [rule()], NO_CONTEXT)).toHaveLength(1);
  });

  it('matches a promotion by category as well as by product', () => {
    expect(applyLinePromotions(line(), [rule({ productIds: [], categoryIds: [POULTRY] })], NO_CONTEXT)).toHaveLength(1);
  });

  it('matches a promotion on a parent category', () => {
    expect(applyLinePromotions(line(), [rule({ productIds: [], categoryIds: ['category-live-and-poultry'] })], NO_CONTEXT)).toHaveLength(1);
  });

  it('ignores a promotion for another product', () => {
    expect(applyLinePromotions(line({ productId: GOAT, categoryIds: ['category-live'] }), [rule()], NO_CONTEXT)).toEqual([]);
  });

  it('applies a promotion for every channel or for the line channel, not for another channel', () => {
    expect(applyLinePromotions(line(), [rule({ channel: 'POS' })], NO_CONTEXT)).toHaveLength(1);
    expect(applyLinePromotions(line(), [rule({ channel: 'ONLINE' })], NO_CONTEXT)).toEqual([]);
  });

  it('applies from the first moment of the window and not at its end', () => {
    expect(applyLinePromotions(line({ at: FROM }), [rule()], NO_CONTEXT)).toHaveLength(1);
    expect(applyLinePromotions(line({ at: TO }), [rule()], NO_CONTEXT)).toEqual([]);
    expect(applyLinePromotions(line({ at: new Date('2026-11-30T23:59:59Z') }), [rule()], NO_CONTEXT)).toEqual([]);
  });

  it('applies a coupon promotion only with its coupon', () => {
    const coupon = rule({ requiresCoupon: true });
    expect(applyLinePromotions(line(), [coupon], NO_CONTEXT)).toEqual([]);
    expect(
      applyLinePromotions(line(), [coupon], {
        ...NO_CONTEXT,
        couponPromotionId: 'another',
      }),
    ).toEqual([]);
    expect(
      applyLinePromotions(line(), [coupon], {
        ...NO_CONTEXT,
        couponPromotionId: coupon.id,
      }),
    ).toHaveLength(1);
  });

  it('applies a minimum-order promotion only when the order reaches it', () => {
    const min = rule({ minOrderPesewas: 200_000n });
    expect(
      applyLinePromotions(line(), [min], {
        ...NO_CONTEXT,
        orderAmountPesewas: 199_999n,
      }),
    ).toEqual([]);
    expect(
      applyLinePromotions(line(), [min], {
        ...NO_CONTEXT,
        orderAmountPesewas: 200_000n,
      }),
    ).toHaveLength(1);
  });

  it('leaves order-level, bundle and delivery promotions to the order', () => {
    const order = rule({ appliesTo: 'ORDER' });
    const bundle = rule({
      kind: 'BUNDLE_PRICE',
      percentOff: null,
      stackGroup: 'B',
    });
    expect(applyLinePromotions(line(), [order, bundle], NO_CONTEXT)).toEqual([]);
  });

  it('records nothing for a promotion that rounds to zero on this line', () => {
    expect(applyLinePromotions(line({ lineAmountPesewas: 9n }), [rule()], NO_CONTEXT)).toEqual([]);
  });
});

const DRAFT: PromotionDraft = {
  kind: 'PERCENT_OFF',
  percentOff: '10',
  amountOffPesewas: null,
  bundlePricePesewas: null,
  appliesTo: 'LINE',
  maxRedemptions: null,
  validFrom: FROM,
  validTo: TO,
  targets: [{ productId: BROILER, categoryId: null, bundleQty: null }],
};

describe('definePromotion', () => {
  it('accepts a percentage promotion on a product', () => {
    expect(definePromotion(DRAFT)).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ['a percentage without its percent', { percentOff: null }, '/percentOff'],
    ['a percentage of zero', { percentOff: '0' }, '/percentOff'],
    ['a percentage above one hundred', { percentOff: '100.5' }, '/percentOff'],
    [
      'an amount off with a bundle price as well',
      {
        kind: 'AMOUNT_OFF',
        percentOff: null,
        amountOffPesewas: 100n,
        bundlePricePesewas: 100n,
      },
      '/bundlePricePesewas',
    ],
    ['a bundle of no price', { kind: 'BUNDLE_PRICE', percentOff: null, bundlePricePesewas: 0n }, '/bundlePricePesewas'],
    [
      'a bundle with an amount off as well',
      {
        kind: 'BUNDLE_PRICE',
        percentOff: null,
        bundlePricePesewas: 100n,
        amountOffPesewas: 100n,
      },
      '/amountOffPesewas',
    ],
    ['free delivery with an amount off', { kind: 'FREE_DELIVERY', percentOff: null, amountOffPesewas: 100n }, '/amountOffPesewas'],
    ['free delivery with a bundle price', { kind: 'FREE_DELIVERY', percentOff: null, bundlePricePesewas: 100n }, '/bundlePricePesewas'],
    ['a percentage with an amount as well', { amountOffPesewas: 100n }, '/amountOffPesewas'],
    ['an amount off without its amount', { kind: 'AMOUNT_OFF', percentOff: null }, '/amountOffPesewas'],
    ['an amount off of zero', { kind: 'AMOUNT_OFF', percentOff: null, amountOffPesewas: 0n }, '/amountOffPesewas'],
    ['an amount off with a percent as well', { kind: 'AMOUNT_OFF', amountOffPesewas: 100n }, '/percentOff'],
    ['a bundle without its price', { kind: 'BUNDLE_PRICE', percentOff: null }, '/bundlePricePesewas'],
    ['a bundle with a percent', { kind: 'BUNDLE_PRICE', bundlePricePesewas: 50_000n }, '/percentOff'],
    ['free delivery with a percent', { kind: 'FREE_DELIVERY' }, '/percentOff'],
    ['free delivery on a line', { kind: 'FREE_DELIVERY', percentOff: null }, '/appliesTo'],
    ['a price on something other than a bundle', { bundlePricePesewas: 50_000n }, '/bundlePricePesewas'],
    ['a window that ends before it starts', { validTo: FROM }, '/validTo'],
    ['a line promotion with no target', { targets: [] }, '/targets'],
    [
      'a target naming both a product and a category',
      {
        targets: [{ productId: BROILER, categoryId: POULTRY, bundleQty: null }],
      },
      '/targets/0',
    ],
    ['a target naming neither', { targets: [{ productId: null, categoryId: null, bundleQty: null }] }, '/targets/0'],
    ['the same target twice', { targets: [DRAFT.targets[0]!, DRAFT.targets[0]!] }, '/targets/1'],
    [
      'a bundle quantity outside a bundle',
      {
        targets: [{ productId: BROILER, categoryId: null, bundleQty: '2.000' }],
      },
      '/targets/0/bundleQty',
    ],
    ['a redemption limit of zero', { maxRedemptions: 0 }, '/maxRedemptions'],
  ] as const)('refuses %s', (_name, change, field) => {
    expect(definePromotion({ ...DRAFT, ...(change as Partial<PromotionDraft>) })).toEqual({ ok: false, error: { field, code: 'PROMOTION_INVALID' } });
  });

  it('accepts a fixed amount off a product', () => {
    expect(
      definePromotion({
        ...DRAFT,
        kind: 'AMOUNT_OFF',
        percentOff: null,
        amountOffPesewas: 2_500n,
      }).ok,
    ).toBe(true);
  });

  it('accepts a bundle price with bundle quantities', () => {
    const bundle: PromotionDraft = {
      ...DRAFT,
      kind: 'BUNDLE_PRICE',
      percentOff: null,
      bundlePricePesewas: 50_000n,
      targets: [{ productId: BROILER, categoryId: null, bundleQty: '2.000' }],
    };
    expect(definePromotion(bundle).ok).toBe(true);
  });

  it('refuses a bundle target without a positive quantity', () => {
    const bundle: PromotionDraft = {
      ...DRAFT,
      kind: 'BUNDLE_PRICE',
      percentOff: null,
      bundlePricePesewas: 50_000n,
      targets: [{ productId: BROILER, categoryId: null, bundleQty: '0.000' }],
    };
    expect(definePromotion(bundle)).toEqual({
      ok: false,
      error: { field: '/targets/0/bundleQty', code: 'PROMOTION_INVALID' },
    });
  });

  it('accepts free delivery on the whole order with no target', () => {
    expect(
      definePromotion({
        ...DRAFT,
        kind: 'FREE_DELIVERY',
        percentOff: null,
        appliesTo: 'ORDER',
        targets: [],
      }).ok,
    ).toBe(true);
  });
});

describe('defineCoupon', () => {
  it('stores a code upper-case and trimmed', () => {
    expect(defineCoupon({ code: ' xmas-26 ', maxUses: 100, perCustomerLimit: 1 })).toEqual({
      ok: true,
      value: { code: 'XMAS-26', maxUses: 100, perCustomerLimit: 1 },
    });
  });

  it.each([
    ['a code with spaces inside', { code: 'XMAS 26' }, '/code'],
    ['a code too short', { code: 'AB' }, '/code'],
    ['a limit of zero', { code: 'XMAS-26', maxUses: 0 }, '/maxUses'],
    ['a per-customer limit of zero', { code: 'XMAS-26', perCustomerLimit: 0 }, '/perCustomerLimit'],
    ['a per-customer limit above the total', { code: 'XMAS-26', maxUses: 2, perCustomerLimit: 3 }, '/perCustomerLimit'],
  ] as const)('refuses %s', (_name, input, field) => {
    expect(defineCoupon({ maxUses: null, perCustomerLimit: null, ...input })).toEqual({ ok: false, error: { field, code: 'COUPON_INVALID' } });
  });
});

describe('judgeCoupon', () => {
  const coupon = {
    maxUses: 100,
    perCustomerLimit: 1,
    usedCount: 0,
    promotionStatus: 'ACTIVE' as const,
    validFrom: FROM,
    validTo: TO,
  };

  it('accepts a coupon with uses left inside its window', () => {
    expect(judgeCoupon(coupon, 0, AT)).toBeNull();
  });

  it('refuses the 101st use of a coupon limited to 100', () => {
    expect(judgeCoupon({ ...coupon, usedCount: 100 }, 0, AT)).toBe('LIMIT_REACHED');
    expect(judgeCoupon({ ...coupon, usedCount: 99 }, 0, AT)).toBeNull();
  });

  it('refuses a customer who has used their share', () => {
    expect(judgeCoupon(coupon, 1, AT)).toBe('ALREADY_USED');
  });

  it('has no limit when none is set', () => {
    expect(judgeCoupon({ ...coupon, maxUses: null, perCustomerLimit: null, usedCount: 5_000 }, 40, AT)).toBeNull();
  });

  it('refuses outside the window and on a promotion that is not active', () => {
    expect(judgeCoupon(coupon, 0, TO)).toBe('EXPIRED');
    expect(judgeCoupon(coupon, 0, new Date('2026-11-01T00:00:00Z'))).toBe('NOT_APPLICABLE');
    expect(judgeCoupon({ ...coupon, promotionStatus: 'ENDED' }, 0, AT)).toBe('EXPIRED');
    expect(judgeCoupon({ ...coupon, promotionStatus: 'DRAFT' }, 0, AT)).toBe('NOT_APPLICABLE');
  });
});
