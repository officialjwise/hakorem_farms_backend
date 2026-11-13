import { describe, expect, it } from 'vitest';
import { DecimalFormatError, RateRangeError } from './kernel-error';
import { Rate } from './rate';

// A rate is an exact decimal percentage parsed from a string, never from a JavaScript number (ADR-0001).
describe('Rate', () => {
  it('reads a whole percentage as an exact fraction', () => {
    // 15 percent = 15 / 100
    const vat = Rate.parsePercent('15');
    expect(vat.numerator).toBe(15n);
    expect(vat.denominator).toBe(100n);
  });

  it('reads a fractional percentage exactly', () => {
    // 2.5 percent = 25 / 1,000
    const nhil = Rate.parsePercent('2.5');
    expect(nhil.numerator).toBe(25n);
    expect(nhil.denominator).toBe(1_000n);
  });

  it('reads up to six decimal places', () => {
    // 12.345678 percent = 12,345,678 / 100,000,000
    const r = Rate.parsePercent('12.345678');
    expect(r.numerator).toBe(12_345_678n);
    expect(r.denominator).toBe(100_000_000n);
  });

  it('reads zero and one hundred percent', () => {
    expect(Rate.parsePercent('0').numerator).toBe(0n);
    expect(Rate.parsePercent('0').isZero()).toBe(true);
    expect(Rate.parsePercent('100').isZero()).toBe(false);
    // 100.000000 percent reduces to 100 / 100, exactly one
    const whole = Rate.parsePercent('100.000000');
    expect(whole.numerator).toBe(100n);
    expect(whole.denominator).toBe(100n);
  });

  it('refuses a percentage above one hundred', () => {
    expect(() => Rate.parsePercent('100.000001')).toThrow(RateRangeError);
    expect(() => Rate.parsePercent('150')).toThrow(RateRangeError);
  });

  it('refuses a seventh decimal place instead of rounding silently', () => {
    expect(() => Rate.parsePercent('2.5000001')).toThrow(DecimalFormatError);
  });

  it('refuses a negative or malformed percentage', () => {
    for (const bad of ['-1', '', '15%', '.5', '5.', 'fifteen', '1e1']) {
      expect(() => Rate.parsePercent(bad), bad).toThrow(DecimalFormatError);
    }
  });

  it('writes the percentage back as it was read, without trailing zeros', () => {
    expect(Rate.parsePercent('2.50').toPercentString()).toBe('2.5');
    expect(Rate.parsePercent('15').toPercentString()).toBe('15');
    expect(Rate.parsePercent('0.000').toPercentString()).toBe('0');
    expect(Rate.parsePercent('12.345678').toPercentString()).toBe('12.345678');
  });
});
