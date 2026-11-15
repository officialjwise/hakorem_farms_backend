import { Money, Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import {
  checkCounts,
  checkTakeScope,
  lineVariance,
  needsRecount,
  scopesOverlap,
  unfinishedLines,
  varianceTotals,
  varianceValue,
  type CountedLine,
  type CountedLocation,
  type CountedProduct,
} from './stock-take';

const q = (text: string) => Quantity.parse(text);
const cold: CountedLocation = { kind: 'COLD_ROOM', isVirtual: false, isLive: true };
const beef: CountedProduct = { tracking: 'LOT', stockPolicy: 'CATCH_WEIGHT' };
const yam: CountedProduct = { tracking: 'NONE', stockPolicy: 'COUNTABLE' };
const goat: CountedProduct = { tracking: 'SERIAL', stockPolicy: 'SERIALISED' };
const service: CountedProduct = { tracking: 'NONE', stockPolicy: 'NON_STOCK' };
const line = (expected: string, counted: string | null = null, recount: string | null = null): CountedLine => ({
  expected: q(expected),
  counted: counted === null ? null : q(counted),
  recount: recount === null ? null : q(recount),
});

describe('the scope of a stock take (FR-INV-013, FR-INV-014)', () => {
  it('accepts a full take of the cold room and a cycle count of beef and yam', () => {
    expect(checkTakeScope({ location: cold, scope: 'FULL', products: [] })).toEqual([]);
    expect(checkTakeScope({ location: cold, scope: 'CYCLE', products: [{ id: 'B', product: beef }, { id: 'Y', product: yam }] })).toEqual([]);
  });

  it('refuses a location that holds no stock of its own: virtual, in-transit, a site or archived', () => {
    for (const location of [
      { ...cold, isVirtual: true },
      { ...cold, kind: 'IN_TRANSIT' },
      { ...cold, kind: 'SITE' },
      { ...cold, isLive: false },
    ]) {
      expect(checkTakeScope({ location, scope: 'FULL', products: [] })).toEqual([{ field: '/locationId', rule: 'NOT_A_STOCK_LOCATION' }]);
    }
  });

  it('a cycle count lists its products, each once; a full take lists none', () => {
    expect(checkTakeScope({ location: cold, scope: 'CYCLE', products: [] })).toEqual([{ field: '/productIds', rule: 'PRODUCTS_REQUIRED' }]);
    expect(checkTakeScope({ location: cold, scope: 'FULL', products: [{ id: 'B', product: beef }] })).toEqual([{ field: '/productIds', rule: 'NOT_FOR_FULL_SCOPE' }]);
    expect(checkTakeScope({ location: cold, scope: 'CYCLE', products: [{ id: 'B', product: beef }, { id: 'B', product: beef }] })).toEqual([
      { field: '/productIds/1', rule: 'PRODUCT_REPEATED' },
    ]);
  });

  it('refuses a service and an animal: a missing animal is never a stock-take loss (A-141)', () => {
    expect(checkTakeScope({ location: cold, scope: 'CYCLE', products: [{ id: 'S', product: service }, { id: 'G', product: goat }] })).toEqual([
      { field: '/productIds/0', rule: 'PRODUCT_NOT_STOCKED' },
      { field: '/productIds/1', rule: 'ANIMAL_NOT_COUNTED' },
    ]);
  });
});

describe('overlapping scopes (FR-INV-014)', () => {
  const coldBeef = { locationId: 'COLD', scope: 'CYCLE' as const, productIds: ['BEEF'] };
  it('"Cold room, beef" and "Pen 2, goats" do not overlap; a second count that includes beef does', () => {
    expect(scopesOverlap(coldBeef, { locationId: 'PEN2', scope: 'CYCLE', productIds: ['BEEF'] })).toBe(false);
    expect(scopesOverlap(coldBeef, { locationId: 'COLD', scope: 'CYCLE', productIds: ['GOAT-MEAT'] })).toBe(false);
    expect(scopesOverlap(coldBeef, { locationId: 'COLD', scope: 'CYCLE', productIds: ['GOAT-MEAT', 'BEEF'] })).toBe(true);
  });

  it('a full take of the location overlaps every count there, either way round', () => {
    expect(scopesOverlap(coldBeef, { locationId: 'COLD', scope: 'FULL', productIds: [] })).toBe(true);
    expect(scopesOverlap({ locationId: 'COLD', scope: 'FULL', productIds: [] }, coldBeef)).toBe(true);
  });
});

describe('variances and recounts (FR-INV-013)', () => {
  it('expected 12 crates, counted 11: a loss of 1; counted 12: none; counted 14: a gain of 2', () => {
    expect(lineVariance(line('12.000', '11.000'))).toEqual({ qty: q('-1.000'), direction: 'LOSS' });
    expect(lineVariance(line('12.000', '12.000'))).toEqual({ qty: q('0.000'), direction: 'NONE' });
    expect(lineVariance(line('12.000', '14.000'))).toEqual({ qty: q('2.000'), direction: 'GAIN' });
  });

  it('has no variance until counted; the recount wins over the first count; a negative expected figure is counted from', () => {
    expect(lineVariance(line('12.000'))).toBeNull();
    expect(lineVariance(line('40.000', '30.000', '34.000'))).toEqual({ qty: q('-6.000'), direction: 'LOSS' });
    expect(lineVariance(line('-2.000', '0.000'))).toEqual({ qty: q('2.000'), direction: 'GAIN' });
  });

  it('in review, every line whose first count differs needs a recount, once; nothing needs one while counting', () => {
    expect(needsRecount('REVIEW', line('12.000', '11.000'))).toBe(true);
    expect(needsRecount('REVIEW', line('12.000', '11.000', '11.000'))).toBe(false);
    expect(needsRecount('REVIEW', line('12.000', '12.000'))).toBe(false);
    expect(needsRecount('REVIEW', line('12.000'))).toBe(false);
    expect(needsRecount('COUNTING', line('12.000', '11.000'))).toBe(false);
  });

  it('lists the lines not counted and those awaiting a recount', () => {
    expect(
      unfinishedLines('REVIEW', [
        { id: 'a', ...line('12.000') },
        { id: 'b', ...line('12.000', '11.000') },
        { id: 'c', ...line('12.000', '12.000') },
      ]),
    ).toEqual([
      { field: '/lines/a', rule: 'NOT_COUNTED' },
      { field: '/lines/b', rule: 'RECOUNT_REQUIRED' },
    ]);
  });
});

describe('the value of a variance (ADR-0018)', () => {
  const eggs = { qty: q('30.000'), value: Money.ofPesewas(105_000n) };
  it('a crate of eggs short of 30 valued 105,000 is a loss of 3,500; a crate found is a gain of 3,500', () => {
    expect(varianceValue(eggs, q('-1.000'))).toEqual(Money.ofPesewas(3_500n));
    expect(varianceValue(eggs, q('1.000'))).toEqual(Money.ofPesewas(3_500n));
  });

  it('rounds half up once: 1 of 3 units worth 100,001 is 33,334; the whole pool short carries all of it; no variance carries 0', () => {
    const pool = { qty: q('3.000'), value: Money.ofPesewas(100_001n) };
    expect(varianceValue(pool, q('-1.000'))).toEqual(Money.ofPesewas(33_334n));
    expect(varianceValue(pool, q('-3.000'))).toEqual(Money.ofPesewas(100_001n));
    expect(varianceValue(pool, q('0.000'))).toEqual(Money.zero());
  });

  it('sums gains and losses apart and together: 3,200 found and 12,000 + 971 lost is 16,171 judged', () => {
    const totals = varianceTotals([
      { direction: 'GAIN', value: Money.ofPesewas(3_200n) },
      { direction: 'LOSS', value: Money.ofPesewas(12_000n) },
      { direction: 'LOSS', value: Money.ofPesewas(971n) },
      { direction: 'NONE', value: Money.zero() },
    ]);
    expect(totals).toEqual({ gain: Money.ofPesewas(3_200n), loss: Money.ofPesewas(12_971n), total: Money.ofPesewas(16_171n) });
  });
});

describe('recording counts (FR-INV-013)', () => {
  const lines = new Map<string, CountedLine>([
    ['a', line('12.000', '11.000')],
    ['b', line('5.000', '5.000')],
  ]);
  it('accepts first counts while counting and a needed recount in review', () => {
    expect(checkCounts('COUNTING', [{ lineId: 'a', isRecount: false }, { lineId: 'b', isRecount: false }], lines)).toEqual([]);
    expect(checkCounts('REVIEW', [{ lineId: 'a', isRecount: true }], lines)).toEqual([]);
  });

  it('refuses counts outside counting and review, an empty batch, an unknown or repeated line', () => {
    expect(checkCounts('DRAFT', [{ lineId: 'a', isRecount: false }], lines)).toEqual([{ field: '/counts', rule: 'NOT_COUNTING' }]);
    expect(checkCounts('COUNTING', [], lines)).toEqual([{ field: '/counts', rule: 'NO_COUNTS' }]);
    expect(checkCounts('COUNTING', [{ lineId: 'x', isRecount: false }, { lineId: 'a', isRecount: false }, { lineId: 'a', isRecount: false }], lines)).toEqual([
      { field: '/counts/0/lineId', rule: 'LINE_UNKNOWN' },
      { field: '/counts/2/lineId', rule: 'LINE_REPEATED' },
    ]);
  });

  it('a recount only in review, of a line that needs one; no first count once counting is closed', () => {
    expect(checkCounts('COUNTING', [{ lineId: 'a', isRecount: true }], lines)).toEqual([{ field: '/counts/0/lineId', rule: 'RECOUNT_IN_REVIEW_ONLY' }]);
    expect(checkCounts('REVIEW', [{ lineId: 'a', isRecount: false }], lines)).toEqual([{ field: '/counts/0/lineId', rule: 'COUNTING_CLOSED' }]);
    expect(checkCounts('REVIEW', [{ lineId: 'b', isRecount: true }], lines)).toEqual([{ field: '/counts/0/lineId', rule: 'RECOUNT_NOT_NEEDED' }]);
  });
});
