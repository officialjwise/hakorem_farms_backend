import { describe, expect, it } from 'vitest';
import { judgeCancellation, judgeVoid, judgeVoidApprover, planCancellationMoney, type VoidFacts, type VoidPayment } from './reversal';

const cash = (over: Partial<VoidPayment> = {}): VoidPayment => ({ id: 'p1', methodKind: 'CASH', status: 'CLEARED', refundedPesewas: 0, ...over });
const sale = (over: Partial<VoidFacts> = {}): VoidFacts => ({
  status: 'COMPLETED',
  fulfilmentMode: 'COUNTER',
  completedOn: '2026-11-17',
  today: '2026-11-17',
  payments: [cash()],
  voidPending: false,
  reversalPending: false,
  ...over,
});

describe('cancellation (FR-ORD-014)', () => {
  it('cancels an order that is placed, confirmed, being picked or waiting for its customer (B11), and refuses one in any other status', () => {
    for (const status of ['PLACED', 'CONFIRMED', 'PICKING', 'AWAITING_CUSTOMER'] as const) expect(judgeCancellation(status), status).toEqual({ ok: true, value: null });
    for (const status of ['PACKED', 'READY_FOR_COLLECTION', 'DISPATCHED', 'DELIVERED', 'DELIVERY_FAILED', 'RETURNED', 'COMPLETED', 'CANCELLED', 'VOIDED'] as const) {
      expect(judgeCancellation(status), status).toEqual({ ok: false, error: 'INVALID_STATE_TRANSITION' });
    }
  });

  it('asks back exactly what each cleared payment still holds, releases each pending charge, and leaves the rest', () => {
    const plan = planCancellationMoney([
      { id: 'deposit', status: 'CLEARED', amountPesewas: 84_000, allocatedPesewas: 0, refundedPesewas: 0 },
      { id: 'part', status: 'CLEARED', amountPesewas: 1_999, allocatedPesewas: 0, refundedPesewas: 1 },
      { id: 'pending', status: 'PENDING', amountPesewas: 5_000, allocatedPesewas: 0, refundedPesewas: 0 },
      { id: 'spent', status: 'CLEARED', amountPesewas: 500, allocatedPesewas: 200, refundedPesewas: 300 },
      { id: 'failed', status: 'FAILED', amountPesewas: 700, allocatedPesewas: 0, refundedPesewas: 0 },
      { id: 'reversed', status: 'REVERSED', amountPesewas: 900, allocatedPesewas: 0, refundedPesewas: 0 },
    ]);
    expect(plan.refunds.map((r) => [r.paymentId, r.amount.pesewas])).toEqual([
      ['deposit', 84_000n],
      ['part', 1_998n],
    ]);
    expect(plan.releases).toEqual(['pending']);
    expect(plan.total.pesewas).toBe(85_998n);
  });

  it('asks for nothing when nothing was paid', () => {
    const plan = planCancellationMoney([]);
    expect(plan).toMatchObject({ refunds: [], releases: [] });
    expect(plan.total.pesewas).toBe(0n);
  });
});

describe('a void of a completed sale (FR-ORD-002, abuse case 1)', () => {
  it('voids a completed counter or collection sale on the day it was made, paid in cash or store credit', () => {
    expect(judgeVoid(sale())).toEqual({ ok: true, value: null });
    expect(judgeVoid(sale({ fulfilmentMode: 'COLLECTION', payments: [cash(), cash({ id: 'p2', methodKind: 'STORE_CREDIT' })] }))).toEqual({ ok: true, value: null });
  });

  it('refuses a void of an order that is not completed', () => {
    expect(judgeVoid(sale({ status: 'CONFIRMED' }))).toEqual({ ok: false, error: ['INVALID_STATE_TRANSITION'] });
    expect(judgeVoid(sale({ status: 'VOIDED' }))).toEqual({ ok: false, error: ['INVALID_STATE_TRANSITION'] });
  });

  it('refuses a void after the sale day, a delivered sale, and one already waiting for approval, naming each', () => {
    expect(judgeVoid(sale({ today: '2026-11-18' }))).toEqual({ ok: false, error: ['VOID_DAY_CLOSED'] });
    expect(judgeVoid(sale({ completedOn: null }))).toEqual({ ok: false, error: ['VOID_DAY_CLOSED'] });
    expect(judgeVoid(sale({ fulfilmentMode: 'DELIVERY' }))).toEqual({ ok: false, error: ['NOT_A_COUNTER_SALE'] });
    expect(judgeVoid(sale({ voidPending: true }))).toEqual({ ok: false, error: ['VOID_PENDING'] });
    expect(judgeVoid(sale({ today: '2026-11-18', voidPending: true, fulfilmentMode: 'DELIVERY' }))).toEqual({ ok: false, error: ['VOID_DAY_CLOSED', 'NOT_A_COUNTER_SALE', 'VOID_PENDING'] });
  });

  it('refuses a void whose money cannot simply be reversed: mobile money, card, cheque or bank transfer, a refunded or uncleared payment', () => {
    for (const methodKind of ['MOBILE_MONEY', 'CARD', 'CHEQUE', 'BANK_TRANSFER']) {
      expect(judgeVoid(sale({ payments: [cash({ methodKind })] })), methodKind).toEqual({ ok: false, error: ['TENDER_NOT_VOIDABLE'] });
    }
    expect(judgeVoid(sale({ payments: [cash({ refundedPesewas: 1 })] }))).toEqual({ ok: false, error: ['TENDER_NOT_VOIDABLE'] });
    expect(judgeVoid(sale({ payments: [cash({ status: 'PENDING' })] }))).toEqual({ ok: false, error: ['TENDER_NOT_VOIDABLE'] });
  });

  it('takes no reversed or failed payment into account: what was already given back is not given back twice', () => {
    expect(judgeVoid(sale({ payments: [cash(), cash({ id: 'p2', methodKind: 'MOBILE_MONEY', status: 'FAILED' })] }))).toEqual({ ok: true, value: null });
  });

  it('lets a supervisor approve who is neither the cashier who made the sale nor its salesperson', () => {
    expect(judgeVoidApprover('supervisor', { postedBy: 'cashier', salespersonId: 'cashier' })).toEqual({ ok: true, value: null });
    expect(judgeVoidApprover('supervisor', { postedBy: 'cashier', salespersonId: null })).toEqual({ ok: true, value: null });
    expect(judgeVoidApprover('cashier', { postedBy: 'cashier', salespersonId: null })).toEqual({ ok: false, error: 'CASHIER_CANNOT_APPROVE_VOID' });
    expect(judgeVoidApprover('sales', { postedBy: 'cashier', salespersonId: 'sales' })).toEqual({ ok: false, error: 'CASHIER_CANNOT_APPROVE_VOID' });
  });
});

describe('a void waits while a reversal of its payment waits (BL-077)', () => {
  it('refuses REVERSAL_PENDING beside any other refusal, and allows the void once nothing waits', () => {
    expect(judgeVoid(sale({ reversalPending: true }))).toEqual({ ok: false, error: ['REVERSAL_PENDING'] });
    expect(judgeVoid(sale({ reversalPending: true, today: '2026-11-18' }))).toEqual({ ok: false, error: ['VOID_DAY_CLOSED', 'REVERSAL_PENDING'] });
    expect(judgeVoid(sale({ reversalPending: false }))).toEqual({ ok: true, value: null });
  });
});
