import { Weight } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { checkPacks, MAX_PACKS_PER_OUTPUT, packBarcode, packLabelText } from './packing';

const kg = (text: string) => Weight.parseKg(text);
const rules = (lot: string, packs: readonly string[], expectedCount: number | null = null) => {
  const checked = checkPacks(kg(lot), packs.map(kg), expectedCount);
  return checked.ok ? [] : checked.error.map((r) => `${r.field} ${r.rule}`);
};

describe('packing a lot into weighed packs (FR-PRC-009)', () => {
  it('accepts a lot of 44.600 kg packed as 15.000, 15.000 and 14.600, which sum to it exactly', () => {
    const checked = checkPacks(kg('44.600'), [kg('15.000'), kg('15.000'), kg('14.600')], null);
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.value.map((w) => w.toKgString())).toEqual(['15.000', '15.000', '14.600']);
  });

  it('refuses packs summing to 44.700 kg for a lot of 44.600 kg, and packs summing to 1 g short', () => {
    expect(rules('44.600', ['15.000', '15.000', '14.700'])).toEqual(['/packs PACK_WEIGHTS_NOT_LOT_WEIGHT']);
    expect(rules('44.600', ['15.000', '15.000', '14.599'])).toEqual(['/packs PACK_WEIGHTS_NOT_LOT_WEIGHT']);
  });

  it('accepts a single remainder pack, and the pack count the output recorded', () => {
    expect(rules('7.350', ['7.350'], 1)).toEqual([]);
    expect(rules('30.000', ['15.000', '15.000'], 2)).toEqual([]);
  });

  it('refuses a pack count other than the one the output recorded', () => {
    expect(rules('30.000', ['10.000', '10.000', '10.000'], 2)).toEqual(['/packs PACK_COUNT_NOT_OUTPUT_COUNT']);
  });

  it('refuses no packs, a pack of nothing, and more packs than one call takes', () => {
    expect(rules('1.000', [])).toEqual(['/packs NO_PACKS', '/packs PACK_WEIGHTS_NOT_LOT_WEIGHT']);
    expect(rules('1.000', ['1.000', '0.000'])).toEqual(['/packs/1/weightKg PACK_WEIGHT_NOT_POSITIVE']);
    const many = Array.from({ length: MAX_PACKS_PER_OUTPUT + 1 }, () => '0.001');
    expect(rules(Weight.ofGrams(BigInt(MAX_PACKS_PER_OUTPUT + 1)).toKgString(), many)).toEqual(['/packs TOO_MANY_PACKS']);
  });

  it('refuses a pack of 1000 kg or more, which six digits of grams cannot carry', () => {
    expect(rules('1000.000', ['1000.000'])).toEqual(['/packs/0/weightKg PACK_TOO_HEAVY_FOR_LABEL']);
    expect(rules('999.999', ['999.999'])).toEqual([]);
  });
});

describe('the pack label barcode (FR-PRC-010, A-151)', () => {
  it('encodes the lot and the weight in grams: LOT-BEEF-2026-1113/015200 for 15.200 kg', () => {
    expect(packBarcode('LOT-BEEF-2026-1113', kg('15.200'))).toEqual({ symbology: 'CODE_128', payload: 'LOT-BEEF-2026-1113/015200', text: 'LOT-BEEF-2026-1113/015200' });
  });

  it('pads the grams to six digits and gives the same payload on a reprint', () => {
    expect(packBarcode('PRC-261115-0a1b2c3d-01', kg('0.850')).payload).toBe('PRC-261115-0a1b2c3d-01/000850');
    expect(packBarcode('PRC-261115-0a1b2c3d-01', kg('999.999')).payload).toBe('PRC-261115-0a1b2c3d-01/999999');
    expect(packBarcode('L', kg('14.600'))).toEqual(packBarcode('L', kg('14.600')));
  });

  it('refuses a lot with a slash, which would make the payload ambiguous, and a weight six digits cannot carry', () => {
    expect(() => packBarcode('LOT/1', kg('1.000'))).toThrow(/slash/);
    expect(() => packBarcode('LOT-1', kg('1000.000'))).toThrow(/six digits/);
  });

  it('prints the weight in kilograms beside the lot', () => {
    expect(packLabelText('LOT-BEEF-2026-1113', kg('15.200'))).toBe('LOT-BEEF-2026-1113 · 15.200 kg');
  });
});
