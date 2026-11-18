import { describe, expect, it } from 'vitest';
import { defaultLineUom, sellingUnits } from './selling-units';

const eggs = { saleUom: 'CRATE', baseUom: 'EGG', converts: (uom: string) => uom === 'CRATE' };
const meat = { saleUom: 'PACK', baseUom: 'KG', converts: () => false };

describe('the units a product is sold by at a till (CR-038)', () => {
  it('puts the sale unit first and the rest by code, the base unit for an entry with no unit', () => {
    expect(sellingUnits(eggs, [null, 'CRATE', null])).toEqual(['CRATE', 'EGG']);
    expect(sellingUnits(eggs, ['CRATE'])).toEqual(['CRATE']);
    expect(sellingUnits(eggs, [null])).toEqual(['EGG']);
  });

  it('sells no unit without an entry, nor one the product does not convert', () => {
    expect(sellingUnits(eggs, [])).toEqual([]);
    expect(sellingUnits(eggs, ['TRAY', null])).toEqual(['EGG']);
  });

  it('starts with the priced unit when the sale unit has no entry (a meat pack by the kilogram)', () => {
    expect(sellingUnits(meat, [null])).toEqual(['KG']);
  });

  it('defaults a line to the first unit sold, or to the base unit when none is priced', () => {
    expect(defaultLineUom('EGG', ['CRATE', 'EGG'])).toBe('CRATE');
    expect(defaultLineUom('KG', ['KG'])).toBe('KG');
    expect(defaultLineUom('EGG', [])).toBe('EGG');
  });
});
