import { describe, expect, it } from 'vitest';
import { judgeClearedTender, type ClearedPaymentFacts, type ClearedTenderFacts } from './cleared-tender';

const SHIFT = '019a7a93-f6b4-7865-8d9d-8f27bac90805';
const BRANCH = '019a7a83-2aef-79e3-9f1b-a708a7ae1fe6';
const MOMO = '019a7a85-0000-7000-8000-00000000000a';

/** A mobile money payment of 4,000 the provider confirmed, taken at the cashier's own till shift for nobody in particular. */
const payment = (fields: Partial<ClearedPaymentFacts> = {}): ClearedPaymentFacts => ({
  status: 'CLEARED',
  methodKind: 'MOBILE_MONEY',
  paymentMethodId: MOMO,
  verification: 'PROVIDER_CALLBACK',
  amountPesewas: 4_000n,
  allocatedPesewas: 0n,
  refundedPesewas: 0n,
  customerId: null,
  branchId: BRANCH,
  shiftDocumentId: SHIFT,
  orderDocumentId: null,
  linkedToOrder: false,
  ...fields,
});
const tender = (fields: Partial<ClearedTenderFacts> = {}): ClearedTenderFacts => ({ paymentMethodId: MOMO, amountPesewas: 4_000n, customerId: null, branchId: BRANCH, shiftDocumentId: SHIFT, ...fields });

describe('a cleared provider payment as a counter tender (FR-POS-006, abuse case 4, ADR-0079)', () => {
  it('accepts a 4,000 mobile money payment the provider confirmed on this shift, as a tender of exactly 4,000', () => {
    expect(judgeClearedTender(payment(), tender())).toEqual({ ok: true, value: null });
    expect(judgeClearedTender(payment({ verification: 'PROVIDER_LOOKUP' }), tender())).toEqual({ ok: true, value: null });
  });

  it('accepts a card payment the provider confirmed, and the same walk-in customer on both', () => {
    expect(judgeClearedTender(payment({ methodKind: 'CARD' }), tender())).toEqual({ ok: true, value: null });
    expect(judgeClearedTender(payment({ customerId: 'c-1' }), tender({ customerId: 'c-1' }))).toEqual({ ok: true, value: null });
  });

  it('names an unknown payment and another branch alike, so the id tells the cashier nothing', () => {
    expect(judgeClearedTender(null, tender())).toEqual({ ok: false, error: ['PAYMENT_UNKNOWN'] });
    expect(judgeClearedTender(payment({ branchId: 'another-branch', status: 'PENDING', shiftDocumentId: null }), tender())).toEqual({ ok: false, error: ['PAYMENT_UNKNOWN'] });
  });

  it('refuses a payment the provider has not cleared: pending, failed or reversed', () => {
    for (const status of ['PENDING', 'FAILED', 'REVERSED'] as const) {
      expect(judgeClearedTender(payment({ status }), tender()), status).toEqual({ ok: false, error: ['PAYMENT_NOT_CLEARED'] });
    }
  });

  it('refuses a cleared payment no provider verified', () => {
    expect(judgeClearedTender(payment({ verification: 'UNVERIFIED' }), tender())).toEqual({ ok: false, error: ['PAYMENT_NOT_CLEARED'] });
    expect(judgeClearedTender(payment({ verification: 'NOT_REQUIRED' }), tender())).toEqual({ ok: false, error: ['PAYMENT_NOT_CLEARED'] });
  });

  it('refuses cash, a cheque or store credit: only a provider payment is named by id at the counter', () => {
    for (const methodKind of ['CASH', 'CHEQUE', 'STORE_CREDIT', 'BANK_TRANSFER'] as const) {
      expect(judgeClearedTender(payment({ methodKind, verification: 'NOT_REQUIRED' }), tender()), methodKind).toEqual({ ok: false, error: ['NOT_A_PROVIDER_PAYMENT'] });
    }
  });

  it('refuses a tender whose method is not the payment method the customer paid by', () => {
    expect(judgeClearedTender(payment(), tender({ paymentMethodId: 'card-method' }))).toEqual({ ok: false, error: ['METHOD_DIFFERS'] });
  });

  it('allocates a payment once: refused when it is already linked to a sale, taken for an order, allocated or refunded by a single pesewa', () => {
    expect(judgeClearedTender(payment({ linkedToOrder: true }), tender())).toEqual({ ok: false, error: ['PAYMENT_ALREADY_USED'] });
    expect(judgeClearedTender(payment({ orderDocumentId: 'an-online-order' }), tender())).toEqual({ ok: false, error: ['PAYMENT_ALREADY_USED'] });
    expect(judgeClearedTender(payment({ allocatedPesewas: 1n }), tender())).toEqual({ ok: false, error: ['PAYMENT_ALREADY_USED'] });
    expect(judgeClearedTender(payment({ refundedPesewas: 1n }), tender())).toEqual({ ok: false, error: ['PAYMENT_ALREADY_USED'] });
  });

  it('refuses another customer payment, a named customer paying a walk-in sale, and a walk-in payment for a named customer', () => {
    expect(judgeClearedTender(payment({ customerId: 'c-1' }), tender({ customerId: 'c-2' }))).toEqual({ ok: false, error: ['OTHER_CUSTOMER'] });
    expect(judgeClearedTender(payment({ customerId: 'c-1' }), tender())).toEqual({ ok: false, error: ['OTHER_CUSTOMER'] });
    expect(judgeClearedTender(payment(), tender({ customerId: 'c-1' }))).toEqual({ ok: false, error: ['OTHER_CUSTOMER'] });
  });

  it('refuses a payment taken on another shift, or on no shift at all', () => {
    expect(judgeClearedTender(payment({ shiftDocumentId: 'another-shift' }), tender())).toEqual({ ok: false, error: ['OTHER_SHIFT'] });
    expect(judgeClearedTender(payment({ shiftDocumentId: null }), tender())).toEqual({ ok: false, error: ['OTHER_SHIFT'] });
  });

  it('takes the whole payment as the tender, never a part nor more: 3,999 and 4,001 are refused, so no change comes from it', () => {
    expect(judgeClearedTender(payment(), tender({ amountPesewas: 3_999n }))).toEqual({ ok: false, error: ['AMOUNT_DIFFERS'] });
    expect(judgeClearedTender(payment(), tender({ amountPesewas: 4_001n }))).toEqual({ ok: false, error: ['AMOUNT_DIFFERS'] });
  });

  it('names every rule a payment breaks at once', () => {
    expect(judgeClearedTender(payment({ status: 'PENDING', shiftDocumentId: 'another-shift', customerId: 'c-1' }), tender({ amountPesewas: 5_000n }))).toEqual({
      ok: false,
      error: ['PAYMENT_NOT_CLEARED', 'OTHER_CUSTOMER', 'OTHER_SHIFT', 'AMOUNT_DIFFERS'],
    });
  });
});
