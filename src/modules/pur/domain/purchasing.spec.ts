import { Money, Quantity, Rate } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { judgeAllocations, judgeFirstPaymentApprover, judgeOrderAction, judgeReceipt, orderLimitJudgement, orderLineNet, outstanding, paymentApprovalReason, receivedStatus, type AllocationFacts } from './purchasing';

describe('a purchase order line (FR-PUR-005)', () => {
  it('prices 20 broilers at 5,500 as exactly 110,000', () => {
    expect(orderLineNet(Money.ofPesewas(5_500n), Quantity.parse('20.000'))).toEqual(Money.ofPesewas(110_000n));
  });

  it('rounds an exact half pesewa up once at the line', () => {
    // 2.5 bags of feed at 45,025 a bag is 112,562.5 pesewas.
    expect(orderLineNet(Money.ofPesewas(45_025n), Quantity.parse('2.500'))).toEqual(Money.ofPesewas(112_563n));
  });

  it('rounds one below half down and one above half up, and prices nothing at zero', () => {
    expect(orderLineNet(Money.ofPesewas(1n), Quantity.parse('0.499'))).toEqual(Money.zero());
    expect(orderLineNet(Money.ofPesewas(1n), Quantity.parse('0.501'))).toEqual(Money.ofPesewas(1n));
    expect(orderLineNet(Money.zero(), Quantity.parse('20.000'))).toEqual(Money.zero());
  });

  it('carries the largest amount the database holds exactly', () => {
    expect(orderLineNet(Money.ofPesewas(Money.MAX_PESEWAS), Quantity.parse('1.000'))).toEqual(Money.ofPesewas(9_007_199_254_740_991n));
  });
});

describe('receiving against an order line (FR-PUR-007)', () => {
  const twenty = { qtyOrderedBase: Quantity.parse('20.000'), qtyReceived: Quantity.zero(), tolerance: Rate.parsePercent('0') };

  it('leaves 8 outstanding after 12 of 20, refuses 9 more, and completes with 8', () => {
    const after12 = judgeReceipt(twenty, Quantity.parse('12.000'));
    expect(after12).toEqual({ ok: true, value: Quantity.parse('12.000') });
    const line = { ...twenty, qtyReceived: Quantity.parse('12.000') };
    expect(outstanding(line)).toEqual(Quantity.parse('8.000'));
    expect(judgeReceipt(line, Quantity.parse('9.000'))).toEqual({ ok: false, error: 'OVER_RECEIPT' });
    expect(judgeReceipt(line, Quantity.parse('8.000'))).toEqual({ ok: true, value: Quantity.parse('20.000') });
  });

  it('allows a receipt up to the line tolerance and refuses a thousandth beyond it', () => {
    const tolerant = { ...twenty, tolerance: Rate.parsePercent('5') };
    expect(judgeReceipt(tolerant, Quantity.parse('21.000'))).toEqual({ ok: true, value: Quantity.parse('21.000') });
    expect(judgeReceipt(tolerant, Quantity.parse('21.001'))).toEqual({ ok: false, error: 'OVER_RECEIPT' });
    expect(outstanding({ ...tolerant, qtyReceived: Quantity.parse('21.000') })).toEqual(Quantity.zero());
  });

  it('is PARTIALLY_RECEIVED until every line has its ordered quantity, then RECEIVED', () => {
    const half = { qtyOrderedBase: Quantity.parse('20.000'), qtyReceived: Quantity.parse('12.000') };
    const full = { qtyOrderedBase: Quantity.parse('50.000'), qtyReceived: Quantity.parse('50.000') };
    expect(receivedStatus([half, full])).toBe('PARTIALLY_RECEIVED');
    expect(receivedStatus([{ ...half, qtyReceived: Quantity.parse('20.000') }, full])).toBe('RECEIVED');
  });
});

describe('what may happen to an order (FR-PUR-006)', () => {
  it('cancels only before any receipt and closes only after one', () => {
    expect(judgeOrderAction('SENT', 'CANCEL', false)).toEqual({ ok: true, value: 'CANCELLED' });
    expect(judgeOrderAction('APPROVED', 'CANCEL', false)).toEqual({ ok: true, value: 'CANCELLED' });
    expect(judgeOrderAction('PARTIALLY_RECEIVED', 'CANCEL', true)).toEqual({ ok: false, error: 'RECEIVED_ALREADY' });
    expect(judgeOrderAction('PARTIALLY_RECEIVED', 'CLOSE', true)).toEqual({ ok: true, value: 'CLOSED' });
    expect(judgeOrderAction('RECEIVED', 'CLOSE', true)).toEqual({ ok: true, value: 'CLOSED' });
    expect(judgeOrderAction('SENT', 'CLOSE', false)).toEqual({ ok: false, error: 'NOTHING_RECEIVED' });
  });

  it('sends only an approved order, and changes or submits only a draft', () => {
    expect(judgeOrderAction('APPROVED', 'SEND', false)).toEqual({ ok: true, value: 'SENT' });
    expect(judgeOrderAction('DRAFT', 'SEND', false)).toEqual({ ok: false, error: 'WRONG_STATUS' });
    expect(judgeOrderAction('DRAFT', 'SUBMIT', false)).toEqual({ ok: true, value: 'DRAFT' });
    expect(judgeOrderAction('DRAFT', 'UPDATE', false)).toEqual({ ok: true, value: 'DRAFT' });
    expect(judgeOrderAction('PENDING_APPROVAL', 'UPDATE', false)).toEqual({ ok: false, error: 'WRONG_STATUS' });
    expect(judgeOrderAction('CLOSED', 'CANCEL', true)).toEqual({ ok: false, error: 'WRONG_STATUS' });
    expect(judgeOrderAction('CANCELLED', 'CLOSE', false)).toEqual({ ok: false, error: 'WRONG_STATUS' });
  });
});

describe('allocating a supplier payment (FR-PUR-010, FR-PUR-012)', () => {
  const invoice = (gross: bigint, over: Partial<AllocationFacts['invoice']> = {}): AllocationFacts['invoice'] => ({
    supplierId: 'awutu',
    kind: 'INVOICE',
    status: 'APPROVED',
    matchStatus: 'MATCHED',
    grossPesewas: gross,
    promisedPesewas: 0n,
    ...over,
  });

  it('pays 110,000 across invoices of 60,000 and 50,000 exactly', () => {
    const judged = judgeAllocations('awutu', [
      { invoiceId: 'a', amount: Money.ofPesewas(60_000n), invoice: invoice(60_000n) },
      { invoiceId: 'b', amount: Money.ofPesewas(50_000n), invoice: invoice(50_000n) },
    ]);
    expect(judged).toEqual({ ok: true, value: Money.ofPesewas(110_000n) });
  });

  it('refuses 110,001 against the same two invoices', () => {
    const judged = judgeAllocations('awutu', [
      { invoiceId: 'a', amount: Money.ofPesewas(60_001n), invoice: invoice(60_000n) },
      { invoiceId: 'b', amount: Money.ofPesewas(50_000n), invoice: invoice(50_000n) },
    ]);
    expect(judged).toEqual({ ok: false, error: [{ index: 0, rule: 'EXCEEDS_OUTSTANDING' }] });
  });

  it('counts what live payments already promise an invoice', () => {
    const judged = judgeAllocations('awutu', [{ invoiceId: 'a', amount: Money.ofPesewas(10_001n), invoice: invoice(60_000n, { promisedPesewas: 50_000n }) }]);
    expect(judged).toEqual({ ok: false, error: [{ index: 0, rule: 'EXCEEDS_OUTSTANDING' }] });
  });

  it('blocks payment of an invoice that failed the three-way match or is not approved', () => {
    expect(judgeAllocations('awutu', [{ invoiceId: 'a', amount: Money.ofPesewas(1n), invoice: invoice(60_000n, { status: 'MISMATCH', matchStatus: 'MISMATCH' }) }])).toEqual({
      ok: false,
      error: [{ index: 0, rule: 'THREE_WAY_MATCH_FAILED' }],
    });
    expect(judgeAllocations('awutu', [{ invoiceId: 'a', amount: Money.ofPesewas(1n), invoice: invoice(60_000n, { status: 'MATCHED' }) }])).toEqual({
      ok: false,
      error: [{ index: 0, rule: 'NOT_APPROVED' }],
    });
    expect(judgeAllocations('awutu', [{ invoiceId: 'a', amount: Money.ofPesewas(1n), invoice: invoice(60_000n, { matchStatus: 'NOT_REQUIRED' }) }]).ok).toBe(true);
  });

  it("refuses another supplier's invoice, a credit note, an invoice named twice and an empty payment", () => {
    expect(judgeAllocations('awutu', [{ invoiceId: 'a', amount: Money.ofPesewas(1n), invoice: invoice(60_000n, { supplierId: 'dodowa-feeds' }) }])).toEqual({
      ok: false,
      error: [{ index: 0, rule: 'OTHER_SUPPLIER' }],
    });
    expect(judgeAllocations('awutu', [{ invoiceId: 'a', amount: Money.ofPesewas(1n), invoice: invoice(60_000n, { kind: 'CREDIT_NOTE' }) }])).toEqual({
      ok: false,
      error: [{ index: 0, rule: 'OTHER_SUPPLIER' }],
    });
    const twice = judgeAllocations('awutu', [
      { invoiceId: 'a', amount: Money.ofPesewas(1n), invoice: invoice(60_000n) },
      { invoiceId: 'a', amount: Money.ofPesewas(1n), invoice: invoice(60_000n) },
    ]);
    expect(twice).toEqual({ ok: false, error: [{ index: 1, rule: 'DUPLICATE_INVOICE' }] });
    expect(judgeAllocations('awutu', [])).toEqual({ ok: false, error: [{ index: -1, rule: 'NO_ALLOCATIONS' }] });
  });
});

describe('the purchase order approval limit as a setting (owner, 2026-11-15)', () => {
  it('needs approval only above the limit, and keeps the threshold the database holds as the limit plus one pesewa', () => {
    expect(orderLimitJudgement(200_000n, 200_000n)).toEqual({ required: false, thresholdPesewas: 200_001n });
    expect(orderLimitJudgement(200_001n, 200_000n)).toEqual({ required: true, thresholdPesewas: 200_001n });
    expect(orderLimitJudgement(110_000n, 100_000n)).toEqual({ required: true, thresholdPesewas: 100_001n });
  });
});

describe('the first payment after a payout change (owner, 2026-11-15)', () => {
  it('needs a second person whatever the amount, and otherwise follows the payment policy', () => {
    expect(paymentApprovalReason(true, false)).toBe('FIRST_PAYMENT_AFTER_PAYOUT_CHANGE');
    expect(paymentApprovalReason(true, true)).toBe('FIRST_PAYMENT_AFTER_PAYOUT_CHANGE');
    expect(paymentApprovalReason(false, true)).toBe('PAYMENT_POLICY');
    expect(paymentApprovalReason(false, false)).toBeNull();
  });
});

describe('who may approve the first payment after a payout change (owner, 2026-11-15, A-171)', () => {
  it('refuses the person who made the change, and lets anyone else, the change approver included', () => {
    expect(judgeFirstPaymentApprover({ changeMakerId: 'kwabena', approverId: 'kwabena' })).toEqual({ ok: false, error: 'PAYOUT_MAKER_CANNOT_APPROVE' });
    expect(judgeFirstPaymentApprover({ changeMakerId: 'kwabena', approverId: 'akosua' })).toEqual({ ok: true, value: undefined });
  });

  it('places no bar on a payment that is not the first after a change', () => {
    expect(judgeFirstPaymentApprover({ changeMakerId: null, approverId: 'kwabena' })).toEqual({ ok: true, value: undefined });
  });
});
