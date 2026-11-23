import { describe, expect, it } from 'vitest';
import { animalPrice, OFFLINE_PACK_PRICE, reasonAtSync } from './animal-price';

/**
 * An animal's own price in the offline pack (CR-052, A-286): exactly what the pricing engine resolved for it from its
 * own grade and latest weight, never derived; priceless when the engine says so, and why; a lot sells at its product's
 * band and carries none of its own.
 */
const resolved = (list: number, floor: number, ceiling: number) => ({
  outcome: 'RESOLVED' as const,
  resolved: { priceListEntryId: 'entry-goat-m-a', basis: 'PER_HEAD' as const, listPricePesewas: list, floorPricePesewas: floor, ceilingPricePesewas: ceiling },
  quoteRequiredReason: null,
});

describe('animalPrice', () => {
  it('gives a sellable animal the band and entry the engine resolved, to the pesewa', () => {
    expect(animalPrice({ tracking: 'SERIAL', sellable: true }, resolved(72_000, 45_000, 90_000))).toEqual({
      priceListEntryId: 'entry-goat-m-a',
      priceBand: { listPricePesewas: 72_000, floorPricePesewas: 45_000, ceilingPricePesewas: 90_000, basis: 'PER_HEAD' },
      unpricedReason: null,
    });
  });

  it('leaves an animal the engine cannot price priceless, with the engine’s reason', () => {
    for (const reason of ['MISSING_GRADE_OR_WEIGHT', 'NO_RULE', 'QUOTE_ONLY'] as const) {
      expect(animalPrice({ tracking: 'SERIAL', sellable: true }, { outcome: 'QUOTE_REQUIRED', resolved: null, quoteRequiredReason: reason })).toEqual({ priceListEntryId: null, priceBand: null, unpricedReason: reason });
    }
    // No list in force prices the product at this till at all: the engine was never asked, so no rule.
    expect(animalPrice({ tracking: 'SERIAL', sellable: true }, undefined)).toEqual({ priceListEntryId: null, priceBand: null, unpricedReason: 'NO_RULE' });
    // A resolution with nothing resolved is never read as a price.
    expect(animalPrice({ tracking: 'SERIAL', sellable: true }, { outcome: 'RESOLVED', resolved: null, quoteRequiredReason: null })).toEqual({ priceListEntryId: null, priceBand: null, unpricedReason: 'NO_RULE' });
  });

  it('prices no animal that cannot be sold, whatever the engine says', () => {
    expect(animalPrice({ tracking: 'SERIAL', sellable: false }, resolved(72_000, 45_000, 90_000))).toEqual({ priceListEntryId: null, priceBand: null, unpricedReason: 'NOT_SELLABLE' });
  });

  it('gives a lot no price of its own: it sells at its product’s band', () => {
    expect(animalPrice({ tracking: 'LOT', sellable: true }, resolved(1_900, 1_467, 2_333))).toEqual({ priceListEntryId: null, priceBand: null, unpricedReason: null });
  });
});

describe('reasonAtSync', () => {
  it('keeps the reason the till gave, and names a difference the till gave none for as the pack’s price', () => {
    expect(reasonAtSync('REGULAR_CUSTOMER')).toBe('REGULAR_CUSTOMER');
    expect(reasonAtSync(undefined)).toBe(OFFLINE_PACK_PRICE);
    expect(OFFLINE_PACK_PRICE).toBe('OFFLINE_PACK_PRICE');
  });
});
