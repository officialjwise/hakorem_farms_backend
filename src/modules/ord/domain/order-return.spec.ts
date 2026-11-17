import { Money, Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { judgeReturn, judgeReturnApprover, planReturnRefund, type ReturnFacts, type SoldLine } from './order-return';

const sold = (over: Partial<SoldLine> = {}): SoldLine => ({
  id: 'line-1',
  priceBasis: 'PER_UNIT',
  serial: false,
  qtySold: Quantity.parse('3.000'),
  qtyReturned: Quantity.parse('0.000'),
  ...over,
});
const facts = (over: Partial<ReturnFacts> = {}): ReturnFacts => ({
  orderStatus: 'COMPLETED',
  kind: 'RETURN',
  sold: [sold()],
  asked: [{ orderLineId: 'line-1', qty: Quantity.parse('2.000') }],
  ...over,
});

describe('a return against the original sale (FR-ORD-015, abuse case 12)', () => {
  it('takes back part of what was sold on a completed sale', () => {
    expect(judgeReturn(facts())).toEqual({ ok: true, value: null });
  });

  it('takes back exactly what is left, and never one thousandth more', () => {
    expect(judgeReturn(facts({ sold: [sold({ qtyReturned: Quantity.parse('1.000') })] }))).toEqual({ ok: true, value: null });
    expect(judgeReturn(facts({ sold: [sold({ qtyReturned: Quantity.parse('1.001') })] }))).toEqual({ ok: false, error: [{ field: '/lines/0/qty', rule: 'RETURN_EXCEEDS_SOLD' }] });
    expect(judgeReturn(facts({ asked: [{ orderLineId: 'line-1', qty: Quantity.parse('3.001') }] }))).toEqual({ ok: false, error: [{ field: '/lines/0/qty', rule: 'RETURN_EXCEEDS_SOLD' }] });
  });

  it('refuses a return of an order that is not a completed sale: a voided sale is not a sale', () => {
    for (const orderStatus of ['PLACED', 'CONFIRMED', 'CANCELLED', 'VOIDED'] as const) {
      expect(judgeReturn(facts({ orderStatus })), orderStatus).toEqual({ ok: false, error: [{ field: '', rule: 'INVALID_STATE_TRANSITION' }] });
    }
  });

  it('refuses an exchange until the counter that makes the replacement sale exists, and a return with no lines', () => {
    expect(judgeReturn(facts({ kind: 'EXCHANGE' }))).toEqual({ ok: false, error: [{ field: '/kind', rule: 'EXCHANGE_NOT_AVAILABLE' }] });
    expect(judgeReturn(facts({ asked: [] }))).toEqual({ ok: false, error: [{ field: '/lines', rule: 'NO_LINES' }] });
  });

  it('names every broken line at once: not on the order, repeated, nothing returned, part of an animal, a weighed line', () => {
    const verdict = judgeReturn(
      facts({
        sold: [sold(), sold({ id: 'goat', serial: true, qtySold: Quantity.parse('1.000') }), sold({ id: 'beef', priceBasis: 'PER_KG', qtySold: Quantity.parse('14.850') }), sold({ id: 'cabbage' })],
        asked: [
          { orderLineId: 'elsewhere', qty: Quantity.parse('1.000') },
          { orderLineId: 'line-1', qty: Quantity.parse('1.000') },
          { orderLineId: 'line-1', qty: Quantity.parse('1.000') },
          { orderLineId: 'goat', qty: Quantity.parse('0.500') },
          { orderLineId: 'beef', qty: Quantity.parse('1.000') },
          { orderLineId: 'cabbage', qty: Quantity.parse('0.000') },
        ],
      }),
    );
    expect(verdict).toEqual({
      ok: false,
      error: [
        { field: '/lines/0/orderLineId', rule: 'LINE_NOT_ON_ORDER' },
        { field: '/lines/2/orderLineId', rule: 'LINE_REPEATED' },
        { field: '/lines/3/qty', rule: 'SERIAL_RETURNS_WHOLE' },
        { field: '/lines/4/orderLineId', rule: 'WEIGHED_LINE_NOT_RETURNABLE' },
        { field: '/lines/5/qty', rule: 'QUANTITY_NOT_POSITIVE' },
      ],
    });
  });

  it('takes back a whole animal', () => {
    expect(judgeReturn(facts({ sold: [sold({ serial: true, qtySold: Quantity.parse('1.000') })], asked: [{ orderLineId: 'line-1', qty: Quantity.parse('1.000') }] }))).toEqual({ ok: true, value: null });
  });
});

describe('the approver of a return (ADR-0066)', () => {
  it('is never the person who made the return', () => {
    expect(judgeReturnApprover('owner', { makerId: 'accountant' })).toEqual({ ok: true, value: null });
    expect(judgeReturnApprover('accountant', { makerId: 'accountant' })).toEqual({ ok: false, error: 'MAKER_CANNOT_CHECK' });
  });
});

describe('the refund a return asks for (ADR-0066)', () => {
  const cash = (id: string, allocated: number, status: 'CLEARED' | 'PENDING' | 'FAILED' | 'REVERSED' = 'CLEARED') => ({ id, status, allocatedPesewas: allocated });

  it('asks back the credit note’s amount from the cleared payment that paid the most of the sale', () => {
    expect(planReturnRefund(Money.ofPesewas(4_000n), Money.ofPesewas(4_000n), [cash('small', 1_000), cash('big', 5_000)])).toEqual({ paymentId: 'big', amount: Money.ofPesewas(4_000n) });
  });

  it('asks back no more than the sale owes the customer after the credit', () => {
    expect(planReturnRefund(Money.ofPesewas(4_000n), Money.ofPesewas(2_500n), [cash('p', 6_000)])).toEqual({ paymentId: 'p', amount: Money.ofPesewas(2_500n) });
  });

  it('asks for nothing when the sale owes the customer nothing: an unpaid invoice is simply credited', () => {
    expect(planReturnRefund(Money.ofPesewas(4_000n), Money.zero(), [cash('p', 6_000)])).toBeNull();
    expect(planReturnRefund(Money.ofPesewas(4_000n), Money.ofPesewas(4_000n), [cash('p', 6_000, 'REVERSED'), cash('q', 6_000, 'PENDING')])).toBeNull();
  });

  it('breaks a tie between two payments by the first that was taken', () => {
    expect(planReturnRefund(Money.ofPesewas(1n), Money.ofPesewas(1n), [cash('first', 3_000), cash('second', 3_000)])).toEqual({ paymentId: 'first', amount: Money.ofPesewas(1n) });
  });
});
