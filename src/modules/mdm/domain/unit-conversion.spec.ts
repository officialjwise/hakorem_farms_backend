import { Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { exactFactor, factorText, fromBase, judgeConversion, MAX_NUMERATOR, toBase, type ConversionContext, type UomFactor } from './unit-conversion';

function factor(numerator: bigint, denominator = 1n): UomFactor {
  const result = exactFactor(numerator, denominator);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.value;
}

const qty = (text: string): Quantity => Quantity.parse(text);

function base(text: string, of: UomFactor): string {
  const result = toBase(qty(text), of);
  return result.ok ? result.value.toDecimalString() : result.error;
}

function alternative(text: string, of: UomFactor): string {
  const result = fromBase(qty(text), of);
  return result.ok ? result.value.toDecimalString() : result.error;
}

describe('unit conversion (FR-MDM-003)', () => {
  it('converts packs and crates exactly and refuses inexact factors', () => {
    // A 15 kg pack at factor 15.000 converts 2 packs to 30.000 kg; a crate of 30 converts 3 crates to 90.000 eggs.
    expect(base('2.000', factor(15n))).toBe('30.000');
    expect(base('3.000', factor(30n))).toBe('90.000');
    // A factor of 0.3333333 is refused: it has no exact value in thousandths of the base unit.
    expect(exactFactor(3_333_333n, 10_000_000n)).toEqual({ ok: false, error: 'INEXACT_FACTOR' });
    expect(exactFactor(1n, 3n)).toEqual({ ok: false, error: 'INEXACT_FACTOR' });
  });

  it('converts a 50 kg bag of feed both ways without rounding', () => {
    const bag = factor(50n);
    expect(base('4.000', bag)).toBe('200.000');
    expect(alternative('200.000', bag)).toBe('4.000');
    expect(alternative('45.000', bag)).toBe('0.900');
  });

  it('keeps a factor in lowest terms, so 60 over 2 is stored as 30 over 1', () => {
    expect(factor(60n, 2n)).toEqual({ numerator: 30n, denominator: 1n });
    expect(factor(250n, 2000n)).toEqual({ numerator: 1n, denominator: 8n });
  });

  it('accepts a factor of exactly three places and states it with three places', () => {
    expect(factorText(factor(1n, 8n))).toBe('0.125');
    expect(factorText(factor(15n))).toBe('15.000');
    expect(factorText(factor(1n, 1000n))).toBe('0.001');
    expect(exactFactor(1n, 2000n)).toEqual({ ok: false, error: 'INEXACT_FACTOR' });
  });

  it('refuses a quantity whose conversion would need a fourth decimal place, rather than rounding it', () => {
    const bunch = factor(1n, 8n); // a bunch of 0.125 kg
    expect(base('0.001', bunch)).toBe('INEXACT_QUANTITY');
    expect(base('0.008', bunch)).toBe('0.001');
    expect(alternative('0.001', factor(3n))).toBe('INEXACT_QUANTITY');
    expect(alternative('0.003', factor(3n))).toBe('0.001');
  });

  it('converts zero to zero', () => {
    expect(base('0.000', factor(30n))).toBe('0.000');
    expect(alternative('0.000', factor(30n))).toBe('0.000');
  });

  it('refuses a factor that is not positive', () => {
    expect(exactFactor(0n, 1n)).toEqual({ ok: false, error: 'NOT_POSITIVE' });
    expect(exactFactor(30n, 0n)).toEqual({ ok: false, error: 'NOT_POSITIVE' });
    expect(exactFactor(-30n, 1n)).toEqual({ ok: false, error: 'NOT_POSITIVE' });
  });

  it('refuses a numerator above the largest one the database holds, after reducing it', () => {
    expect(factor(MAX_NUMERATOR)).toEqual({ numerator: MAX_NUMERATOR, denominator: 1n });
    expect(exactFactor(MAX_NUMERATOR + 1n, 1n)).toEqual({ ok: false, error: 'TOO_LARGE' });
    expect(factor(MAX_NUMERATOR * 2n, 2n)).toEqual({ numerator: MAX_NUMERATOR, denominator: 1n });
  });
});

describe('which unit a product may convert from', () => {
  const feed: ConversionContext = { stockPolicy: 'COUNTABLE', baseUom: 'KG', fromUom: 'BAG', fromKind: 'COUNT' };

  it('allows a counted unit of a countable product, other than its base unit', () => {
    expect(judgeConversion(feed)).toEqual([]);
  });

  it('refuses any conversion for a catch-weight product: the weighed kilograms are charged, never a pack factor', () => {
    expect(judgeConversion({ ...feed, stockPolicy: 'CATCH_WEIGHT', fromUom: 'PACK' })).toEqual([{ field: '/productId', rule: 'NOT_COUNTABLE' }]);
  });

  it('refuses a serialised animal and a service', () => {
    expect(judgeConversion({ ...feed, stockPolicy: 'SERIALISED', baseUom: 'HEAD', fromUom: 'UNIT' })).toEqual([{ field: '/productId', rule: 'NOT_COUNTABLE' }]);
    expect(judgeConversion({ ...feed, stockPolicy: 'NON_STOCK', baseUom: 'UNIT', fromUom: 'PACK' })).toEqual([{ field: '/productId', rule: 'NOT_COUNTABLE' }]);
  });

  it('refuses the base unit itself and a unit that is weighed or measured', () => {
    expect(judgeConversion({ ...feed, fromUom: 'KG', fromKind: 'WEIGHT' })).toEqual([{ field: '/fromUom', rule: 'BASE_UNIT' }]);
    expect(judgeConversion({ ...feed, baseUom: 'BAG', fromUom: 'KG', fromKind: 'WEIGHT' })).toEqual([{ field: '/fromUom', rule: 'NOT_COUNTED' }]);
    expect(judgeConversion({ ...feed, fromUom: 'LITRE', fromKind: 'VOLUME' })).toEqual([{ field: '/fromUom', rule: 'NOT_COUNTED' }]);
  });

  it('names every broken rule at once', () => {
    expect(judgeConversion({ stockPolicy: 'CATCH_WEIGHT', baseUom: 'KG', fromUom: 'KG', fromKind: 'WEIGHT' })).toEqual([
      { field: '/productId', rule: 'NOT_COUNTABLE' },
      { field: '/fromUom', rule: 'BASE_UNIT' },
    ]);
  });
});
