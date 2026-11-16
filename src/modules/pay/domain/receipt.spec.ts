import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { judgeChequeClearance, judgeReceipt, judgeRedemption, judgeReversal, type ReceiptFacts, type ReversiblePayment } from './receipt';

const cheque: ReceiptFacts = {
  methodKind: 'CHEQUE',
  methodLive: true,
  amountPesewas: 100_000n,
  allocationsPesewas: [100_000n],
  customerKnown: true,
  bankAccount: { kind: 'BANK', isActive: true },
  externalReference: 'GCB-004512',
  shiftNamed: false,
  receivedAt: new Date('2026-11-16T09:00:00Z'),
  now: new Date('2026-11-16T10:00:00Z'),
};

describe('how a payment recorded by hand clears, by its method (FR-PAY-001, FR-PAY-005, abuse case 4)', () => {
  it('records a cheque PENDING in cheques awaiting clearance, its allocations applied at once', () => {
    expect(judgeReceipt(cheque)).toEqual({ ok: true, value: { status: 'PENDING', postsAtReceipt: true } });
  });

  it('records a bank transfer PENDING with nothing posted until a statement line matches it', () => {
    expect(judgeReceipt({ ...cheque, methodKind: 'BANK_TRANSFER', allocationsPesewas: [], externalReference: null })).toEqual({ ok: true, value: { status: 'PENDING', postsAtReceipt: false } });
  });

  it('clears store credit at once against the customer', () => {
    expect(judgeReceipt({ ...cheque, methodKind: 'STORE_CREDIT', bankAccount: null, externalReference: null })).toEqual({ ok: true, value: { status: 'CLEARED', postsAtReceipt: true } });
  });

  it('never records mobile money or card by hand: only the provider clears them', () => {
    expect(judgeReceipt({ ...cheque, methodKind: 'MOBILE_MONEY', bankAccount: null })).toEqual({ ok: false, error: ['REQUIRES_VERIFICATION'] });
    expect(judgeReceipt({ ...cheque, methodKind: 'CARD', bankAccount: null })).toEqual({ ok: false, error: ['REQUIRES_VERIFICATION'] });
  });

  it('refuses cash here: a till comes from an open shift, cash with a driver from a delivery', () => {
    expect(judgeReceipt({ ...cheque, methodKind: 'CASH', bankAccount: null })).toEqual({ ok: false, error: ['TENDER_NOT_AVAILABLE'] });
  });

  it('names every rule a cheque breaks at once', () => {
    const broken = judgeReceipt({ ...cheque, methodLive: false, amountPesewas: 0n, allocationsPesewas: [], customerKnown: false, bankAccount: null, externalReference: null, shiftNamed: true, receivedAt: new Date('2026-11-16T10:00:01Z') });
    expect(broken).toEqual({ ok: false, error: ['METHOD_DISABLED', 'AMOUNT_NOT_POSITIVE', 'CUSTOMER_UNKNOWN', 'SHIFT_NOT_AVAILABLE', 'RECEIVED_IN_FUTURE', 'BANK_ACCOUNT_REQUIRED', 'CHEQUE_NUMBER_REQUIRED'] });
  });

  it('refuses a bank account that is not an active bank account, and allocations beyond the amount', () => {
    expect(judgeReceipt({ ...cheque, bankAccount: { kind: 'MOBILE_MONEY', isActive: true } })).toEqual({ ok: false, error: ['BANK_ACCOUNT_NOT_USABLE'] });
    expect(judgeReceipt({ ...cheque, bankAccount: { kind: 'BANK', isActive: false } })).toEqual({ ok: false, error: ['BANK_ACCOUNT_NOT_USABLE'] });
    expect(judgeReceipt({ ...cheque, allocationsPesewas: [60_000n, 40_001n] })).toEqual({ ok: false, error: ['ALLOCATIONS_EXCEED_AMOUNT'] });
    expect(judgeReceipt({ ...cheque, allocationsPesewas: [60_000n, 0n] })).toEqual({ ok: false, error: ['ALLOCATION_NOT_POSITIVE'] });
  });

  it('refuses allocations on a bank transfer still pending, and store credit with no customer or with a bank account', () => {
    expect(judgeReceipt({ ...cheque, methodKind: 'BANK_TRANSFER' })).toEqual({ ok: false, error: ['ALLOCATION_WHILE_PENDING'] });
    expect(judgeReceipt({ ...cheque, methodKind: 'STORE_CREDIT', customerKnown: null, bankAccount: null, externalReference: null })).toEqual({ ok: false, error: ['CUSTOMER_REQUIRED'] });
    expect(judgeReceipt({ ...cheque, methodKind: 'STORE_CREDIT', externalReference: null })).toEqual({ ok: false, error: ['BANK_ACCOUNT_NOT_FOR_METHOD'] });
  });
});

describe('store credit is never redeemed beyond its balance (FR-PAY-015)', () => {
  it('redeems exactly the balance and nothing more', () => {
    expect(judgeRedemption(Money.ofPesewas(6_000n), Money.ofPesewas(6_000n))).toEqual({ ok: true, value: Money.ofPesewas(0n) });
    expect(judgeRedemption(Money.ofPesewas(6_000n), Money.ofPesewas(6_001n))).toEqual({ ok: false, error: 'STORE_CREDIT_INSUFFICIENT' });
    expect(judgeRedemption(Money.ofPesewas(0n), Money.ofPesewas(1n))).toEqual({ ok: false, error: 'STORE_CREDIT_INSUFFICIENT' });
  });
});

describe('a cheque clears on the bank’s confirmation (FR-PAY-011)', () => {
  const pending = { methodKind: 'CHEQUE' as const, status: 'PENDING' as const, receivedOn: '2026-11-16' };

  it('clears a pending cheque on a date between its receipt and today', () => {
    expect(judgeChequeClearance(pending, '2026-11-16', '2026-11-20')).toEqual({ ok: true, value: undefined });
    expect(judgeChequeClearance(pending, '2026-11-20', '2026-11-20')).toEqual({ ok: true, value: undefined });
  });

  it('refuses a date before the cheque was received or after today, a cleared cheque, and anything but a cheque', () => {
    expect(judgeChequeClearance(pending, '2026-11-15', '2026-11-20')).toEqual({ ok: false, error: ['CLEARED_ON_OUT_OF_RANGE'] });
    expect(judgeChequeClearance(pending, '2026-11-21', '2026-11-20')).toEqual({ ok: false, error: ['CLEARED_ON_OUT_OF_RANGE'] });
    expect(judgeChequeClearance({ ...pending, status: 'CLEARED' }, '2026-11-20', '2026-11-20')).toEqual({ ok: false, error: ['CHEQUE_NOT_PENDING'] });
    expect(judgeChequeClearance({ ...pending, methodKind: 'BANK_TRANSFER' }, '2026-11-20', '2026-11-20')).toEqual({ ok: false, error: ['NOT_A_CHEQUE'] });
  });
});

describe('what a reversal does to its payment (FR-PAY-011, FR-PAY-014)', () => {
  const cleared: ReversiblePayment = { methodKind: 'MOBILE_MONEY', status: 'CLEARED', reversesPaymentId: null, refundedPesewas: 0n };

  it('reverses a cleared payment, and bounces a cheque still awaiting clearance', () => {
    expect(judgeReversal(cleared, { domain: 'PAYMENT_REVERSAL', code: 'RECORDED_IN_ERROR' })).toEqual({ ok: true, value: { becomes: 'REVERSED' } });
    expect(judgeReversal({ ...cleared, methodKind: 'CHEQUE', status: 'PENDING' }, { domain: 'PAYMENT_REVERSAL', code: 'CHEQUE_DISHONOURED' })).toEqual({ ok: true, value: { becomes: 'FAILED' } });
    expect(judgeReversal({ ...cleared, methodKind: 'CHEQUE' }, { domain: 'PAYMENT_REVERSAL', code: 'CHEQUE_DISHONOURED' })).toEqual({ ok: true, value: { becomes: 'REVERSED' } });
  });

  it('refuses a payment that posted nothing, one already reversed or a reversing payment, and one with a refund', () => {
    expect(judgeReversal({ ...cleared, status: 'PENDING' }, { domain: 'PAYMENT_REVERSAL', code: 'RECORDED_IN_ERROR' })).toEqual({ ok: false, error: ['NOT_REVERSIBLE'] });
    expect(judgeReversal({ ...cleared, methodKind: 'BANK_TRANSFER', status: 'PENDING' }, { domain: 'PAYMENT_REVERSAL', code: 'RECORDED_IN_ERROR' })).toEqual({ ok: false, error: ['NOT_REVERSIBLE'] });
    expect(judgeReversal({ ...cleared, status: 'REVERSED' }, { domain: 'PAYMENT_REVERSAL', code: 'RECORDED_IN_ERROR' })).toEqual({ ok: false, error: ['NOT_REVERSIBLE'] });
    expect(judgeReversal({ ...cleared, status: 'FAILED' }, { domain: 'PAYMENT_REVERSAL', code: 'RECORDED_IN_ERROR' })).toEqual({ ok: false, error: ['NOT_REVERSIBLE'] });
    expect(judgeReversal({ ...cleared, status: 'REVERSED', reversesPaymentId: 'x' }, { domain: 'PAYMENT_REVERSAL', code: 'RECORDED_IN_ERROR' })).toEqual({ ok: false, error: ['NOT_REVERSIBLE'] });
    expect(judgeReversal({ ...cleared, refundedPesewas: 1n }, { domain: 'PAYMENT_REVERSAL', code: 'RECORDED_IN_ERROR' })).toEqual({ ok: false, error: ['PAYMENT_HAS_REFUNDS'] });
  });

  it('takes only a payment reversal reason, and a dishonoured cheque only for a cheque', () => {
    expect(judgeReversal(cleared, { domain: 'REFUND', code: 'OVERCHARGED' })).toEqual({ ok: false, error: ['REASON_UNKNOWN'] });
    expect(judgeReversal(cleared, null)).toEqual({ ok: false, error: ['REASON_UNKNOWN'] });
    expect(judgeReversal(cleared, { domain: 'PAYMENT_REVERSAL', code: 'CHEQUE_DISHONOURED' })).toEqual({ ok: false, error: ['REASON_NOT_FOR_METHOD'] });
  });
});
