import { describe, expect, it } from 'vitest';
import { ArithmeticArgumentError, DecimalFormatError, WeightRangeError } from './kernel-error';
import { Weight } from './weight';

// NUMERIC(10,3) kilograms: at most 9,999,999.999 kg, held inside the kernel as integer grams.
const MAX_GRAMS = 9_999_999_999n;

describe('Weight', () => {
  describe('parsing a kilogram string', () => {
    it('reads three decimal places as exact grams', () => {
      expect(Weight.parseKg('12.345').grams).toBe(12_345n);
    });

    it('reads fewer decimal places exactly', () => {
      expect(Weight.parseKg('15').grams).toBe(15_000n);
      expect(Weight.parseKg('2.5').grams).toBe(2_500n);
      expect(Weight.parseKg('0.05').grams).toBe(50n);
    });

    it('reads zero', () => {
      expect(Weight.parseKg('0').isZero()).toBe(true);
      expect(Weight.parseKg('0.000').isZero()).toBe(true);
      expect(Weight.parseKg('0.001').isZero()).toBe(false);
    });

    it('reads the maximum exactly', () => {
      expect(Weight.parseKg('9999999.999').grams).toBe(MAX_GRAMS);
    });

    it('refuses one gram more than the maximum with a typed error', () => {
      expect(() => Weight.parseKg('10000000.000')).toThrow(WeightRangeError);
    });

    it('refuses a fourth decimal place instead of rounding silently', () => {
      expect(() => Weight.parseKg('1.2345')).toThrow(DecimalFormatError);
    });

    it('refuses a negative weight', () => {
      expect(() => Weight.parseKg('-1.000')).toThrow(DecimalFormatError);
    });

    it('refuses a string longer than forty characters before converting it', () => {
      expect(() => Weight.parseKg(`1.${'0'.repeat(39)}`)).toThrow(DecimalFormatError);
    });

    it('refuses text that is not a decimal', () => {
      for (const bad of ['', ' 1', '1.', '.5', '1,5', '1e3', 'abc', '1.2.3', '+1']) {
        expect(() => Weight.parseKg(bad), bad).toThrow(DecimalFormatError);
      }
    });
  });

  describe('rounding a scale reading to the gram, half-up', () => {
    it('rounds an exact half up to the next gram', () => {
      // 0.0005 kg = 0.5 g -> 1 g
      expect(Weight.roundKg('0.0005').grams).toBe(1n);
    });

    it('one below the half rounds down', () => {
      // 0.0004999 kg = 0.4999 g -> 0 g
      expect(Weight.roundKg('0.0004999').grams).toBe(0n);
    });

    it('one above the half rounds up', () => {
      // 0.0005001 kg = 0.5001 g -> 1 g
      expect(Weight.roundKg('0.0005001').grams).toBe(1n);
    });

    it('zero stays zero', () => {
      expect(Weight.roundKg('0.0000').grams).toBe(0n);
      expect(Weight.roundKg('0').grams).toBe(0n);
    });

    it('leaves a reading of three places or fewer unchanged', () => {
      expect(Weight.roundKg('31.250').grams).toBe(31_250n);
      expect(Weight.roundKg('31.25').grams).toBe(31_250n);
    });

    it('rounds a goat on a platform scale once', () => {
      // 31.2496 kg = 31,249.6 g -> 31,250 g
      expect(Weight.roundKg('31.2496').toKgString()).toBe('31.250');
    });

    it('the maximum is exact', () => {
      // 9,999,999.9994 kg = 9,999,999,999.4 g -> 9,999,999,999 g
      expect(Weight.roundKg('9999999.9994').grams).toBe(MAX_GRAMS);
    });

    it('a reading that rounds past the maximum is a typed error', () => {
      // 9,999,999.9995 kg rounds half-up to 10,000,000.000 kg
      expect(() => Weight.roundKg('9999999.9995')).toThrow(WeightRangeError);
    });

    it('refuses text that is not a decimal', () => {
      expect(() => Weight.roundKg('-0.0005')).toThrow(DecimalFormatError);
      expect(() => Weight.roundKg('heavy')).toThrow(DecimalFormatError);
    });
  });

  describe('grams', () => {
    it('builds from exact grams', () => {
      expect(Weight.ofGrams(15_000n).toKgString()).toBe('15.000');
    });

    it('refuses negative grams', () => {
      expect(() => Weight.ofGrams(-1n)).toThrow(WeightRangeError);
    });

    it('refuses grams above the maximum', () => {
      expect(() => Weight.ofGrams(MAX_GRAMS + 1n)).toThrow(WeightRangeError);
    });
  });

  describe('arithmetic', () => {
    it('adds exactly', () => {
      expect(Weight.parseKg('14.875').plus(Weight.parseKg('0.125')).toKgString()).toBe('15.000');
    });

    it('refuses an addition past the maximum', () => {
      expect(() => Weight.ofGrams(MAX_GRAMS).plus(Weight.ofGrams(1n))).toThrow(WeightRangeError);
    });

    it('subtracts exactly', () => {
      expect(Weight.parseKg('31.250').minus(Weight.parseKg('12.345')).toKgString()).toBe('18.905');
    });

    it('refuses a subtraction below zero', () => {
      expect(() => Weight.parseKg('1.000').minus(Weight.parseKg('1.001'))).toThrow(WeightRangeError);
    });

    it('sums a list exactly', () => {
      const packs = [Weight.parseKg('15.010'), Weight.parseKg('14.990'), Weight.parseKg('15.000')];
      expect(Weight.sum(packs).toKgString()).toBe('45.000');
      expect(Weight.sum([]).isZero()).toBe(true);
    });
  });

  describe('dividing into equal parts, rounded half-up to the gram once', () => {
    it('divides exactly when it can', () => {
      // 45.000 kg / 3 = 15.000 kg
      expect(Weight.parseKg('45.000').dividedBy(3n).toKgString()).toBe('15.000');
    });

    it('rounds an exact half up to the next gram', () => {
      // 0.005 kg / 2 = 2.5 g -> 3 g
      expect(Weight.parseKg('0.005').dividedBy(2n).grams).toBe(3n);
    });

    it('one below the half rounds down', () => {
      // 0.499 kg / 1,000 = 0.499 g -> 0 g
      expect(Weight.parseKg('0.499').dividedBy(1_000n).grams).toBe(0n);
    });

    it('one above the half rounds up', () => {
      // 0.501 kg / 1,000 = 0.501 g -> 1 g
      expect(Weight.parseKg('0.501').dividedBy(1_000n).grams).toBe(1n);
    });

    it('divides a pen weight across its animals', () => {
      // 10.000 kg / 3 = 3,333.33 g -> 3,333 g; 20.000 kg / 3 = 6,666.67 g -> 6,667 g
      expect(Weight.parseKg('10.000').dividedBy(3n).grams).toBe(3_333n);
      expect(Weight.parseKg('20.000').dividedBy(3n).grams).toBe(6_667n);
    });

    it('zero stays zero', () => {
      expect(Weight.zero().dividedBy(7n).grams).toBe(0n);
    });

    it('the maximum is exact', () => {
      expect(Weight.ofGrams(MAX_GRAMS).dividedBy(1n).grams).toBe(MAX_GRAMS);
    });

    it('refuses to divide by zero or a negative count', () => {
      expect(() => Weight.parseKg('1.000').dividedBy(0n)).toThrow(ArithmeticArgumentError);
      expect(() => Weight.parseKg('1.000').dividedBy(-2n)).toThrow(ArithmeticArgumentError);
    });
  });

  describe('comparison and display', () => {
    it('compares by value', () => {
      const a = Weight.parseKg('2.500');
      expect(a.equals(Weight.ofGrams(2_500n))).toBe(true);
      expect(a.equals(Weight.ofGrams(2_501n))).toBe(false);
      expect(a.compareTo(Weight.ofGrams(2_499n))).toBe(1);
      expect(a.compareTo(Weight.ofGrams(2_500n))).toBe(0);
      expect(a.compareTo(Weight.ofGrams(2_501n))).toBe(-1);
    });

    it('writes kilograms with exactly three decimal places', () => {
      expect(Weight.zero().toKgString()).toBe('0.000');
      expect(Weight.ofGrams(7n).toKgString()).toBe('0.007');
      expect(Weight.ofGrams(MAX_GRAMS).toKgString()).toBe('9999999.999');
    });
  });
});
