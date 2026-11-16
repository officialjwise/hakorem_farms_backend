import { Money, Quantity, Rate, Weight } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { allocateReservation, checkoutTotals, deliveryFee, estimateLine, wholeUnits } from './pricing-lines';

const tenPercent = Rate.parsePercent('10.00');

describe('a storefront line estimate (FR-SHP-003, FR-SHP-007)', () => {
  it('prices two crates of eggs at 4,500 as exactly 9,000, with no tolerance', () => {
    const line = estimateLine({ basis: 'PER_UNIT', unitPrice: Money.ofPesewas(4_500n), quantity: Quantity.parse('2.000'), catchWeight: null });
    expect(line.estimatedWeight).toBeNull();
    expect(line.estimated.pesewas).toBe(9_000n);
    expect(line.maximum.pesewas).toBe(9_000n);
  });

  it('estimates 2 packs of beef at a nominal 15.000 kg and 2,800 per kg as 84,000, at most 92,400', () => {
    const line = estimateLine({ basis: 'PER_KG', unitPrice: Money.ofPesewas(2_800n), quantity: Quantity.parse('2.000'), catchWeight: { nominalPack: Weight.parseKg('15.000'), tolerance: tenPercent } });
    expect(line.estimatedWeight?.toKgString()).toBe('30.000');
    expect(line.estimated.pesewas).toBe(84_000n);
    expect(line.maximum.pesewas).toBe(92_400n);
  });

  it('rounds an exact half pesewa up once, at the estimate, and again only at the maximum anchor', () => {
    // 1 pack of 0.500 kg at 3 per kg is 1.5 pesewas: 2. Ten percent above 2 is 0.2: the maximum is 2.
    const half = estimateLine({ basis: 'PER_KG', unitPrice: Money.ofPesewas(3n), quantity: Quantity.parse('1.000'), catchWeight: { nominalPack: Weight.parseKg('0.500'), tolerance: tenPercent } });
    expect(half.estimated.pesewas).toBe(2n);
    expect(half.maximum.pesewas).toBe(2n);
    // 1 pack of 15.000 kg at 3,213 per kg is 48,195; ten percent is 4,819.5, up to 4,820: the maximum is 53,015.
    const beef = estimateLine({ basis: 'PER_KG', unitPrice: Money.ofPesewas(3_213n), quantity: Quantity.parse('1.000'), catchWeight: { nominalPack: Weight.parseKg('15.000'), tolerance: tenPercent } });
    expect(beef.estimated.pesewas).toBe(48_195n);
    expect(beef.maximum.pesewas).toBe(53_015n);
  });

  it('rounds one pesewa below half down and one above half up', () => {
    const below = estimateLine({ basis: 'PER_KG', unitPrice: Money.ofPesewas(1n), quantity: Quantity.parse('1.000'), catchWeight: { nominalPack: Weight.parseKg('0.499'), tolerance: Rate.parsePercent('0') } });
    const above = estimateLine({ basis: 'PER_KG', unitPrice: Money.ofPesewas(1n), quantity: Quantity.parse('1.000'), catchWeight: { nominalPack: Weight.parseKg('0.501'), tolerance: Rate.parsePercent('0') } });
    expect(below.estimated.pesewas).toBe(0n);
    expect(above.estimated.pesewas).toBe(1n);
  });

  it('prices a zero price at zero', () => {
    expect(estimateLine({ basis: 'PER_HEAD', unitPrice: Money.zero(), quantity: Quantity.parse('3.000'), catchWeight: null }).estimated.pesewas).toBe(0n);
  });

  it('accepts whole units only', () => {
    expect(wholeUnits(Quantity.parse('2.000'))).toBe(true);
    expect(wholeUnits(Quantity.parse('1.500'))).toBe(false);
    expect(wholeUnits(Quantity.parse('0.000'))).toBe(false);
  });
});

describe('the delivery fee (FR-SHP-008)', () => {
  it('adds the zone fee exactly, and waives it only above the zone threshold', () => {
    expect(deliveryFee({ feePesewas: 1_500n, freeOverPesewas: null }, Money.ofPesewas(9_000n)).pesewas).toBe(1_500n);
    expect(deliveryFee({ feePesewas: 3_000n, freeOverPesewas: 50_000n }, Money.ofPesewas(50_000n)).pesewas).toBe(3_000n);
    expect(deliveryFee({ feePesewas: 3_000n, freeOverPesewas: 50_000n }, Money.ofPesewas(50_001n)).pesewas).toBe(0n);
  });
});

describe('checkout totals (FR-SHP-004, FR-SHP-007, FR-SHP-008)', () => {
  it('sums the lines, takes off the discounts and adds the fee: a 9,000 cart with a 1,500 fee totals 10,500', () => {
    const totals = checkoutTotals([{ estimated: Money.ofPesewas(9_000n), maximum: Money.ofPesewas(9_000n), discount: Money.zero() }], Money.ofPesewas(1_500n));
    expect(totals.estimated.pesewas).toBe(10_500n);
    expect(totals.maximum.pesewas).toBe(10_500n);
  });

  it('takes a 10 percent coupon of exactly 900 off a 9,000 cart and keeps the catch-weight maximum above the estimate', () => {
    const totals = checkoutTotals(
      [
        { estimated: Money.ofPesewas(9_000n), maximum: Money.ofPesewas(9_000n), discount: Money.ofPesewas(900n) },
        { estimated: Money.ofPesewas(84_000n), maximum: Money.ofPesewas(92_400n), discount: Money.zero() },
      ],
      Money.zero(),
    );
    expect(totals.discount.pesewas).toBe(900n);
    expect(totals.estimated.pesewas).toBe(92_100n);
    expect(totals.maximum.pesewas).toBe(100_500n);
  });
});

describe('spreading a line across the balances that may be promised (FR-SHP-005)', () => {
  it('takes the oldest first and splits across balances only as far as needed', () => {
    const rows = [{ availableQty: Quantity.parse('15.000') }, { availableQty: Quantity.parse('30.000') }, { availableQty: Quantity.parse('5.000') }];
    expect(allocateReservation(Quantity.parse('30.000'), rows)?.map((p) => [p.index, p.qty.toDecimalString()])).toEqual([
      [0, '15.000'],
      [1, '15.000'],
    ]);
    expect(allocateReservation(Quantity.parse('10.000'), rows)?.map((p) => [p.index, p.qty.toDecimalString()])).toEqual([[0, '10.000']]);
  });

  it('answers null when the balances together hold too little', () => {
    expect(allocateReservation(Quantity.parse('51.000'), [{ availableQty: Quantity.parse('50.000') }])).toBeNull();
    expect(allocateReservation(Quantity.parse('1.000'), [])).toBeNull();
  });
});
