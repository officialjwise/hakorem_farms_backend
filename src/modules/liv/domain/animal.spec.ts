import { describe, expect, it } from 'vitest';
import { checkWeighing, sourceOfArrival, statusAfterMovement } from './animal';

describe("an animal's status follows its stock unit (FR-LIV-017)", () => {
  it('is SOLD after a sale at the counter or offline, SLAUGHTERED after processing, DEAD or CULLED after a write-off', () => {
    expect(statusAfterMovement('SALE_ISSUE', false)).toBe('SOLD');
    expect(statusAfterMovement('SALE_ISSUE_OFFLINE', false)).toBe('SOLD');
    expect(statusAfterMovement('PROCESS_CONSUME', false)).toBe('SLAUGHTERED');
    expect(statusAfterMovement('MORTALITY', false)).toBe('DEAD');
    expect(statusAfterMovement('CULL', false)).toBe('CULLED');
  });

  it('is DEAD after any other loss written off, which the register has no other word for', () => {
    expect(statusAfterMovement('ADJUST_LOSS', false)).toBe('DEAD');
    expect(statusAfterMovement('STOCKTAKE_LOSS', false)).toBe('DEAD');
  });

  it('is SOLD when the animal goes back to its supplier', () => {
    expect(statusAfterMovement('SUPPLIER_RETURN', false)).toBe('SOLD');
  });

  it('is ALIVE again after a return from a customer or the reversal of the movement that closed it', () => {
    expect(statusAfterMovement('SALE_RETURN', false)).toBe('ALIVE');
    expect(statusAfterMovement('SALE_ISSUE', true)).toBe('ALIVE');
    expect(statusAfterMovement('MORTALITY', true)).toBe('ALIVE');
  });

  it('is unchanged by any movement that does not open or close it', () => {
    expect(statusAfterMovement('TRANSFER_INTERNAL', false)).toBeNull();
    expect(statusAfterMovement('COST_CAPITALISE', false)).toBeNull();
    expect(statusAfterMovement('SALE_RETURN', true)).toBeNull();
  });
});

describe('how an animal arrived (FR-LIV-001)', () => {
  it('is a purchase when a supplier delivered it, opening stock otherwise', () => {
    expect(sourceOfArrival('019a7a8b-0000-7000-8000-000000000001')).toBe('PURCHASE');
    expect(sourceOfArrival(null)).toBe('OPENING');
  });
});

describe('what a weighing must hold (FR-LIV-004)', () => {
  const now = new Date('2026-11-10T10:00:00Z');
  const goat = { tracking: 'SERIAL' as const, alive: true, isLivestock: true, headWeighed: 1, headOnHand: 1n, measuredAt: new Date('2026-11-10T07:00:00Z'), now };

  it('accepts a goat weighed this morning, and a sample of 10 birds from a flock of 18', () => {
    expect(checkWeighing(goat)).toEqual([]);
    expect(checkWeighing({ ...goat, tracking: 'LOT', headWeighed: 10, headOnHand: 18n })).toEqual([]);
  });

  it('refuses an animal sold, slaughtered or dead, and anything that is not livestock', () => {
    expect(checkWeighing({ ...goat, alive: false })).toEqual([{ rule: 'ANIMAL_NOT_ALIVE' }]);
    expect(checkWeighing({ ...goat, isLivestock: false })).toEqual([{ rule: 'NOT_LIVESTOCK' }]);
  });

  it('weighs one head of an animal and no more birds than the flock has', () => {
    expect(checkWeighing({ ...goat, headWeighed: 2 })).toEqual([{ rule: 'ONE_HEAD_FOR_AN_ANIMAL' }]);
    expect(checkWeighing({ ...goat, tracking: 'LOT', headWeighed: 19, headOnHand: 18n })).toEqual([{ rule: 'HEAD_ABOVE_FLOCK' }]);
  });

  it('refuses a weighing in the future', () => {
    expect(checkWeighing({ ...goat, measuredAt: new Date('2026-11-10T10:00:01Z') })).toEqual([{ rule: 'IN_THE_FUTURE' }]);
  });
});
