import { describe, expect, it } from 'vitest';
import { paymentConfirms, trackingSteps } from './online';

const at = (minute: number) => new Date(Date.UTC(2026, 0, 5, 9, minute));

describe('trackingSteps: an online order’s progress as its customer sees it', () => {
  it('marks a placed delivery order’s first step done and the four after it not yet', () => {
    expect(trackingSteps('DELIVERY', [{ toStatus: 'PLACED', occurredAt: at(0) }])).toEqual([
      { status: 'PLACED', at: at(0), done: true },
      { status: 'CONFIRMED', at: null, done: false },
      { status: 'PACKED', at: null, done: false },
      { status: 'DISPATCHED', at: null, done: false },
      { status: 'DELIVERED', at: null, done: false },
    ]);
  });

  it('ends a collection order at its completion and keeps the first time a status was reached', () => {
    const steps = trackingSteps('COLLECTION', [
      { toStatus: 'PLACED', occurredAt: at(0) },
      { toStatus: 'CONFIRMED', occurredAt: at(2) },
      { toStatus: 'PICKING', occurredAt: at(5) },
      { toStatus: 'PACKED', occurredAt: at(9) },
      { toStatus: 'READY_FOR_COLLECTION', occurredAt: at(10) },
      { toStatus: 'COMPLETED', occurredAt: at(30) },
      { toStatus: 'COMPLETED', occurredAt: at(31) },
    ]);
    expect(steps.map((s) => [s.status, s.done])).toEqual([
      ['PLACED', true],
      ['CONFIRMED', true],
      ['PACKED', true],
      ['READY_FOR_COLLECTION', true],
      ['COMPLETED', true],
    ]);
    expect(steps.at(-1)!.at).toEqual(at(30));
  });

  it('shows a cancelled order’s steps reached, then its cancellation, and nothing it never reached', () => {
    expect(trackingSteps('DELIVERY', [
      { toStatus: 'PLACED', occurredAt: at(0) },
      { toStatus: 'CANCELLED', occurredAt: at(16) },
    ])).toEqual([
      { status: 'PLACED', at: at(0), done: true },
      { status: 'CANCELLED', at: at(16), done: true },
    ]);
  });

  it('ends a voided sale with its void', () => {
    expect(trackingSteps('COLLECTION', [
      { toStatus: 'PLACED', occurredAt: at(0) },
      { toStatus: 'COMPLETED', occurredAt: at(1) },
      { toStatus: 'VOIDED', occurredAt: at(20) },
    ]).map((s) => s.status)).toEqual(['PLACED', 'COMPLETED', 'VOIDED']);
  });
});

describe('paymentConfirms: only the order’s own money confirms an online order placed from a checkout', () => {
  const order = { channel: 'ONLINE', status: 'PLACED' as const, paymentTerms: 'PREPAID', fromCheckout: true };

  it('confirms a placed, prepaid online order from a checkout on money that is its own', () => {
    expect(paymentConfirms(order, false)).toBe(true);
  });

  it('never confirms on money held as unmatched, nor any other order', () => {
    expect(paymentConfirms(order, true)).toBe(false);
    expect(paymentConfirms({ ...order, channel: 'WHOLESALE' }, false)).toBe(false);
    expect(paymentConfirms({ ...order, fromCheckout: false }, false)).toBe(false);
    expect(paymentConfirms({ ...order, status: 'CANCELLED' }, false)).toBe(false);
    expect(paymentConfirms({ ...order, status: 'CONFIRMED' }, false)).toBe(false);
    expect(paymentConfirms({ ...order, paymentTerms: 'COD' }, false)).toBe(false);
  });
});
