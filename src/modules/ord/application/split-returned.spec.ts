import { describe, expect, it } from 'vitest';
import type { PickRecord } from './fulfilment-store';
import type { OrderLineRecord } from './order-store';
import { splitReturned } from './dispatches';

const pick = (id: string, line: string, qtyBase: string, weightKg: string | null = null) =>
  ({ id, fulfilmentId: 'f', pickListLineId: 'pl', salesOrderLineId: line, stockUnitId: 'lot', packBarcode: null, qty: '1.000', qtyBase, weightKg, weightSource: weightKg === null ? null : 'SCALE', withdrawnAt: null, recordedAt: new Date(0), createdBy: 'u' }) as PickRecord;
const lines = [{ id: 'eggs' }, { id: 'beef' }] as unknown as OrderLineRecord[];

describe('what a part delivery sends back off the van, pick by pick (CR-055)', () => {
  it('turns 2 of 12 crates into 60 eggs, taken from the last pick first', () => {
    const back = splitReturned([pick('p1', 'eggs', '300.000'), pick('p2', 'eggs', '60.000')], [{ orderLineId: 'eggs', dispatchedQty: '12.000', returnedQty: '2.000', weighed: false }], lines);
    expect([...back.entries()].map(([k, v]) => [k, v.toDecimalString()])).toEqual([['p2', '60.000']]);
  });

  it('spreads 3 crates over the last two picks when the last holds only one', () => {
    const back = splitReturned([pick('p1', 'eggs', '300.000'), pick('p2', 'eggs', '30.000')], [{ orderLineId: 'eggs', dispatchedQty: '11.000', returnedQty: '3.000', weighed: false }], lines);
    expect([...back.entries()].map(([k, v]) => [k, v.toDecimalString()])).toEqual([
      ['p2', '30.000'],
      ['p1', '60.000'],
    ]);
  });

  it('sends a weighed pack back whole, its kilograms with it', () => {
    const back = splitReturned([pick('b1', 'beef', '14.650', '14.650')], [{ orderLineId: 'beef', dispatchedQty: '1.000', returnedQty: '1.000', weighed: true }], lines);
    expect(back.get('b1')?.toDecimalString()).toBe('14.650');
  });

  it('refuses a quantity that does not convert exactly, a weighed pick split, and a line with no picks', () => {
    expect(() => splitReturned([pick('p1', 'eggs', '100.000')], [{ orderLineId: 'eggs', dispatchedQty: '3.000', returnedQty: '1.000', weighed: false }], lines)).toThrow();
    expect(() => splitReturned([pick('b1', 'beef', '14.650', '14.650'), pick('b2', 'beef', '15.100', '15.100')], [{ orderLineId: 'beef', dispatchedQty: '2.000', returnedQty: '1.000', weighed: false }], lines)).toThrow();
    expect(() => splitReturned([], [{ orderLineId: 'eggs', dispatchedQty: '1.000', returnedQty: '1.000', weighed: false }], lines)).toThrow();
  });
});
