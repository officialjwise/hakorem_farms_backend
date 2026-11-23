import { Money, Quantity, Rate, Weight } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { judgePickedQuantity, judgeWeighed, pickedLineTotal, pickWeightSource, readyToPack, toleranceLimits } from './picking';

const kg = (text: string) => Weight.parseKg(text);
const q = (text: string) => Quantity.parse(text);
const ten = Rate.parsePercent('10');
const money = (pesewas: bigint) => Money.ofPesewas(pesewas);

describe('pickedLineTotal (FR-ORD-009, ADR-0021): the final line total on the weighed quantity, half-up once', () => {
  it('prices packs of 15.200 and 15.600 kg at 2,800 a kg as 30.800 kg and 86,240', () => {
    expect(pickedLineTotal(2_800n, 'PER_KG', [{ qty: q('1.000'), weight: kg('15.200') }, { qty: q('1.000'), weight: kg('15.600') }])).toEqual({ weight: kg('30.800'), qty: q('2.000'), total: money(86_240n) });
  });

  it('rounds the sum of the weights once, never each pack on its own', () => {
    // Three packs of 0.155 kg at 3 a kg: each alone would be 0.465 -> 0; the line's 0.465 kg is 1.395 -> 1.
    expect(pickedLineTotal(3n, 'PER_KG', [0, 1, 2].map(() => ({ qty: q('1.000'), weight: kg('0.155') }))).total).toEqual(money(1n));
  });

  it('rounds an exact half pesewa up at the line: 2.500 kg at 3 a kg is 8', () => {
    expect(pickedLineTotal(3n, 'PER_KG', [{ qty: q('1.000'), weight: kg('2.500') }]).total).toEqual(money(8n));
  });

  it('rounds one gram below the half down and one above up: 2.499 kg is 7, 2.501 kg is 8', () => {
    expect(pickedLineTotal(3n, 'PER_KG', [{ qty: q('1.000'), weight: kg('2.499') }]).total).toEqual(money(7n));
    expect(pickedLineTotal(3n, 'PER_KG', [{ qty: q('1.000'), weight: kg('2.501') }]).total).toEqual(money(8n));
  });

  it('prices nothing picked at zero', () => {
    expect(pickedLineTotal(2_800n, 'PER_KG', [])).toEqual({ weight: Weight.zero(), qty: Quantity.zero(), total: Money.zero() });
  });

  it('prices a line sold by the unit on its picked quantity, with no weight: 2 crates at 6,000 is 12,000', () => {
    expect(pickedLineTotal(6_000n, 'PER_UNIT', [{ qty: q('1.000'), weight: null }, { qty: q('1.000'), weight: null }])).toEqual({ weight: null, qty: q('2.000'), total: money(12_000n) });
  });

  it('refuses a catch-weight pick with no weight', () => {
    expect(() => pickedLineTotal(2_800n, 'PER_KG', [{ qty: q('1.000'), weight: null }])).toThrow(/weight/);
  });
});

describe('toleranceLimits and judgeWeighed (FR-ORD-010): within the estimate plus or minus the tolerance', () => {
  const estimate = { weight: kg('30.000'), tolerance: ten, estimatedTotal: money(84_000n) };

  it('gives 27.000 to 33.000 kg and a most of 92,400 around an estimate of 30.000 kg and 84,000 at 10 percent', () => {
    expect(toleranceLimits(estimate)).toEqual({ minimum: kg('27.000'), maximum: kg('33.000'), maximumTotal: money(92_400n) });
  });

  it('lets 30.800 kg at 86,240 proceed', () => {
    expect(judgeWeighed(estimate, kg('30.800'), money(86_240n))).toBe('WITHIN');
  });

  it('holds 34.000 kg over the 33.000 kg limit for the customer’s consent', () => {
    expect(judgeWeighed(estimate, kg('34.000'), money(95_200n))).toBe('ABOVE');
  });

  it('prompts for a pack below 27.000 kg: 26.000 kg is BELOW', () => {
    expect(judgeWeighed(estimate, kg('26.000'), money(72_800n))).toBe('BELOW');
  });

  it('takes both limits as within: exactly 27.000 and exactly 33.000 kg', () => {
    expect(judgeWeighed(estimate, kg('27.000'), money(75_600n))).toBe('WITHIN');
    expect(judgeWeighed(estimate, kg('33.000'), money(92_400n))).toBe('WITHIN');
  });

  it('takes a gram over the limit as above, and a gram under the floor as below', () => {
    expect(judgeWeighed(estimate, kg('33.001'), money(92_403n))).toBe('ABOVE');
    expect(judgeWeighed(estimate, kg('26.999'), money(75_597n))).toBe('BELOW');
  });

  it('holds a weight within the limit whose total rounds a pesewa past the most the customer was shown', () => {
    // The total is judged beside the weight: 0.550 kg is the weight limit of 0.500 kg at 10 percent, but a total of 5
    // is above the most of 4 the customer was shown (4 + half_up(0.4) = 4), so the line waits for consent.
    expect(judgeWeighed({ weight: kg('0.500'), tolerance: ten, estimatedTotal: money(4n) }, kg('0.550'), money(5n))).toBe('ABOVE');
  });

  it('gives a zero tolerance one weight: the estimate itself', () => {
    const exact = { weight: kg('15.000'), tolerance: Rate.parsePercent('0'), estimatedTotal: money(48_195n) };
    expect(toleranceLimits(exact)).toEqual({ minimum: kg('15.000'), maximum: kg('15.000'), maximumTotal: money(48_195n) });
    expect(judgeWeighed(exact, kg('15.001'), money(48_198n))).toBe('ABOVE');
  });

  it('rounds a limit that is not a whole gram inward: 12.345 kg at 2.5 percent is 12.037 to 12.653 kg', () => {
    // 12.345 x 0.975 = 12.036375 (the least allowed is 12.037), 12.345 x 1.025 = 12.653625 (the most allowed is 12.653)
    const odd = { weight: kg('12.345'), tolerance: Rate.parsePercent('2.5'), estimatedTotal: money(34_566n) };
    expect(toleranceLimits(odd).minimum).toEqual(kg('12.037'));
    expect(toleranceLimits(odd).maximum).toEqual(kg('12.653'));
    expect(judgeWeighed(odd, kg('12.653'), money(35_428n))).toBe('WITHIN');
    expect(judgeWeighed(odd, kg('12.654'), money(35_431n))).toBe('ABOVE');
    expect(judgeWeighed(odd, kg('12.036'), money(33_701n))).toBe('BELOW');
  });
});

describe('judgePickedQuantity (FR-ORD-009, CR-054): a pick never takes more than its pick list asks', () => {
  it('is COMPLETE at exactly the quantity to pick, SHORT below it and OVER above it', () => {
    expect(judgePickedQuantity(q('2.000'), q('2.000'))).toBe('COMPLETE');
    expect(judgePickedQuantity(q('2.000'), q('1.999'))).toBe('SHORT');
    expect(judgePickedQuantity(q('2.000'), q('0.000'))).toBe('SHORT');
    expect(judgePickedQuantity(q('2.000'), q('2.001'))).toBe('OVER');
  });
});

describe('pickWeightSource: a line’s weight is as trusted as its least trusted pack', () => {
  it('is SCALE only when every pack was weighed on the scale, ESTIMATE when any was estimated, else MANUAL', () => {
    expect(pickWeightSource(['SCALE', 'SCALE'])).toBe('SCALE');
    expect(pickWeightSource(['SCALE', 'MANUAL'])).toBe('MANUAL');
    expect(pickWeightSource(['MANUAL', 'ESTIMATE', 'SCALE'])).toBe('ESTIMATE');
    expect(pickWeightSource([])).toBeNull();
  });
});

describe('readyToPack (FR-ORD-011, FR-ORD-010, CR-054): every line picked, short only with agreement, above only with consent', () => {
  const line = (over: Partial<Parameters<typeof readyToPack>[0][number]> = {}) => ({ lineNo: 1, catchWeight: false, toPick: q('2.000'), picked: q('2.000'), agreedShort: null, tolerance: null, consentedAbove: false, ...over });

  it('packs a pick list whose every line is picked in full', () => {
    expect(readyToPack([line(), line({ lineNo: 2 })])).toEqual({ ok: true, value: null });
  });

  it('refuses a line picked short with no agreement, naming it', () => {
    expect(readyToPack([line(), line({ lineNo: 2, picked: q('1.000') })])).toEqual({ ok: false, error: [{ lineNo: 2, rule: 'SHORT_PICK_NOT_AGREED' }] });
  });

  it('packs a short line at exactly the quantity the customer agreed to, and refuses any other', () => {
    expect(readyToPack([line({ picked: q('1.000'), agreedShort: q('1.000') })]).ok).toBe(true);
    expect(readyToPack([line({ picked: q('0.000'), agreedShort: q('1.000') })])).toEqual({ ok: false, error: [{ lineNo: 1, rule: 'SHORT_PICK_NOT_AGREED' }] });
  });

  it('refuses a catch-weight line with nothing picked, and one above its tolerance without the customer’s consent', () => {
    expect(readyToPack([line({ catchWeight: true, picked: q('0.000'), tolerance: 'BELOW' })])).toEqual({ ok: false, error: [{ lineNo: 1, rule: 'NOTHING_PICKED' }] });
    expect(readyToPack([line({ catchWeight: true, tolerance: 'ABOVE' })])).toEqual({ ok: false, error: [{ lineNo: 1, rule: 'TOLERANCE_EXCEEDED' }] });
    expect(readyToPack([line({ catchWeight: true, tolerance: 'ABOVE', consentedAbove: true })]).ok).toBe(true);
  });

  it('packs a catch-weight line below its tolerance at the lower total, and one with fewer packs within it', () => {
    expect(readyToPack([line({ catchWeight: true, picked: q('2.000'), tolerance: 'BELOW' })]).ok).toBe(true);
    expect(readyToPack([line({ catchWeight: true, picked: q('1.000'), tolerance: 'WITHIN' })]).ok).toBe(true);
  });

  it('refuses an empty pick list', () => {
    expect(readyToPack([])).toEqual({ ok: false, error: [{ lineNo: 0, rule: 'NOTHING_PICKED' }] });
  });
});
