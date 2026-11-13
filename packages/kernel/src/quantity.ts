import { formatFixed, parseFixed } from './decimal-string';
import { QuantityRangeError } from './kernel-error';

/** NUMERIC(14,3): 99,999,999,999.999 is the largest magnitude, as thousandths. */
const MAX_THOUSANDTHS = 99_999_999_999_999n;
const THOUSANDTHS_PER_UNIT = 1_000n;
const QUANTITY_DECIMAL_PLACES = 3;

/**
 * A quantity of a unit of measure, held as exact integer thousandths to match `NUMERIC(14,3)` (ADR-0001).
 * Signed, because a stock balance may go negative through a movement type allowed to (ADR-0002).
 * A line or movement quantity that must be positive is checked by the domain rule that uses it.
 */
export class Quantity {
  private constructor(readonly thousandths: bigint) {}

  static ofThousandths(thousandths: bigint): Quantity {
    if (thousandths > MAX_THOUSANDTHS || thousandths < -MAX_THOUSANDTHS) {
      throw new QuantityRangeError(thousandths);
    }
    return new Quantity(thousandths);
  }

  static ofUnits(units: bigint): Quantity {
    return Quantity.ofThousandths(units * THOUSANDTHS_PER_UNIT);
  }

  static zero(): Quantity {
    return new Quantity(0n);
  }

  /** Reads a decimal string with at most three places, optionally negative. More places are refused. */
  static parse(text: string): Quantity {
    return Quantity.ofThousandths(parseFixed(text, QUANTITY_DECIMAL_PLACES, 'quantity', true));
  }

  static sum(quantities: readonly Quantity[]): Quantity {
    return Quantity.ofThousandths(quantities.reduce((total, q) => total + q.thousandths, 0n));
  }

  plus(other: Quantity): Quantity {
    return Quantity.ofThousandths(this.thousandths + other.thousandths);
  }

  minus(other: Quantity): Quantity {
    return Quantity.ofThousandths(this.thousandths - other.thousandths);
  }

  negated(): Quantity {
    return Quantity.ofThousandths(-this.thousandths);
  }

  isZero(): boolean {
    return this.thousandths === 0n;
  }

  isNegative(): boolean {
    return this.thousandths < 0n;
  }

  equals(other: Quantity): boolean {
    return this.thousandths === other.thousandths;
  }

  compareTo(other: Quantity): -1 | 0 | 1 {
    if (this.thousandths === other.thousandths) {
      return 0;
    }
    return this.thousandths > other.thousandths ? 1 : -1;
  }

  /** Exactly three decimal places, with a leading minus when negative: the API's quantity format. */
  toDecimalString(): string {
    return formatFixed(this.thousandths, QUANTITY_DECIMAL_PLACES);
  }
}
