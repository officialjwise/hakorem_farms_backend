import { describe, expect, it } from 'vitest';
import { stockUnitLabel } from './label';

describe('what a lot or animal label prints (B05x, A-151)', () => {
  it('prints a lot by its batch, with the weight standing on hand summed exactly to three places, as Code 128 of SKU and batch', () => {
    expect(stockUnitLabel({ tracking: 'LOT', sku: 'MEAT-BEEF-15KG', identifier: 'LOT-BEEF-2026-1110', onHandWeightsKg: ['30.000', '14.999', '0.001'], lastWeightKg: null, lastWeighedAt: null })).toEqual({
      kind: 'LOT',
      lotNo: 'LOT-BEEF-2026-1110',
      tagNo: null,
      weightKg: '45.000',
      weighedAt: null,
      barcode: { symbology: 'CODE_128', payload: 'MEAT-BEEF-15KG/LOT-BEEF-2026-1110', text: 'MEAT-BEEF-15KG/LOT-BEEF-2026-1110' },
    });
  });

  it('prints no weight for a lot of counted units, or one with nothing on hand', () => {
    expect(stockUnitLabel({ tracking: 'LOT', sku: 'EGG-CRATE-BIG', identifier: 'EGG-BIG-2026-1110', onHandWeightsKg: ['0.000'], lastWeightKg: null, lastWeighedAt: null }).weightKg).toBeNull();
    expect(stockUnitLabel({ tracking: 'LOT', sku: 'EGG-CRATE-BIG', identifier: 'EGG-BIG-2026-1110', onHandWeightsKg: [], lastWeightKg: null, lastWeighedAt: null }).weightKg).toBeNull();
  });

  it('prints an animal by its tag, with its last recorded weight and when it was weighed', () => {
    expect(stockUnitLabel({ tracking: 'SERIAL', sku: 'LIV-GOAT', identifier: 'G-0143', onHandWeightsKg: ['0.000'], lastWeightKg: '28.400', lastWeighedAt: '2026-11-10T07:00:00.000Z' })).toEqual({
      kind: 'ANIMAL',
      lotNo: null,
      tagNo: 'G-0143',
      weightKg: '28.400',
      weighedAt: '2026-11-10T07:00:00.000Z',
      barcode: { symbology: 'CODE_128', payload: 'LIV-GOAT/G-0143', text: 'LIV-GOAT/G-0143' },
    });
    expect(stockUnitLabel({ tracking: 'SERIAL', sku: 'LIV-SHEEP', identifier: 'S-0031', onHandWeightsKg: [], lastWeightKg: null, lastWeighedAt: null }).weightKg).toBeNull();
  });
});
