import { describe, expect, it } from 'vitest';
import { byLevel, judgeLevels, levelDue, type DunningLevelRule } from './dunning';

const SEED: DunningLevelRule[] = [
  { level: 1, daysOverdue: 7, channels: ['SMS'], templateCode: 'PAYMENT_REMINDER_1' },
  { level: 2, daysOverdue: 14, channels: ['SMS'], templateCode: 'PAYMENT_REMINDER_2' },
  { level: 3, daysOverdue: 30, channels: ['SMS', 'EMAIL'], templateCode: 'PAYMENT_REMINDER_3' },
];

describe('the dunning level an invoice is due (FR-WHL-011)', () => {
  it('sends nothing before the first level, level 1 at 7 days and level 2 at 14 (the seed)', () => {
    expect(levelDue(6, SEED, [])).toBeNull();
    expect(levelDue(7, SEED, [])?.level).toBe(1);
    expect(levelDue(13, SEED, [1])).toBeNull();
    expect(levelDue(14, SEED, [1])?.level).toBe(2);
  });

  it('never sends a level twice', () => {
    expect(levelDue(7, SEED, [1])).toBeNull();
    expect(levelDue(45, SEED, [1, 2, 3])).toBeNull();
  });

  it('sends only the highest level reached, never a lower one afterwards', () => {
    expect(levelDue(31, SEED, [])?.level).toBe(3);
    expect(levelDue(31, SEED, [3])).toBeNull();
    expect(levelDue(14, SEED, [3])).toBeNull();
  });

  it('sends nothing with no levels', () => {
    expect(levelDue(100, [], [])).toBeNull();
  });
});

describe('a replacement set of levels', () => {
  it('accepts the seed in any order, and no levels at all', () => {
    expect(judgeLevels([SEED[2]!, SEED[0]!, SEED[1]!])).toEqual([]);
    expect(judgeLevels([])).toEqual([]);
  });

  it('refuses levels that are not numbered 1, 2, 3 in turn', () => {
    expect(judgeLevels([SEED[0]!, { ...SEED[2]!, level: 4 }])).toEqual([{ field: '/levels/1/level', rule: 'LEVELS_NOT_CONSECUTIVE' }]);
    expect(judgeLevels([SEED[0]!, { ...SEED[1]!, level: 1 }])).toEqual([{ field: '/levels/1/level', rule: 'LEVELS_NOT_CONSECUTIVE' }]);
  });

  it('refuses a level that fires no later than the one before it', () => {
    expect(judgeLevels([SEED[0]!, { ...SEED[1]!, daysOverdue: 7 }])).toEqual([{ field: '/levels/1/daysOverdue', rule: 'DAYS_NOT_INCREASING' }]);
  });

  it('refuses a channel named twice in one level', () => {
    expect(judgeLevels([{ ...SEED[0]!, channels: ['SMS', 'SMS'] }])).toEqual([{ field: '/levels/0/channels', rule: 'CHANNEL_REPEATED' }]);
  });
});

describe('the levels in order', () => {
  it('orders the levels lowest first without changing the set given', () => {
    const given = [SEED[2]!, SEED[0]!, SEED[1]!];
    expect(byLevel(given).map((l) => l.level)).toEqual([1, 2, 3]);
    expect(given.map((l) => l.level)).toEqual([3, 1, 2]);
  });
});
