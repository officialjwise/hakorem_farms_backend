import { describe, expect, it } from 'vitest';
import { allocate } from './allocate';
import { AllocationError } from './kernel-error';
import { Money } from './money';

const MAX = 9_007_199_254_740_991n;

function amounts(result: ReturnType<typeof allocate>): bigint[] {
  if (!result.ok) {
    throw new Error(`expected an allocation, got ${result.error.code}`);
  }
  return result.value.map((m) => m.pesewas);
}

function sum(values: bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n);
}

describe('allocate', () => {
  describe('ADR-0028 tests 1, 2 and 4', () => {
    it('allocates an awkward amount across three investors without creating or losing a pesewa', () => {
      // Distributable 1,000,001 pesewas (GHS 10,000.01); unit-days 90,000, 22,500 and 30,250 (total 142,750).
      // Exact shares 630,473.485..., 157,618.371..., 211,909.143...; floors 630,473 + 157,618 + 211,909 = 1,000,000.
      // Remainders (of 142,750): 69,250, 53,000, 20,500. The one leftover pesewa goes to investor 001.
      const result = amounts(
        allocate(Money.ofPesewas(1_000_001n), [
          { key: 1n, weight: 90_000n },
          { key: 2n, weight: 22_500n },
          { key: 3n, weight: 30_250n },
        ]),
      );
      expect(result).toEqual([630_474n, 157_618n, 211_909n]);
      expect(sum(result)).toBe(1_000_001n);

      // Rounding each share half-up on its own gives 630,473 + 157,618 + 211,909 = 1,000,000 and loses a pesewa.
      const independentlyRounded = [90_000n, 22_500n, 30_250n].map((w) => (2n * 1_000_001n * w + 142_750n) / (2n * 142_750n));
      expect(sum(independentlyRounded)).toBe(1_000_000n);
      expect(result).not.toEqual(independentlyRounded);
    });

    it('breaks a tie between equal remainders by investor number', () => {
      // 100 / 3 = 33.33 each, equal remainders; the leftover pesewa goes to the lowest key.
      const result = amounts(
        allocate(Money.ofPesewas(100n), [
          { key: 1n, weight: 1n },
          { key: 2n, weight: 1n },
          { key: 3n, weight: 1n },
        ]),
      );
      expect(result).toEqual([34n, 33n, 33n]);
      expect(sum(result)).toBe(100n);
    });

    it('refuses to allocate when all weights are zero', () => {
      const result = allocate(Money.ofPesewas(100n), [
        { key: 1n, weight: 0n },
        { key: 2n, weight: 0n },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AllocationError);
        expect(result.error.code).toBe('ALLOCATION_ALL_WEIGHTS_ZERO');
      }
    });
  });

  describe('largest remainder', () => {
    it('breaks the tie by key, not by position in the list', () => {
      // Same tie as above, listed in reverse: key 1 still receives the extra pesewa.
      const result = amounts(
        allocate(Money.ofPesewas(100n), [
          { key: 3n, weight: 1n },
          { key: 2n, weight: 1n },
          { key: 1n, weight: 1n },
        ]),
      );
      expect(result).toEqual([33n, 33n, 34n]);
    });

    it('gives each leftover pesewa to the next largest remainder', () => {
      // 10 across weights 3, 3, 1 (total 7): exact 4.285, 4.285, 1.428; floors 4, 4, 1 = 9.
      // Remainders 2, 2, 3 (of 7): the one leftover goes to key 3.
      expect(
        amounts(
          allocate(Money.ofPesewas(10n), [
            { key: 1n, weight: 3n },
            { key: 2n, weight: 3n },
            { key: 3n, weight: 1n },
          ]),
        ),
      ).toEqual([4n, 4n, 2n]);
    });

    it('hands out more than one leftover pesewa', () => {
      // 5 across six equal weights: floors 0 each, five leftovers to keys 1 to 5.
      const result = amounts(
        allocate(
          Money.ofPesewas(5n),
          [1n, 2n, 3n, 4n, 5n, 6n].map((key) => ({ key, weight: 1n })),
        ),
      );
      expect(result).toEqual([1n, 1n, 1n, 1n, 1n, 0n]);
      expect(sum(result)).toBe(5n);
    });

    it('splits a GHS 100.00 header discount across three lines exactly', () => {
      // 10,000 across line nets 12,000, 4,500 and 3,500 (total 20,000): exact 6,000, 2,250 and 1,750.
      expect(
        amounts(
          allocate(Money.ofPesewas(10_000n), [
            { key: 1n, weight: 12_000n },
            { key: 2n, weight: 4_500n },
            { key: 3n, weight: 3_500n },
          ]),
        ),
      ).toEqual([6_000n, 2_250n, 1_750n]);
    });

    it('gives a zero weight nothing', () => {
      expect(
        amounts(
          allocate(Money.ofPesewas(7n), [
            { key: 1n, weight: 0n },
            { key: 2n, weight: 2n },
          ]),
        ),
      ).toEqual([0n, 7n]);
    });

    it('allocates zero as zeros', () => {
      expect(
        amounts(
          allocate(Money.zero(), [
            { key: 1n, weight: 5n },
            { key: 2n, weight: 9n },
          ]),
        ),
      ).toEqual([0n, 0n]);
    });

    it('allocates the maximum amount exactly', () => {
      // 9,007,199,254,740,991 across two equal weights: 4,503,599,627,370,496 and 4,503,599,627,370,495.
      const result = amounts(
        allocate(Money.ofPesewas(MAX), [
          { key: 1n, weight: 1n },
          { key: 2n, weight: 1n },
        ]),
      );
      expect(result).toEqual([4_503_599_627_370_496n, 4_503_599_627_370_495n]);
      expect(sum(result)).toBe(MAX);
    });

    it('allocates with weights far larger than the amount', () => {
      // unit-days x 10,000 (ADR-0028) can exceed the amount; 1 pesewa across 900,000,000 and 225,000,000.
      expect(
        amounts(
          allocate(Money.ofPesewas(1n), [
            { key: 1n, weight: 900_000_000n },
            { key: 2n, weight: 225_000_000n },
          ]),
        ),
      ).toEqual([1n, 0n]);
    });
  });

  describe('refusals', () => {
    it('refuses an empty list of parts', () => {
      const result = allocate(Money.ofPesewas(100n), []);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('ALLOCATION_NO_PARTS');
      }
    });

    it('refuses a negative weight', () => {
      const result = allocate(Money.ofPesewas(100n), [
        { key: 1n, weight: 5n },
        { key: 2n, weight: -1n },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('ALLOCATION_NEGATIVE_WEIGHT');
      }
    });

    it('refuses two parts with the same key', () => {
      const result = allocate(Money.ofPesewas(100n), [
        { key: 1n, weight: 5n },
        { key: 1n, weight: 5n },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('ALLOCATION_DUPLICATE_KEY');
      }
    });
  });
});
