import { Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { QUOTED_PRICE_REASON, quotedLinePricing, quotedOrderEstimate } from './quoted-line';

// UAT scenario 2: a GOAT-M goat lists at 85,000 (floor 70,000); Emmanuel Tetteh's quote agreed 95,000 a head.
const one = Quantity.parse('1.000');

describe("a converted quote's line keeps the list price its quote line recorded at issue (the owner, 2026-11-23, A-310 (a) reversed in the booking)", () => {
  it('records a quoted price above list as a variance ABOVE of the difference, the band widened to hold both prices', () => {
    expect(quotedLinePricing({ quotedUnitPricePesewas: 95_000n, listUnitPricePesewas: 85_000n, engineFloorUnitPricePesewas: 70_000n, quantity: one })).toEqual({
      resolvedUnitPricePesewas: 85_000n,
      floorUnitPricePesewas: 70_000n,
      ceilingUnitPricePesewas: 95_000n,
      agreedUnitPricePesewas: 95_000n,
      variancePesewas: 10_000n,
      varianceDirection: 'ABOVE',
      varianceReasonCode: QUOTED_PRICE_REASON,
    });
  });

  it('records a quoted price below list as a variance BELOW, the floor the lower of the engine floor and the quoted price', () => {
    expect(quotedLinePricing({ quotedUnitPricePesewas: 80_000n, listUnitPricePesewas: 85_000n, engineFloorUnitPricePesewas: 70_000n, quantity: Quantity.parse('4.000') })).toEqual({
      resolvedUnitPricePesewas: 85_000n,
      floorUnitPricePesewas: 70_000n,
      ceilingUnitPricePesewas: 85_000n,
      agreedUnitPricePesewas: 80_000n,
      variancePesewas: 20_000n,
      varianceDirection: 'BELOW',
      varianceReasonCode: QUOTED_PRICE_REASON,
    });
    // Below the engine floor (approved at the quote's margin step): the floor recorded is the quoted price.
    expect(quotedLinePricing({ quotedUnitPricePesewas: 65_000n, listUnitPricePesewas: 85_000n, engineFloorUnitPricePesewas: 70_000n, quantity: one }).floorUnitPricePesewas).toBe(65_000n);
  });

  it('records no variance at list, and no reason', () => {
    expect(quotedLinePricing({ quotedUnitPricePesewas: 85_000n, listUnitPricePesewas: 85_000n, engineFloorUnitPricePesewas: 70_000n, quantity: one })).toEqual({
      resolvedUnitPricePesewas: 85_000n,
      floorUnitPricePesewas: 70_000n,
      ceilingUnitPricePesewas: 85_000n,
      agreedUnitPricePesewas: 85_000n,
      variancePesewas: 0n,
      varianceDirection: null,
      varianceReasonCode: null,
    });
  });

  it('takes the quoted price as list, with no variance, on a line the engine did not price (as before 2026-11-24)', () => {
    expect(quotedLinePricing({ quotedUnitPricePesewas: 120_000n, listUnitPricePesewas: null, engineFloorUnitPricePesewas: null, quantity: one })).toEqual({
      resolvedUnitPricePesewas: 120_000n,
      floorUnitPricePesewas: 120_000n,
      ceilingUnitPricePesewas: 120_000n,
      agreedUnitPricePesewas: 120_000n,
      variancePesewas: 0n,
      varianceDirection: null,
      varianceReasonCode: null,
    });
  });

  it('takes a floor above the list price as the list price, so the band always holds the list', () => {
    expect(quotedLinePricing({ quotedUnitPricePesewas: 90_000n, listUnitPricePesewas: 85_000n, engineFloorUnitPricePesewas: 88_000n, quantity: one }).floorUnitPricePesewas).toBe(85_000n);
  });

  it('extends each price once over the quantity, half-up, and takes the difference of the two extensions', () => {
    // 7 eggs at 220 against a list of 215: 1,540 less 1,505.
    expect(quotedLinePricing({ quotedUnitPricePesewas: 220n, listUnitPricePesewas: 215n, engineFloorUnitPricePesewas: null, quantity: Quantity.parse('7.000') }).variancePesewas).toBe(35n);
    // 0.500 of a unit at 3 against 2: half_up(1.5) = 2 less half_up(1.0) = 1, never the rounded half of the difference.
    expect(quotedLinePricing({ quotedUnitPricePesewas: 3n, listUnitPricePesewas: 2n, engineFloorUnitPricePesewas: null, quantity: Quantity.parse('0.500') }).variancePesewas).toBe(1n);
    // One pesewa below an exact half: 0.499 of 3 is 1.497, 1; of 2 is 0.998, 1; no variance left.
    expect(quotedLinePricing({ quotedUnitPricePesewas: 3n, listUnitPricePesewas: 2n, engineFloorUnitPricePesewas: null, quantity: Quantity.parse('0.499') }).variancePesewas).toBe(0n);
    expect(quotedLinePricing({ quotedUnitPricePesewas: 9_007_199_254_740_991n, listUnitPricePesewas: 0n, engineFloorUnitPricePesewas: null, quantity: one }).variancePesewas).toBe(9_007_199_254_740_991n);
  });
});

describe("a converted order's estimate counts the tax as the invoice will (the owner, 2026-11-24, BL-124; A-352 (d) amended)", () => {
  it('counts UAT step 2.9 at 17,172.00: 18 goats at 950.00, the fee 60.00 and its 12.00 of tax, tax-exclusive', () => {
    expect(quotedOrderEstimate({ lineTotalsPesewas: Array.from({ length: 18 }, () => 95_000n), deliveryFeePesewas: 6_000n, taxPesewas: 1_200n, taxInclusive: false })).toBe(1_717_200n);
  });
  it('adds no tax to a tax-inclusive quote, whose lines and fee already carry it, nor to a quote with no fee and no tax', () => {
    expect(quotedOrderEstimate({ lineTotalsPesewas: [18_000n], deliveryFeePesewas: 6_003n, taxPesewas: 1_000n, taxInclusive: true })).toBe(24_003n);
    expect(quotedOrderEstimate({ lineTotalsPesewas: [12_000n, 1n], deliveryFeePesewas: 0n, taxPesewas: 0n, taxInclusive: false })).toBe(12_001n);
  });
});
