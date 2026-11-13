import { formatFixed, parseFixed, parseRoundedHalfUp } from './decimal-string';
import { halfUpDivide } from './half-up';
import { WeightRangeError } from './kernel-error';

/** NUMERIC(10,3) kilograms: 9,999,999.999 kg is the largest weight, as grams. */
const MAX_GRAMS = 9_999_999_999n;
const KG_DECIMAL_PLACES = 3;

/**
 * A non-negative weight in kilograms, held as exact integer grams to match `NUMERIC(10,3)` (ADR-0001).
 * The capture source (scale, manual, estimate) belongs to the record that holds the weight, not to this value.
 */
export class Weight {
  private constructor(readonly grams: bigint) {}

  static ofGrams(grams: bigint): Weight {
    if (grams < 0n || grams > MAX_GRAMS) {
      throw new WeightRangeError(grams);
    }
    return new Weight(grams);
  }

  static zero(): Weight {
    return new Weight(0n);
  }

  /** Reads a kilogram string with at most three decimal places. More places are refused, never rounded. */
  static parseKg(text: string): Weight {
    return Weight.ofGrams(parseFixed(text, KG_DECIMAL_PLACES, 'weight', false));
  }

  /** Reads a scale reading of any precision and rounds it half-up, once, to the gram. */
  static roundKg(text: string): Weight {
    return Weight.ofGrams(parseRoundedHalfUp(text, KG_DECIMAL_PLACES, 'weight'));
  }

  static sum(weights: readonly Weight[]): Weight {
    return Weight.ofGrams(weights.reduce((total, weight) => total + weight.grams, 0n));
  }

  plus(other: Weight): Weight {
    return Weight.ofGrams(this.grams + other.grams);
  }

  minus(other: Weight): Weight {
    return Weight.ofGrams(this.grams - other.grams);
  }

  /** One of `count` equal parts, rounded half-up once to the gram (an average weight per head). */
  dividedBy(count: bigint): Weight {
    return Weight.ofGrams(halfUpDivide(this.grams, count));
  }

  isZero(): boolean {
    return this.grams === 0n;
  }

  equals(other: Weight): boolean {
    return this.grams === other.grams;
  }

  compareTo(other: Weight): -1 | 0 | 1 {
    if (this.grams === other.grams) {
      return 0;
    }
    return this.grams > other.grams ? 1 : -1;
  }

  /** Kilograms with exactly three decimal places, the API's weight format. */
  toKgString(): string {
    return formatFixed(this.grams, KG_DECIMAL_PLACES);
  }
}
