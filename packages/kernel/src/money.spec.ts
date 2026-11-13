import { describe, expect, it } from 'vitest';
import { MoneyNotIntegerError, MoneyRangeError } from './kernel-error';
import { Money } from './money';
import { Quantity } from './quantity';
import { Rate } from './rate';
import { Weight } from './weight';

const MAX = 9_007_199_254_740_991n;

describe('Money', () => {
  describe('construction', () => {
    it('holds an exact number of pesewas', () => {
      expect(Money.ofPesewas(1_000_001n).pesewas).toBe(1_000_001n);
    });

    it('has a zero', () => {
      expect(Money.zero().pesewas).toBe(0n);
      expect(Money.zero().isZero()).toBe(true);
      expect(Money.ofPesewas(1n).isZero()).toBe(false);
    });

    it('refuses a negative amount', () => {
      // ADR-0001: amounts are never negative; direction is carried elsewhere
      expect(() => Money.ofPesewas(-1n)).toThrow(MoneyRangeError);
    });

    it('accepts the maximum amount exactly', () => {
      expect(Money.ofPesewas(MAX).pesewas).toBe(MAX);
      expect(Money.MAX_PESEWAS).toBe(MAX);
    });

    it('refuses one more than the maximum with a typed error', () => {
      // 9,007,199,254,740,992 is one above platform.pesewas
      expect(() => Money.ofPesewas(MAX + 1n)).toThrow(MoneyRangeError);
    });

    it('carries a stable error code on a range error', () => {
      try {
        Money.ofPesewas(-5n);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(MoneyRangeError);
        expect((error as MoneyRangeError).code).toBe('MONEY_OUT_OF_RANGE');
      }
    });
  });

  describe('JSON integers at the boundary', () => {
    it('reads a safe non-negative JSON integer', () => {
      expect(Money.fromJsonInteger(25_000).pesewas).toBe(25_000n);
      expect(Money.fromJsonInteger(0).pesewas).toBe(0n);
      expect(Money.fromJsonInteger(Number.MAX_SAFE_INTEGER).pesewas).toBe(MAX);
    });

    it('refuses a JSON number with a fraction', () => {
      expect(() => Money.fromJsonInteger(10.5)).toThrow(MoneyNotIntegerError);
    });

    it('refuses a JSON number above the safe range', () => {
      expect(() => Money.fromJsonInteger(2 ** 53)).toThrow(MoneyNotIntegerError);
    });

    it('refuses NaN and infinity', () => {
      expect(() => Money.fromJsonInteger(Number.NaN)).toThrow(MoneyNotIntegerError);
      expect(() => Money.fromJsonInteger(Number.POSITIVE_INFINITY)).toThrow(MoneyNotIntegerError);
    });

    it('refuses a negative JSON integer', () => {
      expect(() => Money.fromJsonInteger(-1)).toThrow(MoneyRangeError);
    });

    it('writes an exact JSON integer', () => {
      expect(Money.ofPesewas(1_000_001n).toJsonInteger()).toBe(1_000_001);
      expect(Money.ofPesewas(MAX).toJsonInteger()).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('addition and subtraction', () => {
    it('adds exactly', () => {
      expect(Money.ofPesewas(12_050n).plus(Money.ofPesewas(7_950n)).pesewas).toBe(20_000n);
    });

    it('adds to exactly the maximum', () => {
      expect(Money.ofPesewas(MAX - 1n).plus(Money.ofPesewas(1n)).pesewas).toBe(MAX);
    });

    it('refuses an addition past the maximum with a typed error', () => {
      expect(() => Money.ofPesewas(MAX).plus(Money.ofPesewas(1n))).toThrow(MoneyRangeError);
    });

    it('subtracts exactly', () => {
      expect(Money.ofPesewas(20_000n).minus(Money.ofPesewas(7_950n)).pesewas).toBe(12_050n);
    });

    it('subtracts to exactly zero', () => {
      expect(Money.ofPesewas(500n).minus(Money.ofPesewas(500n)).isZero()).toBe(true);
    });

    it('refuses a subtraction below zero with a typed error', () => {
      expect(() => Money.ofPesewas(499n).minus(Money.ofPesewas(500n))).toThrow(MoneyRangeError);
    });

    it('sums a list exactly', () => {
      const parts = [Money.ofPesewas(630_474n), Money.ofPesewas(157_618n), Money.ofPesewas(211_909n)];
      expect(Money.sum(parts).pesewas).toBe(1_000_001n);
    });

    it('sums an empty list to zero', () => {
      expect(Money.sum([]).pesewas).toBe(0n);
    });

    it('refuses a sum past the maximum', () => {
      expect(() => Money.sum([Money.ofPesewas(MAX), Money.ofPesewas(1n)])).toThrow(MoneyRangeError);
    });
  });

  describe('a line: unit price times quantity, rounded half-up once', () => {
    it('rounds an exact half up to the next pesewa', () => {
      // 5 pesewas x 0.500 = 2.5 pesewas -> 3
      expect(Money.ofPesewas(5n).timesQuantity(Quantity.parse('0.500')).pesewas).toBe(3n);
    });

    it('one below the half rounds down', () => {
      // 1 pesewa x 0.499 = 0.499 pesewas -> 0
      expect(Money.ofPesewas(1n).timesQuantity(Quantity.parse('0.499')).pesewas).toBe(0n);
    });

    it('one above the half rounds up', () => {
      // 1 pesewa x 0.501 = 0.501 pesewas -> 1
      expect(Money.ofPesewas(1n).timesQuantity(Quantity.parse('0.501')).pesewas).toBe(1n);
    });

    it('zero stays zero', () => {
      // A line of quantity 0 is 0, and a zero price is 0 for any quantity
      expect(Money.ofPesewas(12_000n).timesQuantity(Quantity.parse('0')).pesewas).toBe(0n);
      expect(Money.zero().timesQuantity(Quantity.parse('7.250')).pesewas).toBe(0n);
    });

    it('the maximum amount is exact', () => {
      // 9,007,199,254,740,991 x 1.000 is itself
      expect(Money.ofPesewas(MAX).timesQuantity(Quantity.parse('1.000')).pesewas).toBe(MAX);
    });

    it('one more than the maximum is a typed error, not a silently wrong number', () => {
      // 9,007,199,254,740,991 x 1.001 overflows platform.pesewas
      expect(() => Money.ofPesewas(MAX).timesQuantity(Quantity.parse('1.001'))).toThrow(MoneyRangeError);
    });

    it('multiplies by a whole quantity exactly', () => {
      // GHS 35.00 per crate x 12 crates = GHS 420.00
      expect(Money.ofPesewas(3_500n).timesQuantity(Quantity.ofUnits(12n)).pesewas).toBe(42_000n);
    });

    it('refuses a negative quantity', () => {
      expect(() => Money.ofPesewas(100n).timesQuantity(Quantity.parse('-1'))).toThrow(MoneyRangeError);
    });
  });

  describe('a catch-weight line: price per kilogram times weight, rounded half-up once', () => {
    it('rounds once at the line anchor, never per kilogram', () => {
      // TEST_STRATEGY section 11: 2.500 kg at 1,001 pesewas per kg = 2,502.5 exactly -> 2,503
      expect(Money.ofPesewas(1_001n).timesWeight(Weight.parseKg('2.500')).pesewas).toBe(2_503n);
    });

    it('rounds an exact half up to the next pesewa', () => {
      // 1 pesewa per kg x 0.500 kg = 0.5 -> 1
      expect(Money.ofPesewas(1n).timesWeight(Weight.parseKg('0.500')).pesewas).toBe(1n);
    });

    it('one below the half rounds down', () => {
      // 1 pesewa per kg x 0.499 kg = 0.499 -> 0
      expect(Money.ofPesewas(1n).timesWeight(Weight.parseKg('0.499')).pesewas).toBe(0n);
    });

    it('one above the half rounds up', () => {
      // 1 pesewa per kg x 0.501 kg = 0.501 -> 1
      expect(Money.ofPesewas(1n).timesWeight(Weight.parseKg('0.501')).pesewas).toBe(1n);
    });

    it('zero stays zero', () => {
      expect(Money.ofPesewas(4_500n).timesWeight(Weight.zero()).pesewas).toBe(0n);
    });

    it('prices a 15 kg beef pack exactly', () => {
      // GHS 43.33 per kg x 15.000 kg = 64,995 pesewas exactly
      expect(Money.ofPesewas(4_333n).timesWeight(Weight.parseKg('15.000')).pesewas).toBe(64_995n);
    });

    it('the maximum amount is exact', () => {
      // 9,007,199,254,740,991 per kg x 1.000 kg is itself
      expect(Money.ofPesewas(MAX).timesWeight(Weight.parseKg('1.000')).pesewas).toBe(MAX);
    });

    it('one more than the maximum is a typed error', () => {
      expect(() => Money.ofPesewas(MAX).timesWeight(Weight.parseKg('1.001'))).toThrow(MoneyRangeError);
    });
  });

  describe('a percentage of an amount, rounded half-up once', () => {
    it('takes an exact percentage', () => {
      // 15 percent of 1,000 = 150
      expect(Money.ofPesewas(1_000n).timesRate(Rate.parsePercent('15')).pesewas).toBe(150n);
    });

    it('rounds an exact half up to the next pesewa', () => {
      // 2.5 percent of 20 = 0.5 -> 1
      expect(Money.ofPesewas(20n).timesRate(Rate.parsePercent('2.5')).pesewas).toBe(1n);
    });

    it('one below the half rounds down', () => {
      // 2.5 percent of 19 = 0.475 -> 0
      expect(Money.ofPesewas(19n).timesRate(Rate.parsePercent('2.5')).pesewas).toBe(0n);
    });

    it('one above the half rounds up', () => {
      // 2.5 percent of 21 = 0.525 -> 1
      expect(Money.ofPesewas(21n).timesRate(Rate.parsePercent('2.5')).pesewas).toBe(1n);
    });

    it('zero stays zero', () => {
      expect(Money.ofPesewas(1_000n).timesRate(Rate.parsePercent('0')).pesewas).toBe(0n);
      expect(Money.zero().timesRate(Rate.parsePercent('15')).pesewas).toBe(0n);
    });

    it('takes the ADR-0028 retention exactly', () => {
      // 40 percent of 1,666,668 = 666,667.2 -> 666,667
      expect(Money.ofPesewas(1_666_668n).timesRate(Rate.parsePercent('40')).pesewas).toBe(666_667n);
    });

    it('the maximum amount is exact at one hundred percent', () => {
      expect(Money.ofPesewas(MAX).timesRate(Rate.parsePercent('100')).pesewas).toBe(MAX);
    });
  });

  describe('comparison and display', () => {
    it('compares by value', () => {
      const a = Money.ofPesewas(100n);
      expect(a.equals(Money.ofPesewas(100n))).toBe(true);
      expect(a.equals(Money.ofPesewas(101n))).toBe(false);
      expect(a.compareTo(Money.ofPesewas(99n))).toBe(1);
      expect(a.compareTo(Money.ofPesewas(100n))).toBe(0);
      expect(a.compareTo(Money.ofPesewas(101n))).toBe(-1);
    });

    it('writes cedis with exactly two decimal places', () => {
      expect(Money.ofPesewas(0n).toDecimalString()).toBe('0.00');
      expect(Money.ofPesewas(5n).toDecimalString()).toBe('0.05');
      expect(Money.ofPesewas(1_000_001n).toDecimalString()).toBe('10000.01');
      expect(Money.ofPesewas(MAX).toDecimalString()).toBe('90071992547409.91');
    });
  });
});
