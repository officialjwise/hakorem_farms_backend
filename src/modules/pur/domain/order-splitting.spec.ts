import { describe, expect, it } from 'vitest';
import { flagOrderSplitting, splitLookbackStart, SPLIT_POLICY, type SubmittedOrder } from './order-splitting';

const DAY = 86_400_000;
const start = Date.parse('2026-11-10T08:00:00Z');
/** An order judged against the 200,000 limit, submitted `day` days after the start. */
const order = (id: string, day: number, grossPesewas: bigint, over: Partial<SubmittedOrder> = {}): SubmittedOrder => ({
  id,
  supplierId: 'awutu',
  makerId: 'kwesi',
  submittedAt: new Date(start + day * DAY),
  grossPesewas,
  limitPesewas: 200_000n,
  ...over,
});

describe('order splitting (owner, 2026-11-15; A-168)', () => {
  it('flags three orders of 190,000 to one supplier by one maker in three days', () => {
    expect(flagOrderSplitting([order('a', 0, 190_000n), order('b', 1, 190_000n), order('c', 2, 190_000n)])).toEqual([
      { supplierId: 'awutu', makerId: 'kwesi', orderIds: ['a', 'b', 'c'], totalPesewas: 570_000n, firstAt: new Date(start), lastAt: new Date(start + 2 * DAY) },
    ]);
  });

  it('does not flag the same three orders spread ten days apart', () => {
    expect(flagOrderSplitting([order('a', 0, 190_000n), order('b', 10, 190_000n), order('c', 20, 190_000n)])).toEqual([]);
  });

  it('flags two just under the limit within the window, and not orders by different makers or to different suppliers', () => {
    expect(flagOrderSplitting([order('a', 0, 160_000n), order('b', SPLIT_POLICY.windowDays, 200_000n)]).map((s) => s.orderIds)).toEqual([['a', 'b']]);
    expect(flagOrderSplitting([order('a', 0, 190_000n), order('b', 1, 190_000n, { makerId: 'efua' })])).toEqual([]);
    expect(flagOrderSplitting([order('a', 0, 190_000n), order('b', 1, 190_000n, { supplierId: 'kpone' })])).toEqual([]);
  });

  it('counts only orders just under their own limit: not one far below it, not one above it, not one a day past the window', () => {
    expect(flagOrderSplitting([order('a', 0, 159_999n), order('b', 1, 190_000n)])).toEqual([]);
    expect(flagOrderSplitting([order('a', 0, 200_001n), order('b', 1, 190_000n)])).toEqual([]);
    expect(flagOrderSplitting([order('a', 0, 190_000n), order('b', SPLIT_POLICY.windowDays + 1, 190_000n)])).toEqual([]);
  });

  it('needs the orders together to pass the limit, and reads each order against the limit it was judged by', () => {
    expect(flagOrderSplitting([order('a', 0, 85_000n, { limitPesewas: 100_000n }), order('b', 1, 90_000n, { limitPesewas: 100_000n })]).map((s) => s.totalPesewas)).toEqual([175_000n]);
    expect(flagOrderSplitting([order('a', 0, 160_000n, { limitPesewas: 1_000_000n }), order('b', 1, 160_000n)])).toEqual([]);
  });

  it('reports separate runs separately, in submission order whatever order they arrive in', () => {
    const flagged = flagOrderSplitting([order('d', 30, 190_000n), order('a', 0, 190_000n), order('e', 31, 190_000n), order('b', 1, 190_000n)]);
    expect(flagged.map((s) => s.orderIds)).toEqual([['a', 'b'], ['d', 'e']]);
  });

  it('looks back one window before a report period, so a run that began earlier is seen whole', () => {
    expect(splitLookbackStart(new Date(start + 10 * DAY))).toEqual(new Date(start + 3 * DAY));
  });
});
