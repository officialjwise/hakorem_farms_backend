import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { canMove, judgeTenders, ORDER_STATUSES, paymentStatusOf, type OrderStatus } from './order';

const m = (pesewas: bigint) => Money.ofPesewas(pesewas);

describe('the order state machine allows only the documented transitions (FR-ORD-002)', () => {
  const allowed: Record<OrderStatus, readonly OrderStatus[]> = {
    PLACED: ['CONFIRMED', 'COMPLETED', 'CANCELLED'],
    CONFIRMED: ['PICKING', 'CANCELLED'],
    PICKING: ['AWAITING_CUSTOMER', 'PACKED', 'CANCELLED'],
    AWAITING_CUSTOMER: ['PICKING', 'CANCELLED'],
    PACKED: ['READY_FOR_COLLECTION', 'DISPATCHED'],
    READY_FOR_COLLECTION: ['COMPLETED'],
    DISPATCHED: ['DELIVERED', 'DELIVERY_FAILED'],
    DELIVERY_FAILED: ['DISPATCHED', 'RETURNED'],
    DELIVERED: ['COMPLETED'],
    RETURNED: ['CANCELLED'],
    COMPLETED: ['VOIDED'],
    CANCELLED: [],
    VOIDED: [],
  };

  it('allows every listed edge and refuses every other pair of the thirteen statuses', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        expect([from, to, canMove(from, to)]).toEqual([from, to, allowed[from].includes(to)]);
      }
    }
  });

  it('refuses PLACED straight to DELIVERED', () => {
    expect(canMove('PLACED', 'DELIVERED')).toBe(false);
  });
});

describe('a sale on immediate terms is tendered to the document’s gross exactly (FR-ORD-006)', () => {
  it('accepts tenders that sum to the gross', () => {
    expect(judgeTenders(m(86_240n), [m(50_000n), m(36_240n)])).toEqual({ ok: true, value: m(86_240n) });
  });

  it('refuses a tender one pesewa short, and one pesewa over', () => {
    expect(judgeTenders(m(86_240n), [m(86_239n)])).toEqual({ ok: false, error: 'TENDER_SHORT' });
    expect(judgeTenders(m(86_240n), [m(86_241n)])).toEqual({ ok: false, error: 'TENDER_OVER' });
  });

  it('refuses a sale with no tender at all', () => {
    expect(judgeTenders(m(1n), [])).toEqual({ ok: false, error: 'TENDER_SHORT' });
  });
});

describe('payment status is derived from payments and allocations, never set (FR-ORD-016)', () => {
  it('is UNPAID with no document and no deposit, and DEPOSIT_HELD with a deposit before the invoice', () => {
    expect(paymentStatusOf({ documentDue: null, allocated: m(0n), deposits: m(0n), paid: m(0n), refunded: m(0n) })).toBe('UNPAID');
    expect(paymentStatusOf({ documentDue: null, allocated: m(0n), deposits: m(84_000n), paid: m(84_000n), refunded: m(0n) })).toBe('DEPOSIT_HELD');
  });

  it('shows 84,000 deposited against 86,240 invoiced as PART_PAID, then PAID once all of it is allocated', () => {
    expect(paymentStatusOf({ documentDue: m(86_240n), allocated: m(0n), deposits: m(84_000n), paid: m(84_000n), refunded: m(0n) })).toBe('PART_PAID');
    expect(paymentStatusOf({ documentDue: m(86_240n), allocated: m(86_240n), deposits: m(0n), paid: m(86_240n), refunded: m(0n) })).toBe('PAID');
  });

  it('is UNPAID with an invoice and nothing against it', () => {
    expect(paymentStatusOf({ documentDue: m(86_240n), allocated: m(0n), deposits: m(0n), paid: m(0n), refunded: m(0n) })).toBe('UNPAID');
  });

  it('is PART_REFUNDED while some of what was paid is refunded, and REFUNDED once all of it is', () => {
    expect(paymentStatusOf({ documentDue: m(30_000n), allocated: m(30_000n), deposits: m(0n), paid: m(30_000n), refunded: m(25_000n) })).toBe('PART_REFUNDED');
    expect(paymentStatusOf({ documentDue: m(30_000n), allocated: m(30_000n), deposits: m(0n), paid: m(30_000n), refunded: m(30_000n) })).toBe('REFUNDED');
  });
});
