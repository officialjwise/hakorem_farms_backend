import { describe, expect, it } from 'vitest';
import { stockUnitLabel } from './label';

describe('what a lot or animal label prints (B05x, A-151; no barcode from contract 2.0.0, ADR-0072)', () => {
  it('prints a lot by its batch, with the weight standing on hand summed exactly to three places, and no barcode', () => {
    expect(stockUnitLabel({ tracking: 'LOT', identifier: 'LOT-BEEF-2026-1110', onHandWeightsKg: ['30.000', '14.999', '0.001'], lastWeightKg: null, lastWeighedAt: null })).toEqual({
      kind: 'LOT',
      lotNo: 'LOT-BEEF-2026-1110',
      tagNo: null,
      weightKg: '45.000',
      weighedAt: null,
    });
  });

  it('prints no weight for a lot of counted units, or one with nothing on hand', () => {
    expect(stockUnitLabel({ tracking: 'LOT', identifier: 'EGG-BIG-2026-1110', onHandWeightsKg: ['0.000'], lastWeightKg: null, lastWeighedAt: null }).weightKg).toBeNull();
    expect(stockUnitLabel({ tracking: 'LOT', identifier: 'EGG-BIG-2026-1110', onHandWeightsKg: [], lastWeightKg: null, lastWeighedAt: null }).weightKg).toBeNull();
  });

  it('prints an animal by its tag, with its last recorded weight and when it was weighed, and no barcode', () => {
    expect(stockUnitLabel({ tracking: 'SERIAL', identifier: 'G-0143', onHandWeightsKg: ['0.000'], lastWeightKg: '28.400', lastWeighedAt: '2026-11-10T07:00:00.000Z' })).toEqual({
      kind: 'ANIMAL',
      lotNo: null,
      tagNo: 'G-0143',
      weightKg: '28.400',
      weighedAt: '2026-11-10T07:00:00.000Z',
    });
    expect(stockUnitLabel({ tracking: 'SERIAL', identifier: 'S-0031', onHandWeightsKg: [], lastWeightKg: null, lastWeighedAt: null }).weightKg).toBeNull();
  });
});
