import { ArithmeticArgumentError } from './kernel-error';

/**
 * The one rounding rule (ADR-0001): half_up(n / d) = (2n + d) div 2d, for n >= 0 and d > 0.
 * Amounts are never negative, so half-up and half-away-from-zero are the same rule.
 */
export function halfUpDivide(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new ArithmeticArgumentError();
  }
  return (2n * numerator + denominator) / (2n * denominator);
}
