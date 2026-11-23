import { describe, expect, it } from 'vitest';
import { isDriverVariance, judgeCancelReturn, judgeWayOut, UNACCOUNTED_ON_VAN, type CancelFacts, type WayOutFacts } from './van-return';

const hold = { kind: 'RETURNS_HOLD', branchId: 'b1', isLive: true };
const toStock = (over: Partial<WayOutFacts> = {}): WayOutFacts => ({
  wayOut: 'RETURN_TO_STOCK',
  deliveryStatus: 'FAILED',
  pendingWriteOff: false,
  branchId: 'b1',
  returnsLocation: hold,
  reason: null,
  note: 'Customer unreachable after three calls',
  refundDestination: 'ORIGINAL_METHOD',
  hasCustomer: false,
  ...over,
});
const writeOff = (over: Partial<WayOutFacts> = {}): WayOutFacts => ({
  wayOut: 'WRITE_OFF',
  deliveryStatus: 'FAILED',
  pendingWriteOff: false,
  branchId: 'b1',
  returnsLocation: null,
  reason: { code: 'SPOILED', domain: 'WASTAGE', requiresNote: true },
  note: 'The cool box failed on the road',
  refundDestination: 'ORIGINAL_METHOD',
  hasCustomer: false,
  ...over,
});

describe("the van's two other ways out (FR-DEL-011, the owner 2026-11-23)", () => {
  it('returns a failed delivery to its branch returns hold', () => {
    expect(judgeWayOut(toStock())).toEqual([]);
  });

  it('takes only a failed delivery: assigned, on its way, delivered or already off the van is a state refusal', () => {
    for (const status of ['ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'WRITTEN_OFF', 'CANCELLED']) {
      expect(judgeWayOut(toStock({ deliveryStatus: status })), status).toEqual([{ field: '', rule: 'INVALID_STATE_TRANSITION' }]);
      expect(judgeWayOut(writeOff({ deliveryStatus: status })), status).toEqual([{ field: '', rule: 'INVALID_STATE_TRANSITION' }]);
    }
  });

  it('refuses either way out while a write-off of the same goods waits for its approval', () => {
    expect(judgeWayOut(toStock({ pendingWriteOff: true }))).toEqual([{ field: '', rule: 'WRITE_OFF_PENDING' }]);
    expect(judgeWayOut(writeOff({ pendingWriteOff: true }))).toEqual([{ field: '', rule: 'WRITE_OFF_PENDING' }]);
  });

  it('returns only to a live returns hold of the delivery branch, never a shelf, another branch or nowhere', () => {
    expect(judgeWayOut(toStock({ returnsLocation: { ...hold, kind: 'SHOP_FLOOR' } }))).toEqual([{ field: '/returnsLocationId', rule: 'NOT_A_RETURNS_HOLD' }]);
    expect(judgeWayOut(toStock({ returnsLocation: { ...hold, branchId: 'b2' } }))).toEqual([{ field: '/returnsLocationId', rule: 'NOT_A_RETURNS_HOLD' }]);
    expect(judgeWayOut(toStock({ returnsLocation: { ...hold, isLive: false } }))).toEqual([{ field: '/returnsLocationId', rule: 'NOT_A_RETURNS_HOLD' }]);
    expect(judgeWayOut(toStock({ returnsLocation: 'MISSING' }))).toEqual([{ field: '/returnsLocationId', rule: 'NOT_A_RETURNS_HOLD' }]);
  });

  it('writes off with a wastage reason or as unaccounted for, each with its note', () => {
    expect(judgeWayOut(writeOff())).toEqual([]);
    expect(judgeWayOut(writeOff({ reason: { code: UNACCOUNTED_ON_VAN, domain: 'STOCK_ADJUSTMENT', requiresNote: true } }))).toEqual([]);
    expect(judgeWayOut(writeOff({ reason: { code: 'EXPIRED', domain: 'WASTAGE', requiresNote: false }, note: null }))).toEqual([]);
  });

  it('refuses a write-off reason of another kind, an unknown one, none, and a missing note', () => {
    expect(judgeWayOut(writeOff({ reason: { code: 'COUNT_ERROR', domain: 'STOCK_ADJUSTMENT', requiresNote: true } }))).toEqual([{ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' }]);
    expect(judgeWayOut(writeOff({ reason: { code: 'CUSTOMER_REFUSED', domain: 'DELIVERY_FAILURE', requiresNote: true } }))).toEqual([{ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' }]);
    expect(judgeWayOut(writeOff({ reason: 'UNKNOWN' }))).toEqual([{ field: '/reasonCode', rule: 'REASON_UNKNOWN' }]);
    expect(judgeWayOut(writeOff({ reason: null }))).toEqual([{ field: '/reasonCode', rule: 'REASON_UNKNOWN' }]);
    expect(judgeWayOut(writeOff({ note: null }))).toEqual([{ field: '/note', rule: 'NOTE_REQUIRED' }]);
    expect(judgeWayOut(writeOff({ note: '   ' }))).toEqual([{ field: '/note', rule: 'NOTE_REQUIRED' }]);
  });

  it('keeps a refund for store credit to a customer account; a guest has none, so it goes back the way it was paid', () => {
    expect(judgeWayOut(toStock({ refundDestination: 'STORE_CREDIT', hasCustomer: true }))).toEqual([]);
    expect(judgeWayOut(toStock({ refundDestination: 'STORE_CREDIT' }))).toEqual([{ field: '/refundDestination', rule: 'STORE_CREDIT_NEEDS_CUSTOMER' }]);
    expect(judgeWayOut(writeOff({ refundDestination: 'STORE_CREDIT' }))).toEqual([{ field: '/refundDestination', rule: 'STORE_CREDIT_NEEDS_CUSTOMER' }]);
  });

  it('puts only goods unaccounted for on the driver variance report; spoiled or damaged goods are wastage', () => {
    expect(isDriverVariance(UNACCOUNTED_ON_VAN)).toBe(true);
    for (const code of ['SPOILED', 'DAMAGED', 'EXPIRED', 'COLD_CHAIN_FAILURE', null]) expect(isDriverVariance(code), String(code)).toBe(false);
  });
});

describe('the goods of a delivery cancelled before it left (A-364 (a))', () => {
  const cancel = (over: Partial<CancelFacts> = {}): CancelFacts => ({
    branchId: 'b1',
    orderStatus: 'DISPATCHED',
    returnsLocation: hold,
    reason: { code: 'CUSTOMER_CANCELLED', domain: 'CANCELLATION', requiresNote: false },
    note: null,
    refundDestination: 'ORIGINAL_METHOD',
    hasCustomer: false,
    ...over,
  });

  it('takes a dispatched order back into a live returns hold of its branch with a cancellation reason', () => {
    expect(judgeCancelReturn(cancel())).toEqual([]);
    expect(judgeCancelReturn(cancel({ refundDestination: 'STORE_CREDIT', hasCustomer: true }))).toEqual([]);
  });

  it('refuses an order not dispatched, another location, an unknown or wrong reason, a missing note, and store credit for a guest', () => {
    expect(judgeCancelReturn(cancel({ orderStatus: 'DELIVERY_FAILED' }))).toEqual([{ field: '', rule: 'INVALID_STATE_TRANSITION' }]);
    expect(judgeCancelReturn(cancel({ returnsLocation: 'MISSING' }))).toEqual([{ field: '/returnsLocationId', rule: 'NOT_A_RETURNS_HOLD' }]);
    expect(judgeCancelReturn(cancel({ returnsLocation: { ...hold, kind: 'STORE' } }))).toEqual([{ field: '/returnsLocationId', rule: 'NOT_A_RETURNS_HOLD' }]);
    expect(judgeCancelReturn(cancel({ returnsLocation: { ...hold, branchId: 'b2' } }))).toEqual([{ field: '/returnsLocationId', rule: 'NOT_A_RETURNS_HOLD' }]);
    expect(judgeCancelReturn(cancel({ returnsLocation: { ...hold, isLive: false } }))).toEqual([{ field: '/returnsLocationId', rule: 'NOT_A_RETURNS_HOLD' }]);
    expect(judgeCancelReturn(cancel({ reason: 'UNKNOWN' }))).toEqual([{ field: '/reasonCode', rule: 'REASON_UNKNOWN' }]);
    expect(judgeCancelReturn(cancel({ reason: { code: 'SPOILED', domain: 'WASTAGE', requiresNote: false } }))).toEqual([{ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' }]);
    expect(judgeCancelReturn(cancel({ reason: { code: 'OTHER', domain: 'CANCELLATION', requiresNote: true }, note: '  ' }))).toEqual([{ field: '/note', rule: 'NOTE_REQUIRED' }]);
    expect(judgeCancelReturn(cancel({ refundDestination: 'STORE_CREDIT' }))).toEqual([{ field: '/refundDestination', rule: 'STORE_CREDIT_NEEDS_CUSTOMER' }]);
  });
});
