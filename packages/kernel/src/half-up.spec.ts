import { describe, expect, it } from 'vitest';
import { ArithmeticArgumentError } from './kernel-error';
import { halfUpDivide } from './half-up';

// ADR-0001: half_up(n / d) for non-negative integers is (2n + d) div 2d.
describe('halfUpDivide', () => {
  it('rounds an exact half up to the next whole number', () => {
    // 5 / 2 = 2.5 -> 3
    expect(halfUpDivide(5n, 2n)).toBe(3n);
  });

  it('rounds one below the half down', () => {
    // 499 / 1000 = 0.499 -> 0
    expect(halfUpDivide(499n, 1000n)).toBe(0n);
  });

  it('rounds one above the half up', () => {
    // 501 / 1000 = 0.501 -> 1
    expect(halfUpDivide(501n, 1000n)).toBe(1n);
  });

  it('keeps zero at zero', () => {
    // 0 / 7 = 0
    expect(halfUpDivide(0n, 7n)).toBe(0n);
  });

  it('returns an exact quotient unchanged', () => {
    // 3000 / 1000 = 3 exactly
    expect(halfUpDivide(3000n, 1000n)).toBe(3n);
  });

  it('is exact at the maximum safe integer', () => {
    // 9,007,199,254,740,991 / 1 is itself; 18,014,398,509,481,982 / 2 is the maximum again
    expect(halfUpDivide(9_007_199_254_740_991n, 1n)).toBe(9_007_199_254_740_991n);
    expect(halfUpDivide(18_014_398_509_481_982n, 2n)).toBe(9_007_199_254_740_991n);
  });

  it('refuses a negative numerator', () => {
    expect(() => halfUpDivide(-1n, 2n)).toThrow(ArithmeticArgumentError);
  });

  it('refuses a zero denominator', () => {
    expect(() => halfUpDivide(1n, 0n)).toThrow(ArithmeticArgumentError);
  });

  it('refuses a negative denominator', () => {
    expect(() => halfUpDivide(1n, -2n)).toThrow(ArithmeticArgumentError);
  });
});
