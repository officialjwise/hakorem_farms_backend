import { formatFixed } from './decimal-string';
import { halfUpDivide } from './half-up';
import { MoneyNotIntegerError, MoneyRangeError } from './kernel-error';
import type { Quantity } from './quantity';
import type { Rate } from './rate';
import type { Weight } from './weight';

const MAX_PESEWAS = 9_007_199_254_740_991n;
const THOUSANDTHS_PER_UNIT = 1_000n;
const GRAMS_PER_KG = 1_000n;
const PESEWAS_DECIMAL_PLACES = 2;

/**
 * An amount of Ghana cedis held as an exact, non-negative integer number of pesewas (ADR-0001).
 * Matches the `platform.pesewas` domain: BIGINT from 0 to 9,007,199,254,740,991.
 * Every multiplication rounds half-up exactly once; anything out of range is a typed error.
 */
export class Money {
  static readonly MAX_PESEWAS = MAX_PESEWAS;

  private constructor(readonly pesewas: bigint) {}

  static ofPesewas(pesewas: bigint): Money {
    if (pesewas < 0n || pesewas > MAX_PESEWAS) {
      throw new MoneyRangeError(pesewas);
    }
    return new Money(pesewas);
  }

  static zero(): Money {
    return new Money(0n);
  }

  /** Reads an integer `...Pesewas` field from a parsed JSON body. */
  static fromJsonInteger(value: number): Money {
    if (!Number.isSafeInteger(value)) {
      throw new MoneyNotIntegerError();
    }
    return Money.ofPesewas(BigInt(value));
  }

  static sum(amounts: readonly Money[]): Money {
    return Money.ofPesewas(amounts.reduce((total, amount) => total + amount.pesewas, 0n));
  }

  /** Writes the amount as a JSON integer. Exact, because the range stops at the largest safe integer. */
  toJsonInteger(): number {
    return Number(this.pesewas);
  }

  plus(other: Money): Money {
    return Money.ofPesewas(this.pesewas + other.pesewas);
  }

  minus(other: Money): Money {
    return Money.ofPesewas(this.pesewas - other.pesewas);
  }

  /** A line anchor: this unit price times a quantity, rounded half-up once. */
  timesQuantity(quantity: Quantity): Money {
    return this.timesRatio(quantity.thousandths, THOUSANDTHS_PER_UNIT);
  }

  /** A catch-weight line anchor: this price per kilogram times a weight, rounded half-up once. */
  timesWeight(weight: Weight): Money {
    return this.timesRatio(weight.grams, GRAMS_PER_KG);
  }

  /** A percentage of this amount (a levy, a retention), rounded half-up once. */
  timesRate(rate: Rate): Money {
    return this.timesRatio(rate.numerator, rate.denominator);
  }

  isZero(): boolean {
    return this.pesewas === 0n;
  }

  equals(other: Money): boolean {
    return this.pesewas === other.pesewas;
  }

  compareTo(other: Money): -1 | 0 | 1 {
    if (this.pesewas === other.pesewas) {
      return 0;
    }
    return this.pesewas > other.pesewas ? 1 : -1;
  }

  /** Cedis with exactly two decimal places, for documents and logs. No currency symbol. */
  toDecimalString(): string {
    return formatFixed(this.pesewas, PESEWAS_DECIMAL_PLACES);
  }

  private timesRatio(numerator: bigint, denominator: bigint): Money {
    if (numerator < 0n) {
      throw new MoneyRangeError(this.pesewas * numerator);
    }
    return Money.ofPesewas(halfUpDivide(this.pesewas * numerator, denominator));
  }
}
