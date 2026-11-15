import { Weight } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { checkOutputWeights, judgeYield, parsePercent, type YieldOutput } from './yield';

const MEAT = 'meat-product';
const OFFAL = 'offal-product';
const kg = (text: string) => Weight.parseKg(text);
const out = (productId: string, kind: YieldOutput['kind'], weight: string): YieldOutput => ({ productId, kind, weight: kg(weight) });
const goatStandards = new Map([[MEAT, { expectedPercent: '50', tolerancePercent: '5' }]]);

describe('output weight against input weight (FR-PRC-002)', () => {
  it('accepts outputs of 14.000, 3.000, 2.000 and 9.000 kg from a 28.000 kg input, exactly equal', () => {
    expect(checkOutputWeights(kg('28.000'), [out(MEAT, 'MEAT', '14.000'), out(OFFAL, 'OFFAL', '3.000'), out('b', 'BY_PRODUCT', '2.000'), out('w', 'WASTE', '9.000')])).toEqual([]);
  });

  it('refuses 9.001 kg of waste, one gram above the input', () => {
    expect(checkOutputWeights(kg('28.000'), [out(MEAT, 'MEAT', '14.000'), out(OFFAL, 'OFFAL', '3.000'), out('b', 'BY_PRODUCT', '2.000'), out('w', 'WASTE', '9.001')])).toEqual([
      { field: '/outputs', rule: 'OUTPUT_WEIGHT_ABOVE_INPUT' },
    ]);
  });
});

describe('expected and actual yield (FR-PRC-004) and the variance flag (FR-PRC-005)', () => {
  it('expects 14.000 kg of meat at 50 percent of 28.000 kg; 12.600 kg is 45.000 percent, -1.400 kg, and flagged', () => {
    const judged = judgeYield(kg('28.000'), [out(MEAT, 'MEAT', '12.600'), out('w', 'WASTE', '15.400')], goatStandards);
    expect(judged).toEqual({
      expectedPercent: '50.000',
      actualPercent: '45.000',
      flagged: true,
      lines: [{ productId: MEAT, expectedKg: '14.000', actualKg: '12.600', varianceKg: '-1.400', flagged: true }],
    });
  });

  it('does not flag 13.400 kg, a shortfall of 4.3 percent of expected', () => {
    const judged = judgeYield(kg('28.000'), [out(MEAT, 'MEAT', '13.400')], goatStandards);
    expect(judged.flagged).toBe(false);
    expect(judged.lines[0]).toEqual({ productId: MEAT, expectedKg: '14.000', actualKg: '13.400', varianceKg: '-0.600', flagged: false });
  });

  it('does not flag a variance of exactly the tolerance, and flags one gram more', () => {
    // 5 percent of 14.000 kg is 0.700 kg.
    expect(judgeYield(kg('28.000'), [out(MEAT, 'MEAT', '14.700')], goatStandards).flagged).toBe(false);
    expect(judgeYield(kg('28.000'), [out(MEAT, 'MEAT', '13.299')], goatStandards).flagged).toBe(true);
  });

  it('flags a yield above the standard as well as below it, with a positive variance', () => {
    const judged = judgeYield(kg('28.000'), [out(MEAT, 'MEAT', '15.000')], goatStandards);
    expect(judged.lines[0]).toMatchObject({ varianceKg: '1.000', flagged: true });
  });

  it('adds the outputs of one product and sums the standards of several into the overall yield', () => {
    const standards = new Map([
      [MEAT, { expectedPercent: '50', tolerancePercent: '5' }],
      [OFFAL, { expectedPercent: '10.5', tolerancePercent: '10' }],
    ]);
    const judged = judgeYield(kg('30.000'), [out(MEAT, 'MEAT', '7.000'), out(OFFAL, 'OFFAL', '3.100'), out(MEAT, 'MEAT', '8.000')], standards);
    expect(judged.expectedPercent).toBe('60.500');
    expect(judged.actualPercent).toBe('60.333');
    expect(judged.lines).toEqual([
      { productId: MEAT, expectedKg: '15.000', actualKg: '15.000', varianceKg: '0.000', flagged: false },
      { productId: OFFAL, expectedKg: '3.150', actualKg: '3.100', varianceKg: '-0.050', flagged: false },
    ]);
  });

  it('rounds an expected weight half up once, to the gram', () => {
    // 33.3335 percent of 1.000 kg is 333.335 g, so 0.333 kg; 50 percent of 0.003 kg is exactly 1.5 g, so 0.002.
    const standards = new Map([[MEAT, { expectedPercent: '33.3335', tolerancePercent: '5' }]]);
    expect(judgeYield(kg('1.000'), [out(MEAT, 'MEAT', '0.333')], standards).lines[0]!.expectedKg).toBe('0.333');
    const half = new Map([[MEAT, { expectedPercent: '50', tolerancePercent: '5' }]]);
    expect(judgeYield(kg('0.003'), [out(MEAT, 'MEAT', '0.001')], half).lines[0]!.expectedKg).toBe('0.002');
  });

  it('has no expected or actual yield and no flag when no output has a standard; waste never counts', () => {
    expect(judgeYield(kg('28.000'), [out(OFFAL, 'OFFAL', '3.000'), out(MEAT, 'WASTE', '9.000')], goatStandards)).toEqual({
      expectedPercent: null,
      actualPercent: null,
      flagged: false,
      lines: [],
    });
  });

  it('flags any actual weight against an expected weight of zero', () => {
    const zero = new Map([[MEAT, { expectedPercent: '0', tolerancePercent: '5' }]]);
    expect(judgeYield(kg('28.000'), [out(MEAT, 'MEAT', '0.001')], zero).flagged).toBe(true);
  });
});

describe('percent strings', () => {
  it('reads up to four decimal places of a percentage from 0 to 100, exactly', () => {
    expect(parsePercent('50')).toBe(500_000n);
    expect(parsePercent('10.5')).toBe(105_000n);
    expect(parsePercent('0.0001')).toBe(1n);
    expect(parsePercent('100')).toBe(1_000_000n);
  });

  it('refuses a percentage with five places, above 100, or that is not a number', () => {
    for (const bad of ['50.00001', '100.5', '101', '-1', 'ten', '']) {
      expect(() => parsePercent(bad)).toThrow(RangeError);
    }
  });
});
