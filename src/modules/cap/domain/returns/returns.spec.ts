import { describe, expect, it } from 'vitest';
import { exp, ln, paybackDate, returnOnInvestment, SCALE, wholeMonthsBetween, xirr } from './index';

/**
 * FR-CAP-014: return on investment, payback and IRR, computed in integers (ADR-0001: never a float). The SRS's own
 * acceptance is the first test of each group.
 */
describe('return on investment (FR-CAP-014)', () => {
  it('is distributions paid over net contributions, to two places: 5,000 on 100,000 is 5.00 percent', () => {
    expect(returnOnInvestment(5_000n, 100_000n)).toEqual({ percent: '5.00', negative: false });
  });

  it('rounds an exact half of a hundredth up, once: 1 on 40,000 is 0.0025 percent, shown 0.00; 1 on 20,000 is 0.01', () => {
    expect(returnOnInvestment(1n, 40_000n).percent).toBe('0.00');
    expect(returnOnInvestment(1n, 20_000n).percent).toBe('0.01');
    // 1 on 30,000 is 0.00333 percent: below half, stays 0.00; 2 on 30,000 is 0.00667: above half, 0.01.
    expect(returnOnInvestment(1n, 30_000n).percent).toBe('0.00');
    expect(returnOnInvestment(2n, 30_000n).percent).toBe('0.01');
  });

  it('is nothing paid on capital, 0.00, and has no figure when nothing is left invested', () => {
    expect(returnOnInvestment(0n, 100_000n)).toEqual({ percent: '0.00', negative: false });
    expect(returnOnInvestment(5_000n, 0n)).toEqual({ percent: null, negative: false });
  });

  it('is exactly 100.00 percent when everything came back, and has no figure above what the contract carries', () => {
    expect(returnOnInvestment(100_000n, 100_000n).percent).toBe('100.00');
    expect(returnOnInvestment(100_005n, 100_000n).percent).toBeNull();
    expect(returnOnInvestment(9_007_199_254_740_991n, 9_007_199_254_740_991n).percent).toBe('100.00');
  });
});

describe('payback (FR-CAP-014)', () => {
  const contributed = [{ date: '2027-01-01', pesewas: 100_000n }];

  it('is not reported while cumulative distributions and withdrawals are below contributions', () => {
    expect(paybackDate(contributed, [{ date: '2028-01-01', pesewas: 5_000n }])).toBeNull();
  });

  it('is the first date on which they reach the contributions', () => {
    const back = [
      { date: '2027-06-30', pesewas: 60_000n },
      { date: '2027-12-31', pesewas: 40_000n },
      { date: '2028-06-30', pesewas: 10_000n },
    ];
    expect(paybackDate(contributed, back)).toBe('2027-12-31');
  });

  it('counts only what was paid in by that date, and nothing when nothing was paid in', () => {
    // A later contribution moves the bar from its own date on.
    expect(paybackDate([...contributed, { date: '2027-07-01', pesewas: 50_000n }], [{ date: '2027-06-30', pesewas: 100_000n }, { date: '2027-08-01', pesewas: 50_000n }])).toBe('2027-06-30');
    expect(paybackDate([], [{ date: '2027-06-30', pesewas: 1n }])).toBeNull();
  });

  it('is counted in whole calendar months from the first contribution', () => {
    expect(wholeMonthsBetween('2027-01-01', '2027-12-31')).toBe(11);
    expect(wholeMonthsBetween('2027-01-01', '2028-01-01')).toBe(12);
    expect(wholeMonthsBetween('2027-01-31', '2027-02-28')).toBe(0);
    expect(wholeMonthsBetween('2027-01-15', '2027-01-15')).toBe(0);
  });
});

describe('internal rate of return (FR-CAP-014, SA-14)', () => {
  it('is 0.1500 for 115,000 returned on 100,000 over 365 days (contribution, a distribution of 5,000 and a closing value of 110,000)', () => {
    const irr = xirr([
      { date: '2027-01-01', pesewas: -100_000n },
      { date: '2028-01-01', pesewas: 5_000n },
      { date: '2028-01-01', pesewas: 110_000n },
    ]);
    expect(irr).toEqual({ percent: '15.00', negative: false });
  });

  it('is negative when less comes back than went in: 90,000 back on 100,000 after a year is -0.1000', () => {
    expect(xirr([{ date: '2027-01-01', pesewas: -100_000n }, { date: '2028-01-01', pesewas: 90_000n }])).toEqual({ percent: '10.00', negative: true });
  });

  it('is nothing at all when what comes back equals what went in', () => {
    expect(xirr([{ date: '2027-01-01', pesewas: -100_000n }, { date: '2028-01-01', pesewas: 100_000n }])).toEqual({ percent: '0.00', negative: false });
  });

  it('compounds over actual days: 121,000 back on 100,000 after 730 days is 0.1000 a year, after 731 (a leap day) 0.0999', () => {
    expect(xirr([{ date: '2029-01-01', pesewas: -100_000n }, { date: '2031-01-01', pesewas: 121_000n }])).toEqual({ percent: '10.00', negative: false });
    expect(xirr([{ date: '2027-01-01', pesewas: -100_000n }, { date: '2029-01-01', pesewas: 121_000n }])).toEqual({ percent: '9.99', negative: false });
  });

  it('reads flows given in any order, and several contributions', () => {
    expect(
      xirr([
        { date: '2028-01-01', pesewas: 115_000n },
        { date: '2027-01-01', pesewas: -50_000n },
        { date: '2027-01-01', pesewas: -50_000n },
      ]),
    ).toEqual({ percent: '15.00', negative: false });
  });

  it('has no figure without money both ways, or beyond 100 percent a year either way', () => {
    expect(xirr([{ date: '2027-01-01', pesewas: -100_000n }])).toEqual({ percent: null, negative: false });
    expect(xirr([{ date: '2027-01-01', pesewas: 100_000n }])).toEqual({ percent: null, negative: false });
    expect(xirr([{ date: '2027-01-01', pesewas: -100_000n }, { date: '2028-01-01', pesewas: 300_000n }])).toEqual({ percent: null, negative: false });
    expect(xirr([{ date: '2027-01-01', pesewas: -100_000n }, { date: '2028-01-01', pesewas: 1n }])).toEqual({ percent: null, negative: false });
  });

  it('is exactly 100 percent at the top of the range: 200,000 back on 100,000 after a year', () => {
    expect(xirr([{ date: '2027-01-01', pesewas: -100_000n }, { date: '2028-01-01', pesewas: 200_000n }])).toEqual({ percent: '100.00', negative: false });
  });
});

describe('fixed-point logarithm and exponential (no float)', () => {
  const close = (actual: bigint, expected: bigint) => expect(actual - expected < 10n ** 20n && expected - actual < 10n ** 20n).toBe(true);

  it('gives ln 1 = 0 and exp 0 = 1 exactly', () => {
    expect(ln(SCALE)).toBe(0n);
    expect(exp(0n)).toBe(SCALE);
  });

  it('inverts each other above and below one, to ten places', () => {
    for (const x of [SCALE / 7n, SCALE / 2n, 3n * SCALE, 15n * SCALE, 1_150_000_000_000_000_000_000_000_000_000n]) {
      close(exp(ln(x)), x);
    }
    // ln 2 to thirty places
    close(ln(2n * SCALE), 693_147_180_559_945_309_417_232_121_458n);
  });
});
