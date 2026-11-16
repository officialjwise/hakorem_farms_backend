import { describe, expect, it } from 'vitest';
import { chargeableMonths, disposalFollowsCharges, monthEnds, monthsLeft, monthsInService, plusMonths } from './asset-months';

describe('the months an asset has been in service (FR-FIN-015, A-199)', () => {
  it('counts the month it was acquired in as its first month, whatever the day', () => {
    expect(monthsInService('2026-01-31', '2026-01-31')).toBe(1);
    expect(monthsInService('2026-01-01', '2026-01-31')).toBe(1);
    expect(monthsInService('2026-01-20', '2026-10-31')).toBe(10);
  });

  it('counts across a year end', () => {
    expect(monthsInService('2025-11-15', '2026-02-28')).toBe(4);
  });

  it('is nil for a period that ended before the asset was acquired', () => {
    expect(monthsInService('2026-11-10', '2026-10-31')).toBe(0);
    expect(monthsInService('2027-01-01', '2026-12-31')).toBe(0);
  });
});

describe('the months a run charges (FR-FIN-015, A-199)', () => {
  it('charges the months in service not yet charged, so a run catches up a month no run charged', () => {
    expect(chargeableMonths({ acquiredOn: '2026-01-20', usefulLifeMonths: 36, depreciatedMonths: 0 }, '2026-01-31')).toBe(1);
    expect(chargeableMonths({ acquiredOn: '2026-01-20', usefulLifeMonths: 36, depreciatedMonths: 8 }, '2026-10-31')).toBe(2);
  });

  it('never charges beyond the useful life', () => {
    expect(chargeableMonths({ acquiredOn: '2026-01-01', usefulLifeMonths: 3, depreciatedMonths: 0 }, '2026-12-31')).toBe(3);
    expect(chargeableMonths({ acquiredOn: '2026-01-01', usefulLifeMonths: 3, depreciatedMonths: 3 }, '2026-12-31')).toBe(0);
  });

  it('charges nothing for a month already charged or not yet reached', () => {
    expect(chargeableMonths({ acquiredOn: '2026-01-01', usefulLifeMonths: 12, depreciatedMonths: 10 }, '2026-09-30')).toBe(0);
    expect(chargeableMonths({ acquiredOn: '2026-11-10', usefulLifeMonths: 12, depreciatedMonths: 0 }, '2026-10-31')).toBe(0);
  });

  it('leaves the months of the life not yet charged', () => {
    expect(monthsLeft({ usefulLifeMonths: 120, depreciatedMonths: 10 })).toBe(110);
    expect(monthsLeft({ usefulLifeMonths: 3, depreciatedMonths: 3 })).toBe(0);
  });
});

describe('a disposal date and the months already charged (A-199)', () => {
  it('may fall in the last month charged or later', () => {
    expect(disposalFollowsCharges({ acquiredOn: '2026-01-20', depreciatedMonths: 10 }, '2026-10-01')).toBe(true);
    expect(disposalFollowsCharges({ acquiredOn: '2026-01-20', depreciatedMonths: 10 }, '2026-11-13')).toBe(true);
    expect(disposalFollowsCharges({ acquiredOn: '2026-01-20', depreciatedMonths: 0 }, '2026-01-20')).toBe(true);
  });

  it('may not fall before a month already charged', () => {
    expect(disposalFollowsCharges({ acquiredOn: '2026-01-20', depreciatedMonths: 10 }, '2026-09-30')).toBe(false);
  });
});

describe('month ends and month counts', () => {
  it('lists the last day of each month from a first month, across a year end and a leap February', () => {
    expect(monthEnds('2027-11', 4)).toEqual(['2027-11-30', '2027-12-31', '2028-01-31', '2028-02-29']);
    expect(monthEnds('2026-01', 0)).toEqual([]);
  });

  it('adds months charged to months already charged', () => {
    expect(plusMonths(10, 2)).toBe(12);
  });
});
