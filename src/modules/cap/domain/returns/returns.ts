import { halfUpDivide } from '@hakorem/kernel';
import { exp, ln, SCALE } from './fixed-point';

/**
 * Return metrics per investor and overall (FR-CAP-014, SA-14), from dated flows of pesewas. Exact integers: ROI half-up
 * once to two places; IRR found by bisection in thirty-place fixed point and rounded half-up once to four places of a
 * fraction (two of a percentage). Pure.
 */

/** A dated amount. For the IRR: negative is money the investor put in, positive money they got back or still own. */
export interface DatedFlow {
  readonly date: string;
  readonly pesewas: bigint;
}

/** A percentage as the contract carries it (0 to 100, `Percent`) and its sign; null where it is not meaningful. */
export interface Figure {
  readonly percent: string | null;
  readonly negative: boolean;
}

const NONE: Figure = { percent: null, negative: false };
/** Hundredths of a percent in a whole one hundred percent. */
const HUNDRED_PERCENT = 10_000n;
const DAYS_IN_YEAR = 365n;
const MS_PER_DAY = 86_400_000;
const BISECTIONS = 64;

const dayNumber = (date: string): bigint => BigInt(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY);
const percentOf = (hundredths: bigint): string => `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
const above = (n: bigint): boolean => n > 0n;

/**
 * ROI: distributions paid over net contributions, as a percentage to two places, half-up once. None while nothing is
 * left invested; none above 100 percent, which the contract's `Percent` cannot carry (A-384).
 */
export function returnOnInvestment(paidOut: bigint, netContributed: bigint): Figure {
  if (netContributed <= 0n) return NONE;
  const hundredths = halfUpDivide(paidOut * HUNDRED_PERCENT, netContributed);
  return hundredths > HUNDRED_PERCENT ? NONE : { percent: percentOf(hundredths), negative: false };
}

/**
 * Payback: the first date on which cumulative distributions and withdrawals reach what was contributed by that date.
 * None until then, and none when nothing was ever paid in.
 */
export function paybackDate(contributions: readonly DatedFlow[], returned: readonly DatedFlow[]): string | null {
  const dates = [...new Set([...contributions, ...returned].map((f) => f.date))].sort();
  for (const date of dates) {
    const paidIn = contributions.filter((f) => f.date <= date).reduce((sum, f) => sum + f.pesewas, 0n);
    const back = returned.filter((f) => f.date <= date).reduce((sum, f) => sum + f.pesewas, 0n);
    if (paidIn > 0n && back >= paidIn) return date;
  }
  return null;
}

/** Whole calendar months from one date to a later one: 1 January to 31 December is eleven. */
export function wholeMonthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  const months = (ty - fy) * 12 + (tm - fm);
  return td < fd ? months - 1 : months;
}

/**
 * The lowest and highest yearly rates searched: -99.99 percent, and a hair above +100 percent, which still rounds to
 * 100.00, so a rate the contract cannot carry is never found.
 */
const LOWEST = -SCALE + SCALE / HUNDRED_PERCENT;
const HIGHEST = SCALE + SCALE / 1_000_000n;

/**
 * XIRR on actual/365: the yearly rate r at which the flows' value at the first date is nil, sum a (1 + r)^(-days/365).
 * None without money both ways, or when the rate lies outside -100 to +100 percent.
 */
export function xirr(flows: readonly DatedFlow[]): Figure {
  if (!flows.some((f) => f.pesewas < 0n) || !flows.some((f) => f.pesewas > 0n)) return NONE;
  const first = flows.map((f) => dayNumber(f.date)).reduce((a, b) => (b < a ? b : a));
  const days = flows.map((f) => dayNumber(f.date) - first);
  const npv = (rate: bigint): bigint => {
    const growth = ln(SCALE + rate);
    return flows.reduce((sum, f, i) => sum + f.pesewas * exp(-(days[i]! * growth) / DAYS_IN_YEAR), 0n);
  };
  let low = LOWEST;
  let high = HIGHEST;
  const atLow = above(npv(low));
  if (atLow === above(npv(high))) return NONE;
  for (let i = 0; i < BISECTIONS; i += 1) {
    const middle = (low + high) / 2n;
    if (above(npv(middle)) === atLow) low = middle;
    else high = middle;
  }
  const rate = (low + high) / 2n;
  const hundredths = halfUpDivide((rate < 0n ? -rate : rate) * HUNDRED_PERCENT, SCALE);
  return { percent: percentOf(hundredths), negative: rate < 0n && hundredths > 0n };
}
