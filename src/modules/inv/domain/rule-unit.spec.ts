import { Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { exactlyInRuleUnit, inRuleUnit, wholeUnitsToReach, type RuleScale } from './rule-unit';

const q = (text: string) => Quantity.parse(text);
/** A rule entered in crates of 30: a maximum of 80 crates, stored as 2,400 eggs. */
const crates: RuleScale = { uomQty: q('80.000'), baseQty: q('2400.000') };
/** A unit of two and a half base units (a factor of 5/2), entered as 4 and stored as 10. */
const halves: RuleScale = { uomQty: q('4.000'), baseQty: q('10.000') };

const split = (base: string, scale: RuleScale) => {
  const answer = inRuleUnit(q(base), scale);
  return [answer.whole.toDecimalString(), answer.loose.toDecimalString()];
};

describe('a reorder level answered in the rule\'s selling unit (B09e continued, the owner\'s decision 6)', () => {
  it('counts 905 eggs as 30 whole crates and 5 loose eggs, never a rounded 30.167 crates', () => {
    expect(split('905.000', crates)).toEqual(['30.000', '5.000']);
    expect(split('900.000', crates)).toEqual(['30.000', '0.000']);
    expect(split('899.000', crates)).toEqual(['29.000', '29.000']);
    expect(split('0.000', crates)).toEqual(['0.000', '0.000']);
  });

  it('counts a negative balance toward zero, the loose part carrying the sign', () => {
    expect(split('-5.000', crates)).toEqual(['0.000', '-5.000']);
    expect(split('-35.000', crates)).toEqual(['-1.000', '-5.000']);
  });

  it('keeps the loose part exact for a factor that is not whole', () => {
    expect(split('7.500', halves)).toEqual(['3.000', '0.000']);
    expect(split('8.000', halves)).toEqual(['3.000', '0.500']);
  });

  it('suggests whole crates rounded up, so the order reaches the maximum: 1,495 eggs short is 50 crates', () => {
    expect(wholeUnitsToReach(q('1495.000'), crates).toDecimalString()).toBe('50.000');
    expect(wholeUnitsToReach(q('1500.000'), crates).toDecimalString()).toBe('50.000');
    expect(wholeUnitsToReach(q('1501.000'), crates).toDecimalString()).toBe('51.000');
    expect(wholeUnitsToReach(q('0.001'), crates).toDecimalString()).toBe('1.000');
    expect(wholeUnitsToReach(q('0.000'), crates).toDecimalString()).toBe('0.000');
    expect(wholeUnitsToReach(q('7.501'), halves).toDecimalString()).toBe('4.000');
  });

  it('gives a level back in the unit it was entered in, exactly, and nothing for one that is not a whole thousandth of it', () => {
    expect(exactlyInRuleUnit(q('900.000'), crates)?.toDecimalString()).toBe('30.000');
    expect(exactlyInRuleUnit(q('915.000'), crates)?.toDecimalString()).toBe('30.500');
    expect(exactlyInRuleUnit(q('901.000'), crates)).toBeNull();
    expect(exactlyInRuleUnit(q('0.000'), crates)?.toDecimalString()).toBe('0.000');
  });

  it('refuses a scale whose levels are not above zero, which no rule can hold', () => {
    expect(() => inRuleUnit(q('1.000'), { uomQty: q('0.000'), baseQty: q('0.000') })).toThrow(/above zero/);
    expect(() => wholeUnitsToReach(q('1.000'), { uomQty: q('1.000'), baseQty: q('0.000') })).toThrow(/above zero/);
    expect(() => exactlyInRuleUnit(q('1.000'), { uomQty: q('-1.000'), baseQty: q('1.000') })).toThrow(/above zero/);
  });
});
