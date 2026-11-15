import { Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { expectedConsumption } from './feed';

describe('expected consumption from a ration (FR-LIV-014)', () => {
  it('expects 8.400 kg from 0.120 kg per head per day for 10 broilers over 7 days', () => {
    expect(expectedConsumption(Quantity.parse('0.120'), 70n).toDecimalString()).toBe('8.400');
  });

  it('expects nothing over no head-days', () => {
    expect(expectedConsumption(Quantity.parse('1.500'), 0n).toDecimalString()).toBe('0.000');
  });
});
