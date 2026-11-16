import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { judgeRefund, judgeStoredRefund, nextRefundAttempt, REFUND_MAX_ATTEMPTS, refundableOf, refundLeftOf, type CreditNoteFacts, type RefundablePayment } from './refund';

const cleared = (kind: RefundablePayment['methodKind'], amount: bigint, allocated = 0n, refunded = 0n): RefundablePayment => ({
  status: 'CLEARED',
  methodKind: kind,
  hasCustomer: true,
  customerHasPhone: true,
  amount: Money.ofPesewas(amount),
  allocated: Money.ofPesewas(allocated),
  refunded: Money.ofPesewas(refunded),
});

describe('how much of a payment can still be refunded (FR-PAY-012)', () => {
  it('is what was paid less what is allocated less what is already refunded', () => {
    expect(refundableOf(cleared('MOBILE_MONEY', 30_000n, 0n, 25_000n)).pesewas).toBe(5_000n);
    expect(refundableOf(cleared('MOBILE_MONEY', 120_000n, 100_000n, 0n)).pesewas).toBe(20_000n);
  });
});

describe('a refund request (FR-PAY-012, abuse case 12)', () => {
  it('refunds 25,000 of a 30,000 mobile money payment through the provider', () => {
    expect(judgeRefund(cleared('MOBILE_MONEY', 30_000n), Money.ofPesewas(25_000n), 'ORIGINAL_METHOD')).toEqual({ ok: true, value: { route: 'PROVIDER' } });
  });

  it('refuses 6,000 afterwards, with 5,000 left, and takes the 5,000 exactly', () => {
    const after = cleared('MOBILE_MONEY', 30_000n, 0n, 25_000n);
    expect(judgeRefund(after, Money.ofPesewas(6_000n), 'ORIGINAL_METHOD')).toEqual({ ok: false, error: ['REFUND_EXCEEDS_PAYMENT'] });
    expect(judgeRefund(after, Money.ofPesewas(5_001n), 'ORIGINAL_METHOD')).toEqual({ ok: false, error: ['REFUND_EXCEEDS_PAYMENT'] });
    expect(judgeRefund(after, Money.ofPesewas(5_000n), 'ORIGINAL_METHOD')).toEqual({ ok: true, value: { route: 'PROVIDER' } });
  });

  it('refuses a refund larger than was paid, and one of nothing', () => {
    expect(judgeRefund(cleared('CASH', 30_000n), Money.ofPesewas(30_001n), 'ORIGINAL_METHOD')).toEqual({ ok: false, error: ['REFUND_EXCEEDS_PAYMENT'] });
    expect(judgeRefund(cleared('CASH', 30_000n), Money.zero(), 'ORIGINAL_METHOD')).toEqual({ ok: false, error: ['AMOUNT_NOT_POSITIVE'] });
  });

  it('refuses a refund of money allocated to a document: it is taken off first, or credited by a credit note', () => {
    expect(judgeRefund(cleared('CASH', 30_000n, 30_000n), Money.ofPesewas(1n), 'ORIGINAL_METHOD')).toEqual({ ok: false, error: ['REFUND_EXCEEDS_PAYMENT'] });
  });

  it('refunds only a cleared payment', () => {
    expect(judgeRefund({ ...cleared('MOBILE_MONEY', 30_000n), status: 'PENDING' }, Money.ofPesewas(1n), 'ORIGINAL_METHOD')).toEqual({ ok: false, error: ['PAYMENT_NOT_CLEARED'] });
  });

  it('pays a cash or bank transfer original back by hand, and cash only for a cash original', () => {
    expect(judgeRefund(cleared('CASH', 6_000n), Money.ofPesewas(6_000n), 'CASH')).toEqual({ ok: true, value: { route: 'MANUAL' } });
    expect(judgeRefund(cleared('BANK_TRANSFER', 6_000n), Money.ofPesewas(6_000n), 'ORIGINAL_METHOD')).toEqual({ ok: true, value: { route: 'MANUAL' } });
    expect(judgeRefund(cleared('MOBILE_MONEY', 6_000n), Money.ofPesewas(6_000n), 'CASH')).toEqual({ ok: false, error: ['DESTINATION_NOT_AVAILABLE'] });
  });

  it('refunds to store credit for a known customer, paid at once on approval, and a store credit tender back to store credit (FR-PAY-015)', () => {
    expect(judgeRefund(cleared('CASH', 6_000n), Money.ofPesewas(6_000n), 'STORE_CREDIT')).toEqual({ ok: true, value: { route: 'STORE_CREDIT' } });
    expect(judgeRefund(cleared('STORE_CREDIT', 6_000n), Money.ofPesewas(6_000n), 'ORIGINAL_METHOD')).toEqual({ ok: true, value: { route: 'STORE_CREDIT' } });
    expect(judgeRefund({ ...cleared('CASH', 6_000n), hasCustomer: false }, Money.ofPesewas(6_000n), 'STORE_CREDIT')).toEqual({ ok: false, error: ['DESTINATION_NOT_AVAILABLE'] });
  });

  it('never credits the walk-in, and never a customer with no phone number to reach them by (the owner, 2026-11-16)', () => {
    expect(judgeRefund({ ...cleared('CASH', 6_000n), hasCustomer: false, customerHasPhone: false }, Money.ofPesewas(6_000n), 'STORE_CREDIT')).toEqual({ ok: false, error: ['DESTINATION_NOT_AVAILABLE'] });
    expect(judgeRefund({ ...cleared('CASH', 6_000n), customerHasPhone: false }, Money.ofPesewas(6_000n), 'STORE_CREDIT')).toEqual({ ok: false, error: ['STORE_CREDIT_NEEDS_PHONE'] });
    expect(judgeRefund({ ...cleared('STORE_CREDIT', 6_000n), customerHasPhone: false }, Money.ofPesewas(6_000n), 'ORIGINAL_METHOD')).toEqual({ ok: false, error: ['STORE_CREDIT_NEEDS_PHONE'] });
    expect(judgeRefund({ ...cleared('MOBILE_MONEY', 6_000n), customerHasPhone: false }, Money.ofPesewas(6_000n), 'ORIGINAL_METHOD')).toEqual({ ok: true, value: { route: 'PROVIDER' } });
  });

  it('pays a cheque back to its original method through a bank payout, paid by hand with its reference (ADR-0066)', () => {
    expect(judgeRefund(cleared('CHEQUE', 6_000n), Money.ofPesewas(6_000n), 'ORIGINAL_METHOD')).toEqual({ ok: true, value: { route: 'BANK_PAYOUT' } });
    expect(judgeRefund(cleared('CHEQUE', 6_000n), Money.ofPesewas(6_000n), 'STORE_CREDIT')).toEqual({ ok: true, value: { route: 'STORE_CREDIT' } });
    expect(judgeRefund(cleared('CHEQUE', 6_000n), Money.ofPesewas(6_000n), 'CASH')).toEqual({ ok: false, error: ['DESTINATION_NOT_AVAILABLE'] });
  });

  it('names every refusal at once', () => {
    expect(judgeRefund({ ...cleared('MOBILE_MONEY', 1n), status: 'FAILED', hasCustomer: false }, Money.ofPesewas(2n), 'STORE_CREDIT')).toEqual({ ok: false, error: ['PAYMENT_NOT_CLEARED', 'REFUND_EXCEEDS_PAYMENT', 'DESTINATION_NOT_AVAILABLE'] });
  });
});

describe('a refund against a credit note on a paid document (FR-PAY-012, FR-BIL-007, ADR-0066)', () => {
  // An invoice of 86,240 paid in full by one payment, then credited 30,000: the payment has nothing unallocated, and the
  // credit note leaves 30,000 owed back to the customer.
  const paid = cleared('MOBILE_MONEY', 86_240n, 86_240n);
  const note = (left: bigint, paidByPayment = 86_240n, over: Partial<CreditNoteFacts> = {}): CreditNoteFacts => ({
    issued: true,
    matchesPayment: true,
    left: Money.ofPesewas(left),
    paidByPayment: Money.ofPesewas(paidByPayment),
    ...over,
  });

  it('draws on the credit note, not on the payment\'s unallocated money: 30,000 of a fully allocated payment', () => {
    expect(judgeRefund(paid, Money.ofPesewas(30_000n), 'ORIGINAL_METHOD', note(30_000n))).toEqual({ ok: true, value: { route: 'PROVIDER' } });
    expect(judgeRefund(paid, Money.ofPesewas(30_000n), 'ORIGINAL_METHOD')).toEqual({ ok: false, error: ['REFUND_EXCEEDS_PAYMENT'] });
  });

  it('never exceeds the credit note\'s amount less what was already refunded against it: one pesewa over is refused', () => {
    expect(judgeRefund(paid, Money.ofPesewas(20_000n), 'ORIGINAL_METHOD', note(20_000n))).toEqual({ ok: true, value: { route: 'PROVIDER' } });
    expect(judgeRefund(paid, Money.ofPesewas(20_001n), 'ORIGINAL_METHOD', note(20_000n))).toEqual({ ok: false, error: ['REFUND_EXCEEDS_CREDIT_NOTE'] });
    expect(judgeRefund(paid, Money.ofPesewas(1n), 'ORIGINAL_METHOD', note(0n))).toEqual({ ok: false, error: ['REFUND_EXCEEDS_CREDIT_NOTE'] });
  });

  it('goes back only through a payment that paid the credited document, and never more than it paid there', () => {
    expect(judgeRefund(paid, Money.ofPesewas(10_001n), 'ORIGINAL_METHOD', note(30_000n, 10_000n))).toEqual({ ok: false, error: ['REFUND_EXCEEDS_PAYMENT'] });
    expect(judgeRefund(paid, Money.ofPesewas(10_000n), 'ORIGINAL_METHOD', note(30_000n, 10_000n))).toEqual({ ok: true, value: { route: 'PROVIDER' } });
    expect(judgeRefund(paid, Money.ofPesewas(1n), 'ORIGINAL_METHOD', note(30_000n, 0n))).toEqual({ ok: false, error: ['REFUND_EXCEEDS_PAYMENT'] });
  });

  it('refuses a credit note that is not issued, or is another customer\'s or another branch\'s', () => {
    expect(judgeRefund(paid, Money.ofPesewas(1n), 'ORIGINAL_METHOD', note(30_000n, 86_240n, { issued: false }))).toEqual({ ok: false, error: ['CREDIT_NOTE_NOT_AVAILABLE'] });
    expect(judgeRefund(paid, Money.ofPesewas(1n), 'ORIGINAL_METHOD', note(30_000n, 86_240n, { matchesPayment: false }))).toEqual({ ok: false, error: ['CREDIT_NOTE_NOT_AVAILABLE'] });
  });

  it('pays a cheque\'s credit back through a bank payout and keeps the store credit rules', () => {
    expect(judgeRefund(cleared('CHEQUE', 86_240n, 86_240n), Money.ofPesewas(30_000n), 'ORIGINAL_METHOD', note(30_000n))).toEqual({ ok: true, value: { route: 'BANK_PAYOUT' } });
    expect(judgeRefund({ ...paid, customerHasPhone: false }, Money.ofPesewas(30_000n), 'STORE_CREDIT', note(30_000n))).toEqual({ ok: false, error: ['STORE_CREDIT_NEEDS_PHONE'] });
    expect(judgeRefund({ ...paid, hasCustomer: false }, Money.ofPesewas(30_000n), 'STORE_CREDIT', note(30_000n))).toEqual({ ok: false, error: ['DESTINATION_NOT_AVAILABLE'] });
  });

  it('names every refusal at once', () => {
    expect(judgeRefund({ ...paid, status: 'REVERSED' }, Money.ofPesewas(0n), 'CASH', note(30_000n, 86_240n, { issued: false }))).toEqual({
      ok: false,
      error: ['AMOUNT_NOT_POSITIVE', 'PAYMENT_NOT_CLEARED', 'CREDIT_NOTE_NOT_AVAILABLE', 'DESTINATION_NOT_AVAILABLE'],
    });
  });

  it('judges a stored payment and credit note in integer pesewas', () => {
    const stored = { status: 'CLEARED' as const, methodKind: 'CASH' as const, amountPesewas: 86_240n, allocatedPesewas: 86_240n, refundedPesewas: 0n };
    const facts = { issued: true, matchesPayment: true, leftPesewas: 30_000n, paidByPaymentPesewas: 86_240n };
    expect(judgeStoredRefund(stored, 30_000n, 'ORIGINAL_METHOD', facts)).toEqual({ ok: true, value: { route: 'MANUAL' } });
    expect(judgeStoredRefund(stored, 30_001n, 'ORIGINAL_METHOD', facts)).toEqual({ ok: false, error: ['REFUND_EXCEEDS_CREDIT_NOTE'] });
  });
});

describe('a provider refund that fails is retried with backoff, then queued for a person (FR-PAY-013)', () => {
  const now = new Date('2026-11-16T10:00:00Z');

  it('retries after 5, then 10 minutes', () => {
    expect(nextRefundAttempt(1, now)).toEqual({ kind: 'RETRY', at: new Date('2026-11-16T10:05:00Z') });
    expect(nextRefundAttempt(2, now)).toEqual({ kind: 'RETRY', at: new Date('2026-11-16T10:10:00Z') });
  });

  it('stops after the third failure and raises a break', () => {
    expect(REFUND_MAX_ATTEMPTS).toBe(3);
    expect(nextRefundAttempt(3, now)).toEqual({ kind: 'EXHAUSTED' });
  });
});

describe('the same rules over a payment as it is stored', () => {
  const stored = { status: 'CLEARED' as const, methodKind: 'MOBILE_MONEY' as const, amountPesewas: 30_000n, allocatedPesewas: 0n, refundedPesewas: 25_000n };

  it('leaves 5,000 of a 30,000 payment with 25,000 refunded, and refuses 6,000', () => {
    expect(refundLeftOf(stored)).toBe(5_000n);
    expect(judgeStoredRefund(stored, 6_000n, 'ORIGINAL_METHOD')).toEqual({ ok: false, error: ['REFUND_EXCEEDS_PAYMENT'] });
    expect(judgeStoredRefund(stored, 5_000n, 'ORIGINAL_METHOD')).toEqual({ ok: true, value: { route: 'PROVIDER' } });
  });

  it('credits a stored payment\'s customer only when it is known to have a phone', () => {
    expect(judgeStoredRefund({ ...stored, customerId: 'cus-1', customerHasPhone: true }, 5_000n, 'STORE_CREDIT')).toEqual({ ok: true, value: { route: 'STORE_CREDIT' } });
    expect(judgeStoredRefund({ ...stored, customerId: 'cus-1' }, 5_000n, 'STORE_CREDIT')).toEqual({ ok: false, error: ['STORE_CREDIT_NEEDS_PHONE'] });
  });
});
