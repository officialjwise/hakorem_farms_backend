import { describe, expect, it } from 'vitest';
import { DecimalFormatError, QuantityRangeError } from './kernel-error';
import { Quantity } from './quantity';

// NUMERIC(14,3): at most 99,999,999,999.999, held inside the kernel as integer thousandths.
// A quantity is signed because a stock balance may go negative through an allowed movement type (ADR-0002).
const MAX_THOUSANDTHS = 99_999_999_999_999n;

describe('Quantity', () => {
  describe('parsing', () => {
    it('reads three decimal places as exact thousandths', () => {
      expect(Quantity.parse('1.500').thousandths).toBe(1_500n);
    });

    it('reads whole numbers and fewer places exactly', () => {
      expect(Quantity.parse('12').thousandths).toBe(12_000n);
      expect(Quantity.parse('0.5').thousandths).toBe(500n);
    });

    it('reads a negative quantity', () => {
      expect(Quantity.parse('-2.250').thousandths).toBe(-2_250n);
      expect(Quantity.parse('-2.250').isNegative()).toBe(true);
      expect(Quantity.parse('2.250').isNegative()).toBe(false);
    });

    it('reads negative zero as zero', () => {
      expect(Quantity.parse('-0.000').thousandths).toBe(0n);
      expect(Quantity.parse('-0').isZero()).toBe(true);
      expect(Quantity.parse('-0').isNegative()).toBe(false);
    });

    it('reads the maximum and the minimum exactly', () => {
      expect(Quantity.parse('99999999999.999').thousandths).toBe(MAX_THOUSANDTHS);
      expect(Quantity.parse('-99999999999.999').thousandths).toBe(-MAX_THOUSANDTHS);
    });

    it('refuses one thousandth beyond either end with a typed error', () => {
      expect(() => Quantity.parse('100000000000.000')).toThrow(QuantityRangeError);
      expect(() => Quantity.parse('-100000000000.000')).toThrow(QuantityRangeError);
    });

    it('refuses a fourth decimal place instead of rounding silently', () => {
      expect(() => Quantity.parse('1.0005')).toThrow(DecimalFormatError);
    });

    it('refuses text that is not a decimal', () => {
      for (const bad of ['', '1.', '.5', '--1', '1,000', 'one', '+1', '1e2']) {
        expect(() => Quantity.parse(bad), bad).toThrow(DecimalFormatError);
      }
    });
  });

  describe('construction', () => {
    it('builds whole units', () => {
      expect(Quantity.ofUnits(30n).toDecimalString()).toBe('30.000');
    });

    it('builds from thousandths', () => {
      expect(Quantity.ofThousandths(1n).toDecimalString()).toBe('0.001');
    });

    it('refuses thousandths beyond the range', () => {
      expect(() => Quantity.ofThousandths(MAX_THOUSANDTHS + 1n)).toThrow(QuantityRangeError);
      expect(() => Quantity.ofThousandths(-MAX_THOUSANDTHS - 1n)).toThrow(QuantityRangeError);
    });

    it('has a zero', () => {
      expect(Quantity.zero().isZero()).toBe(true);
      expect(Quantity.ofUnits(1n).isZero()).toBe(false);
    });
  });

  describe('arithmetic', () => {
    it('adds exactly', () => {
      expect(Quantity.parse('1.250').plus(Quantity.parse('0.750')).toDecimalString()).toBe('2.000');
    });

    it('subtracts below zero, because a balance may go negative', () => {
      expect(Quantity.parse('1.000').minus(Quantity.parse('3.000')).toDecimalString()).toBe('-2.000');
    });

    it('negates', () => {
      expect(Quantity.parse('4.500').negated().toDecimalString()).toBe('-4.500');
      expect(Quantity.zero().negated().toDecimalString()).toBe('0.000');
    });

    it('refuses an addition beyond the range', () => {
      expect(() => Quantity.ofThousandths(MAX_THOUSANDTHS).plus(Quantity.ofThousandths(1n))).toThrow(QuantityRangeError);
    });

    it('refuses a subtraction beyond the range', () => {
      expect(() => Quantity.ofThousandths(-MAX_THOUSANDTHS).minus(Quantity.ofThousandths(1n))).toThrow(QuantityRangeError);
    });

    it('sums a list exactly', () => {
      expect(Quantity.sum([Quantity.parse('0.333'), Quantity.parse('0.333'), Quantity.parse('0.334')]).toDecimalString()).toBe('1.000');
      expect(Quantity.sum([]).isZero()).toBe(true);
    });
  });

  describe('comparison and display', () => {
    it('compares by value', () => {
      const a = Quantity.parse('2.000');
      expect(a.equals(Quantity.ofUnits(2n))).toBe(true);
      expect(a.equals(Quantity.parse('2.001'))).toBe(false);
      expect(a.compareTo(Quantity.parse('1.999'))).toBe(1);
      expect(a.compareTo(Quantity.parse('2'))).toBe(0);
      expect(a.compareTo(Quantity.parse('2.001'))).toBe(-1);
    });

    it('writes exactly three decimal places with a sign when negative', () => {
      expect(Quantity.zero().toDecimalString()).toBe('0.000');
      expect(Quantity.parse('-0.005').toDecimalString()).toBe('-0.005');
      expect(Quantity.ofThousandths(MAX_THOUSANDTHS).toDecimalString()).toBe('99999999999.999');
    });
  });
});
