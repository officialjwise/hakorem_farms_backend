import { Money, Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { splitEvenly, unitCost, valueLines } from './pool-lines';

const q = (text: string) => Quantity.parse(text);
const pesewas = (n: bigint) => Money.ofPesewas(n);

describe('the value at cost of the lines of one pool (CR-001, FR-INV-003)', () => {
  it('splits a pool of 100,001 over three locations of 1 unit each as 33,334, 33,334 and 33,333, summing exactly', () => {
    const parts = valueLines({ qty: q('3'), value: pesewas(100_001n) }, [
      { key: 1n, qty: q('1') },
      { key: 2n, qty: q('1') },
      { key: 3n, qty: q('1') },
    ]);
    expect(parts.map((p) => p.pesewas)).toEqual([33_334n, 33_334n, 33_333n]);
  });

  it('weights lines by quantity to the thousandth: 12.500 kg and 2.500 kg of a 15.000 kg lot valued 99,999', () => {
    const parts = valueLines({ qty: q('15'), value: pesewas(99_999n) }, [
      { key: 1n, qty: q('12.5') },
      { key: 2n, qty: q('2.5') },
    ]);
    expect(parts.map((p) => p.pesewas)).toEqual([83_333n, 16_666n]);
    expect(parts[0]!.pesewas + parts[1]!.pesewas).toBe(99_999n);
  });

  it('gives a negative line (an offline sale past zero) no value, and the positive lines the whole pool', () => {
    const parts = valueLines({ qty: q('3'), value: pesewas(10_500n) }, [
      { key: 1n, qty: q('5') },
      { key: 2n, qty: q('-2') },
    ]);
    expect(parts.map((p) => p.pesewas)).toEqual([10_500n, 0n]);
  });

  it('values every line at zero when the pool has no value or no line holds stock', () => {
    expect(valueLines({ qty: q('3'), value: pesewas(0n) }, [{ key: 1n, qty: q('3') }]).map((p) => p.pesewas)).toEqual([0n]);
    expect(valueLines({ qty: q('0'), value: pesewas(0n) }, [{ key: 1n, qty: q('0') }, { key: 2n, qty: q('-1') }]).map((p) => p.pesewas)).toEqual([0n, 0n]);
  });

  it('refuses two lines with one key, which is a bug in the caller', () => {
    expect(() => valueLines({ qty: q('2'), value: pesewas(5n) }, [{ key: 1n, qty: q('1') }, { key: 1n, qty: q('1') }])).toThrow();
  });

  it('returns no parts for no lines', () => {
    expect(valueLines({ qty: q('1'), value: pesewas(5n) }, [])).toEqual([]);
  });
});

describe('unit cost for display (CR-001)', () => {
  it('rounds an exact half pesewa up: 7 over 2 units is 4', () => {
    expect(unitCost({ qty: q('2'), value: pesewas(7n) }).pesewas).toBe(4n);
  });
  it('rounds one below half down: 100,001 over 3 units is 33,334 and 10 over 3 is 3', () => {
    expect(unitCost({ qty: q('3'), value: pesewas(100_001n) }).pesewas).toBe(33_334n);
    expect(unitCost({ qty: q('3'), value: pesewas(10n) }).pesewas).toBe(3n);
  });
  it('is per base unit for a fraction: 5,500 over 0.500 kg is 11,000 a kg', () => {
    expect(unitCost({ qty: q('0.5'), value: pesewas(5_500n) }).pesewas).toBe(11_000n);
  });
  it('is zero for an empty or negative pool', () => {
    expect(unitCost({ qty: q('0'), value: pesewas(0n) }).pesewas).toBe(0n);
    expect(unitCost({ qty: q('-2'), value: pesewas(0n) }).pesewas).toBe(0n);
  });
  it('holds the maximum pool value exactly over one unit', () => {
    expect(unitCost({ qty: q('1'), value: pesewas(9_007_199_254_740_991n) }).pesewas).toBe(9_007_199_254_740_991n);
  });
});

describe('a receipt value spread over the animals of one line (FR-INV-009, FR-INV-018)', () => {
  it('splits 100,001 over three goats as 33,334, 33,334 and 33,333 in tag order', () => {
    expect(splitEvenly(pesewas(100_001n), 3).map((p) => p.pesewas)).toEqual([33_334n, 33_334n, 33_333n]);
  });
  it('splits 110,000 over twenty animals as 5,500 each', () => {
    const parts = splitEvenly(pesewas(110_000n), 20);
    expect(new Set(parts.map((p) => p.pesewas))).toEqual(new Set([5_500n]));
    expect(parts).toHaveLength(20);
  });
  it('gives nothing to anyone from a zero value, and refuses no animals', () => {
    expect(splitEvenly(pesewas(0n), 2).map((p) => p.pesewas)).toEqual([0n, 0n]);
    expect(() => splitEvenly(pesewas(10n), 0)).toThrow('at least one part');
  });
});
