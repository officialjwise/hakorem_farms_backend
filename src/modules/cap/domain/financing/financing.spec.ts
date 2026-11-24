import { Rate } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { completeMonths, equalMonthlyParts, instalmentsPaid, interestOfMonth, judgeRepayment, monthsFrom, scheduleOf } from './index';

/** FR-CAP-015: loans and grants. Simple interest, actual/365, accrued monthly half-up; a repayment to interest first. */
describe('interest accrued a month (FR-CAP-015)', () => {
  const twelve = Rate.parsePercent('12');

  it('accrues half_up(100,000 x 0.12 x 31 / 365) = 1,019 on a loan of 100,000 for the 31 days of January', () => {
    expect(interestOfMonth(100_000n, twelve, { start: '2027-01-01', end: '2027-01-31' }, [])).toBe(1_019n);
  });

  it('rounds an exact half pesewa up, once a month: 36,500 x 1 percent x 5 days / 365 is 5 exactly, 182,500 at 1 percent for 1 day is 5', () => {
    const one = Rate.parsePercent('1');
    // 18,250 x 0.01 x 1 / 365 = 0.5: exactly half, up to 1
    expect(interestOfMonth(18_250n, one, { start: '2027-03-31', end: '2027-03-31' }, [])).toBe(1n);
    // 18,249 is just below half: 0
    expect(interestOfMonth(18_249n, one, { start: '2027-03-31', end: '2027-03-31' }, [])).toBe(0n);
    // 18,251 is just above half: 1
    expect(interestOfMonth(18_251n, one, { start: '2027-03-31', end: '2027-03-31' }, [])).toBe(1n);
    expect(interestOfMonth(100_000n, Rate.parsePercent('0'), { start: '2027-01-01', end: '2027-01-31' }, [])).toBe(0n);
  });

  it('counts a part month from the drawing day, both days counted', () => {
    // 15 to 31 January: 17 days. 100,000 x 0.12 x 17 / 365 = 558.9 -> 559
    expect(interestOfMonth(100_000n, twelve, { start: '2027-01-15', end: '2027-01-31' }, [])).toBe(559n);
  });

  it('stops counting repaid principal from the repayment day, and rounds the month once', () => {
    // 100,000 for 1 to 9 February (9 days), 96,019 for 10 to 28 February (19 days): (900,000 + 1,824,361) x 0.12 / 365 = 895.68 -> 896
    expect(interestOfMonth(100_000n, twelve, { start: '2027-02-01', end: '2027-02-28' }, [{ date: '2027-02-10', pesewas: 3_981n }])).toBe(896n);
    // Two repayments, given in either order: 100,000 for 9 days, 96,019 for 10, 86,019 for 9: 2,634,361 x 0.12 / 365 = 866.1 -> 866
    const two = [{ date: '2027-02-20', pesewas: 10_000n }, { date: '2027-02-10', pesewas: 3_981n }];
    expect(interestOfMonth(100_000n, twelve, { start: '2027-02-01', end: '2027-02-28' }, two)).toBe(866n);
    // A repayment outside the month changes nothing in it.
    expect(interestOfMonth(100_000n, twelve, { start: '2027-02-01', end: '2027-02-28' }, [{ date: '2027-03-10', pesewas: 3_981n }])).toBe(921n);
  });

  it('accrues the largest loan without overflow or a float', () => {
    expect(interestOfMonth(9_007_199_254_740_991n, Rate.parsePercent('100'), { start: '2027-01-01', end: '2027-12-31' }, [])).toBe(9_007_199_254_740_991n);
  });
});

describe('the months a loan or grant has finished', () => {
  it('lists every month that has ended before today, the first from the drawing day', () => {
    expect(completeMonths('2027-01-15', '2027-03-31')).toEqual([
      { start: '2027-01-15', end: '2027-01-31' },
      { start: '2027-02-01', end: '2027-02-28' },
    ]);
    expect(completeMonths('2027-01-15', '2027-04-01').at(-1)).toEqual({ start: '2027-03-01', end: '2027-03-31' });
    expect(completeMonths('2027-01-15', '2027-01-31')).toEqual([]);
  });

  it('crosses a year and a leap February', () => {
    expect(monthsFrom('2027-12-01', 3)).toEqual([
      { start: '2027-12-01', end: '2027-12-31' },
      { start: '2028-01-01', end: '2028-01-31' },
      { start: '2028-02-01', end: '2028-02-29' },
    ]);
  });
});

describe('a repayment goes to accrued interest first (FR-CAP-015)', () => {
  const owed = { accruedInterestPesewas: 1_019n, outstandingPrincipalPesewas: 100_000n };

  it('repaying 5,000 clears 1,019 interest then 3,981 principal', () => {
    expect(judgeRepayment({ principalPesewas: 3_981n, interestPesewas: 1_019n }, owed)).toEqual([]);
  });

  it('refuses principal while interest is owed, and interest beyond what has accrued', () => {
    expect(judgeRepayment({ principalPesewas: 4_000n, interestPesewas: 1_000n }, owed)).toEqual([{ field: '/interestPesewas', rule: 'INTEREST_FIRST' }]);
    expect(judgeRepayment({ principalPesewas: 0n, interestPesewas: 1_020n }, owed)).toEqual([{ field: '/interestPesewas', rule: 'MORE_THAN_ACCRUED' }]);
    // A repayment smaller than the interest owed is all interest.
    expect(judgeRepayment({ principalPesewas: 0n, interestPesewas: 500n }, owed)).toEqual([]);
  });

  it('refuses more principal than is outstanding, and a repayment of nothing', () => {
    expect(judgeRepayment({ principalPesewas: 100_001n, interestPesewas: 1_019n }, owed)).toEqual([{ field: '/principalPesewas', rule: 'MORE_THAN_OUTSTANDING' }]);
    expect(judgeRepayment({ principalPesewas: 0n, interestPesewas: 0n }, owed)).toEqual([{ field: '/principalPesewas', rule: 'NOT_POSITIVE' }]);
  });
});

describe('the repayment schedule and the grant recognised', () => {
  it('splits the principal into equal instalments that sum to it exactly, interest projected on the balance', () => {
    const schedule = scheduleOf(100_000n, Rate.parsePercent('12'), '2027-01-01', 3);
    expect(schedule).toEqual([
      { instalmentNo: 1, dueDate: '2027-01-31', principalDuePesewas: 33_334n, interestDuePesewas: 1_019n },
      // 66,666 x 0.12 x 28 / 365 = 613.7 -> 614
      { instalmentNo: 2, dueDate: '2027-02-28', principalDuePesewas: 33_333n, interestDuePesewas: 614n },
      // 33,333 x 0.12 x 31 / 365 = 339.7 -> 340
      { instalmentNo: 3, dueDate: '2027-03-31', principalDuePesewas: 33_333n, interestDuePesewas: 340n },
    ]);
    expect(schedule.reduce((sum, i) => sum + i.principalDuePesewas, 0n)).toBe(100_000n);
  });

  it('has no instalments without a term', () => {
    expect(scheduleOf(100_000n, Rate.parsePercent('12'), '2027-01-01', null)).toEqual([]);
  });

  it('marks what was paid against the instalments in due order, interest and principal together', () => {
    const schedule = scheduleOf(100_000n, Rate.parsePercent('12'), '2027-01-01', 3);
    expect(instalmentsPaid(schedule, 35_000n)).toEqual([34_353n, 647n, 0n]);
    expect(instalmentsPaid(schedule, 0n)).toEqual([0n, 0n, 0n]);
    expect(instalmentsPaid(schedule, 999_999n)).toEqual([34_353n, 33_947n, 33_673n]);
  });

  it('recognises a grant over its months in equal parts that sum to it exactly', () => {
    expect(equalMonthlyParts(100_000n, 3)).toEqual([33_334n, 33_333n, 33_333n]);
    expect(equalMonthlyParts(2n, 3)).toEqual([1n, 1n, 0n]);
    expect(() => equalMonthlyParts(2n, 0)).toThrow();
  });
});
