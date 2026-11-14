import { formatFixed, parseFixed } from './decimal-string';
import { RateRangeError } from './kernel-error';

const RATE_PERCENT_DECIMAL_PLACES = 6;
/** Percent with six places, over one hundred: the denominator of every rate. */
const RATE_DENOMINATOR = 100n * 10n ** BigInt(RATE_PERCENT_DECIMAL_PLACES);
const ONE_HUNDRED_PERCENT = RATE_DENOMINATOR;

/**
 * An exact percentage between 0 and 100, parsed from a decimal string, never from a JavaScript number (ADR-0001).
 * Held as `numerator / denominator`, reduced by powers of ten so that "2.5" is 25 / 1,000.
 */
export class Rate {
  private constructor(
    readonly numerator: bigint,
    readonly denominator: bigint,
  ) {}

  /** Reads a percentage such as "15" or "2.5", with at most six decimal places. */
  static parsePercent(text: string): Rate {
    const scaled = parseFixed(text, RATE_PERCENT_DECIMAL_PLACES, 'rate', false);
    if (scaled > ONE_HUNDRED_PERCENT) {
      throw new RateRangeError();
    }
    let numerator = scaled;
    let denominator = RATE_DENOMINATOR;
    while (denominator > 100n && numerator % 10n === 0n) {
      numerator /= 10n;
      denominator /= 10n;
    }
    return new Rate(numerator, denominator);
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  /** The percentage as the shortest exact decimal string ("2.5", "15", "0"). */
  toPercentString(): string {
    const scaled = this.numerator * (RATE_DENOMINATOR / this.denominator);
    const text = formatFixed(scaled, RATE_PERCENT_DECIMAL_PLACES);
    return text.replace(/\.?0+$/, '');
  }
}
