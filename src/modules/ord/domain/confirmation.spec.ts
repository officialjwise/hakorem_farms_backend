import { Money, Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { judgeConfirmation, planLineReservation, receivedForOrder } from './confirmation';

const q = (text: string) => Quantity.parse(text);
const rows = (...available: string[]) => available.map((a) => ({ availableQty: q(a) }));

describe('planLineReservation (FR-ORD-005)', () => {
  it('holds a line from the first balance that covers it, taking nothing from the rest', () => {
    const plan = planLineReservation(q('3.000'), rows('5.000', '9.000'));
    expect(plan).toEqual({ kind: 'HELD', pieces: [{ index: 0, qty: q('3.000') }] });
  });

  it('spreads a line across balances oldest first, skipping an empty one, the last piece only what is left', () => {
    const plan = planLineReservation(q('3.000'), rows('2.000', '0.000', '0.500', '4.000'));
    expect(plan.kind).toBe('HELD');
    expect(plan.kind === 'HELD' && plan.pieces.map((p) => [p.index, p.qty.toDecimalString()])).toEqual([
      [0, '2.000'],
      [2, '0.500'],
      [3, '0.500'],
    ]);
  });

  it('holds exactly what is available, to the thousandth, and no more', () => {
    const plan = planLineReservation(q('2.001'), rows('2.000', '0.001'));
    expect(plan.kind === 'HELD' && plan.pieces.map((p) => p.qty.toDecimalString())).toEqual(['2.000', '0.001']);
  });

  it('lists the shortfall of 1 when 3 crates are wanted and 2 are available', () => {
    expect(planLineReservation(q('3.000'), rows('2.000'))).toEqual({ kind: 'SHORT', available: q('2.000'), short: q('1.000') });
  });

  it('is short by the whole line when nothing is available', () => {
    expect(planLineReservation(q('1.000'), [])).toEqual({ kind: 'SHORT', available: q('0.000'), short: q('1.000') });
  });

  it('is short by one thousandth, never rounded away', () => {
    expect(planLineReservation(q('3.000'), rows('2.999'))).toEqual({ kind: 'SHORT', available: q('2.999'), short: q('0.001') });
  });
});

describe('receivedForOrder (FR-ORD-005, FR-ORD-016)', () => {
  it('counts cleared payments less what was refunded, and nothing pending, failed or reversed', () => {
    const received = receivedForOrder([
      { status: 'CLEARED', amountPesewas: 50_000, refundedPesewas: 1_000 },
      { status: 'CLEARED', amountPesewas: 34_000, refundedPesewas: 0 },
      { status: 'PENDING', amountPesewas: 99_000, refundedPesewas: 0 },
      { status: 'FAILED', amountPesewas: 99_000, refundedPesewas: 0 },
      { status: 'REVERSED', amountPesewas: 99_000, refundedPesewas: 0 },
    ]);
    expect(received.pesewas).toBe(83_000n);
  });
});

describe('judgeConfirmation (FR-ORD-005, the OrderConfirmationPolicy port)', () => {
  const estimate = Money.ofPesewas(84_000n);

  it('confirms a cash-on-delivery order with no payment or credit check', () => {
    expect(judgeConfirmation({ paymentTerms: 'COD', estimated: estimate, received: Money.zero(), credit: null })).toEqual({ ok: true, creditCheck: 'NOT_REQUIRED' });
  });

  it('confirms a prepaid order paid exactly its estimate, and refuses it one pesewa short', () => {
    expect(judgeConfirmation({ paymentTerms: 'PREPAID', estimated: estimate, received: Money.ofPesewas(84_000n), credit: null })).toEqual({ ok: true, creditCheck: 'NOT_REQUIRED' });
    expect(judgeConfirmation({ paymentTerms: 'PREPAID', estimated: estimate, received: Money.ofPesewas(83_999n), credit: null })).toEqual({ ok: false, rule: 'PREPAYMENT_SHORT' });
  });

  it('refuses a credit order no policy answers for, and one a policy refuses', () => {
    expect(judgeConfirmation({ paymentTerms: 'CREDIT', estimated: estimate, received: Money.zero(), credit: null })).toEqual({ ok: false, rule: 'CREDIT_CHECK_UNAVAILABLE' });
    expect(judgeConfirmation({ paymentTerms: 'CREDIT', estimated: estimate, received: Money.zero(), credit: 'REFUSED' })).toEqual({ ok: false, rule: 'CREDIT_REFUSED' });
  });

  it('confirms a credit order a policy passes', () => {
    expect(judgeConfirmation({ paymentTerms: 'CREDIT', estimated: estimate, received: Money.zero(), credit: 'PASSED' })).toEqual({ ok: true, creditCheck: 'PASSED' });
  });

  it('never confirms an order on immediate terms: the sale posting completes it at once', () => {
    expect(judgeConfirmation({ paymentTerms: 'IMMEDIATE', estimated: estimate, received: estimate, credit: null })).toEqual({ ok: false, rule: 'TERMS_NOT_CONFIRMED' });
  });
});
