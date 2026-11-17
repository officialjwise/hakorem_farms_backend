import { describe, expect, it } from 'vitest';
import { judgeOverride, judgePriceApprover, overridePayload, type OverrideLine } from './price-override';

// Wholesale cabbage: list 1,100, floor 1,000, ceiling 1,200 a head.
const band = { listPricePesewas: 1_100n, floorPricePesewas: 1_000n, ceilingPricePesewas: 1_200n };

describe('a price override and the approval it needs (FR-ORD-003, abuse case 3)', () => {
  it('needs nothing at list, whatever the limit', () => {
    expect(judgeOverride(band, 1_100n, 0n, 0n)).toEqual({ kind: 'AT_LIST' });
  });

  it('takes a price below list within the band when the line’s whole variance is at or under the role’s limit for a line', () => {
    expect(judgeOverride(band, 1_050n, 100n, 100n)).toEqual({ kind: 'VARIANCE', direction: 'BELOW', approval: null });
    expect(judgeOverride(band, 1_000n, 100n, 1_000n)).toEqual({ kind: 'VARIANCE', direction: 'BELOW', approval: null });
  });

  it('asks a second person for a price below list whose variance is one pesewa beyond the limit, and for any below list with no limit', () => {
    expect(judgeOverride(band, 1_050n, 101n, 100n)).toEqual({ kind: 'VARIANCE', direction: 'BELOW', approval: 'BEYOND_ROLE_LIMIT' });
    expect(judgeOverride(band, 1_099n, 1n, 0n)).toEqual({ kind: 'VARIANCE', direction: 'BELOW', approval: 'BEYOND_ROLE_LIMIT' });
  });

  it('asks a second person for any price outside the band, below the floor or above the ceiling, whatever the limit', () => {
    expect(judgeOverride(band, 999n, 101n, 1_000_000n)).toEqual({ kind: 'VARIANCE', direction: 'BELOW', approval: 'OUTSIDE_BAND' });
    expect(judgeOverride(band, 1_201n, 101n, 1_000_000n)).toEqual({ kind: 'VARIANCE', direction: 'ABOVE', approval: 'OUTSIDE_BAND' });
  });

  it('takes a price above list up to the ceiling with no approval: it costs the farm nothing, and the limit is never spent on it', () => {
    expect(judgeOverride(band, 1_200n, 200n, 0n)).toEqual({ kind: 'VARIANCE', direction: 'ABOVE', approval: null });
  });

  it('never lets the person who sold, posted or asked approve it: each is refused on its own', () => {
    const parties = { requestedBy: 'seller', salespersonId: 'seller', postedBy: 'seller' };
    expect(judgePriceApprover('manager', parties)).toEqual({ ok: true, value: null });
    expect(judgePriceApprover('seller', parties)).toEqual({ ok: false, error: 'APPROVER_IS_SELLER' });
    expect(judgePriceApprover('a', { requestedBy: 'a', salespersonId: 'b', postedBy: 'c' })).toEqual({ ok: false, error: 'APPROVER_IS_SELLER' });
    expect(judgePriceApprover('b', { requestedBy: 'a', salespersonId: 'b', postedBy: 'c' })).toEqual({ ok: false, error: 'APPROVER_IS_SELLER' });
    expect(judgePriceApprover('c', { requestedBy: 'a', salespersonId: 'b', postedBy: 'c' })).toEqual({ ok: false, error: 'APPROVER_IS_SELLER' });
    expect(judgePriceApprover('d', { requestedBy: 'a', salespersonId: null, postedBy: 'c' })).toEqual({ ok: true, value: null });
  });
});

describe('what an override approval binds', () => {
  const line = (over: Partial<OverrideLine> = {}): OverrideLine => ({
    lineNo: 1,
    productId: 'cabbage',
    stockUnitId: null,
    qtyOrdered: '2.000',
    priceBasis: 'PER_UNIT',
    priceListEntryId: 'entry',
    resolvedUnitPricePesewas: 1_100n,
    floorUnitPricePesewas: 1_000n,
    ceilingUnitPricePesewas: 1_200n,
    agreedUnitPricePesewas: 1_050n,
    variancePesewas: 100n,
    varianceDirection: 'BELOW',
    varianceReasonCode: 'REGULAR_CUSTOMER',
    varianceRequiresApproval: true,
    ...over,
  });

  it('binds every flagged line’s pricing record in line order, amounts as strings, and nothing of a line that needs no approval', () => {
    const payload = overridePayload('order-1', 'tema', [line({ lineNo: 2 }), line({ lineNo: 1, varianceRequiresApproval: false, agreedUnitPricePesewas: 1_100n })]);
    expect(payload).toEqual({
      subject: 'order-1',
      customerId: 'tema',
      lines: [
        {
          lineNo: 2,
          productId: 'cabbage',
          stockUnitId: null,
          qtyOrdered: '2.000',
          priceBasis: 'PER_UNIT',
          priceListEntryId: 'entry',
          resolved: '1100',
          floor: '1000',
          ceiling: '1200',
          agreed: '1050',
          variance: '100',
          direction: 'BELOW',
          reasonCode: 'REGULAR_CUSTOMER',
        },
      ],
    });
  });

  it('orders the flagged lines by their number whatever order they come in', () => {
    const payload = overridePayload('order-1', null, [line({ lineNo: 3 }), line({ lineNo: 1 }), line({ lineNo: 2 })]) as { lines: { lineNo: number }[] };
    expect(payload.lines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
  });

  it('changes when the agreed price or the quantity changes, so an approval never covers a different line', () => {
    const base = JSON.stringify(overridePayload('order-1', null, [line()]));
    expect(JSON.stringify(overridePayload('order-1', null, [line({ agreedUnitPricePesewas: 1_049n })]))).not.toBe(base);
    expect(JSON.stringify(overridePayload('order-1', null, [line({ qtyOrdered: '3.000' })]))).not.toBe(base);
    expect(JSON.stringify(overridePayload('order-2', null, [line()]))).not.toBe(base);
  });
});
