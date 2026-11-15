import { Money, Weight } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { allocateProcessingCost, allocationWeightOf, type AllocationOutput } from './cost-allocation';

const out = (lineNo: number, kind: AllocationOutput['kind'], kg: string, pricePerKg: bigint): AllocationOutput => ({
  lineNo,
  kind,
  weight: Weight.parseKg(kg),
  referencePricePerKg: Money.ofPesewas(pricePerKg),
});

function allocated(total: bigint, outputs: readonly AllocationOutput[]): bigint[] {
  const result = allocateProcessingCost(Money.ofPesewas(total), outputs);
  if (!result.ok) throw new Error(`refused: ${result.error.map((r) => r.rule).join(', ')}`);
  return result.value.map((line) => line.allocated.pesewas);
}

const sum = (parts: readonly bigint[]) => parts.reduce((a, b) => a + b, 0n);

describe('cost allocation by relative sales value (FR-PRC-007, FR-PRC-008, ADR-0018)', () => {
  it('weighs an output by its grams times its reference price per kilogram, and waste by zero', () => {
    expect(allocationWeightOf(out(1, 'MEAT', '14.000', 4_000n))).toBe(56_000_000n);
    expect(allocationWeightOf(out(2, 'OFFAL', '3.000', 1_500n))).toBe(4_500_000n);
    expect(allocationWeightOf(out(4, 'WASTE', '9.000', 0n))).toBe(0n);
  });

  it('allocates 76,400 pesewas to meat, offal and by-products as 69,568, 5,590 and 1,242, and nothing to waste', () => {
    const parts = allocated(76_400n, [out(1, 'MEAT', '14.000', 4_000n), out(2, 'OFFAL', '3.000', 1_500n), out(3, 'BY_PRODUCT', '2.000', 500n), out(4, 'WASTE', '9.000', 0n)]);
    expect(parts).toEqual([69_568n, 5_590n, 1_242n, 0n]);
    expect(sum(parts)).toBe(76_400n);
  });

  it('splits a goat of 66,100 plus 6,000 direct cost into 64,035 for meat and 8,065 for offal, exactly 72,100', () => {
    const parts = allocated(72_100n, [out(1, 'MEAT', '14.200', 2_600n), out(2, 'OFFAL', '3.100', 1_500n), out(3, 'WASTE', '8.950', 0n)]);
    expect(parts).toEqual([64_035n, 8_065n, 0n]);
    expect(sum(parts)).toBe(72_100n);
  });

  it('gives the leftover pesewa of an awkward split to the largest remainder, not to the last line', () => {
    // 10,001 over weights 1 : 1 : 1 is 3,333.67 each; the floors leave 2 pesewas, which go to lines 1 and 2 (ties, lowest first).
    const parts = allocated(10_001n, [out(1, 'MEAT', '1.000', 100n), out(2, 'OFFAL', '1.000', 100n), out(3, 'BY_PRODUCT', '1.000', 100n)]);
    expect(parts).toEqual([3_334n, 3_334n, 3_333n]);
    expect(sum(parts)).toBe(10_001n);
  });

  it('breaks an exact half tie in favour of the lowest output number', () => {
    expect(allocated(3n, [out(2, 'MEAT', '1.000', 100n), out(1, 'OFFAL', '1.000', 100n)])).toEqual([1n, 2n]);
  });

  it('gives a remainder one pesewa below the half to the larger remainder', () => {
    // 100 over 7 : 3 is 70 and 30 exactly; 101 is 70.7 and 30.3, so the one leftover goes to the 0.7.
    expect(allocated(101n, [out(1, 'MEAT', '7.000', 100n), out(2, 'OFFAL', '3.000', 100n)])).toEqual([71n, 30n]);
  });

  it('allocates zero total cost as zero to every output', () => {
    expect(allocated(0n, [out(1, 'MEAT', '14.000', 4_000n), out(2, 'WASTE', '1.000', 0n)])).toEqual([0n, 0n]);
  });

  it('allocates the largest amount of pesewas without losing one', () => {
    const max = Money.MAX_PESEWAS;
    const parts = allocated(max, [out(1, 'MEAT', '9999.999', 9_999n), out(2, 'OFFAL', '0.001', 1n)]);
    expect(sum(parts)).toBe(max);
  });

  it('records each line with its allocation weight, in the order given', () => {
    const result = allocateProcessingCost(Money.ofPesewas(100n), [out(2, 'MEAT', '0.002', 3n), out(1, 'WASTE', '0.500', 0n)]);
    expect(result.ok && result.value.map((l) => [l.lineNo, l.allocationWeight, l.allocated.pesewas])).toEqual([
      [2, 6n, 100n],
      [1, 0n, 0n],
    ]);
  });

  it('refuses outputs that are all waste, since there is nothing to carry the cost', () => {
    const result = allocateProcessingCost(Money.ofPesewas(76_400n), [out(1, 'WASTE', '28.000', 0n)]);
    expect(result).toEqual({ ok: false, error: [{ field: '/outputs', rule: 'NO_SALEABLE_OUTPUT' }] });
  });

  it('refuses an order with no outputs at all', () => {
    expect(allocateProcessingCost(Money.ofPesewas(1n), [])).toEqual({ ok: false, error: [{ field: '/outputs', rule: 'NO_SALEABLE_OUTPUT' }] });
  });

  it('refuses a saleable output without a reference price, and waste with one', () => {
    const result = allocateProcessingCost(Money.ofPesewas(100n), [out(1, 'MEAT', '1.000', 0n), out(2, 'WASTE', '1.000', 5n)]);
    expect(result).toEqual({
      ok: false,
      error: [
        { field: '/outputs/0/referencePricePesewasPerKg', rule: 'REFERENCE_PRICE_MISSING' },
        { field: '/outputs/1/referencePricePesewasPerKg', rule: 'WASTE_CARRIES_NO_PRICE' },
      ],
    });
  });

  it('refuses two outputs with the same line number', () => {
    const result = allocateProcessingCost(Money.ofPesewas(100n), [out(1, 'MEAT', '1.000', 10n), out(1, 'OFFAL', '1.000', 10n)]);
    expect(result).toEqual({ ok: false, error: [{ field: '/outputs/1', rule: 'LINE_NUMBER_REPEATED' }] });
  });
});
