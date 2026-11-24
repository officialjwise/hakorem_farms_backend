import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { judgeTillInvoicePayment } from './till-invoice';

/** A customer paying an invoice in cash at the till (A-212 (a), A-285 (g)): exact pesewas, nothing but an open invoice of the till's branch. */
const invoice = { kind: 'INVOICE', status: 'ISSUED' as const, branchId: 'ddw', outstandingPesewas: 42_560n };
const facts = (over: Partial<Parameters<typeof judgeTillInvoicePayment>[0]> = {}) => ({ document: invoice, branchId: 'ddw', amount: Money.ofPesewas(42_560n), tendered: null, ...over });

describe('judgeTillInvoicePayment', () => {
  it('takes the whole outstanding amount, or part of it, with change from what was handed over', () => {
    expect(judgeTillInvoicePayment(facts())).toEqual({ ok: true, value: { change: Money.zero(), outstandingAfter: Money.zero() } });
    const part = judgeTillInvoicePayment(facts({ amount: Money.ofPesewas(20_001n), tendered: Money.ofPesewas(50_000n) }));
    expect(part.ok && part.value.change.pesewas).toBe(29_999n);
    expect(part.ok && part.value.outstandingAfter.pesewas).toBe(22_559n);
    const exact = judgeTillInvoicePayment(facts({ tendered: Money.ofPesewas(42_560n) }));
    expect(exact.ok && exact.value.change.pesewas).toBe(0n);
  });

  it('refuses more than is outstanding, nothing, or less handed over than is paid, by one pesewa', () => {
    expect(judgeTillInvoicePayment(facts({ amount: Money.ofPesewas(42_561n) }))).toEqual({ ok: false, error: ['AMOUNT_EXCEEDS_OUTSTANDING'] });
    expect(judgeTillInvoicePayment(facts({ amount: Money.zero() }))).toEqual({ ok: false, error: ['AMOUNT_NOT_POSITIVE'] });
    expect(judgeTillInvoicePayment(facts({ tendered: Money.ofPesewas(42_559n) }))).toEqual({ ok: false, error: ['TENDERED_BELOW_AMOUNT'] });
  });

  it('refuses a document that is not an issued invoice of the till’s branch, or one already settled', () => {
    expect(judgeTillInvoicePayment(facts({ document: { ...invoice, kind: 'RECEIPT' } }))).toEqual({ ok: false, error: ['NOT_AN_INVOICE'] });
    expect(judgeTillInvoicePayment(facts({ document: { ...invoice, status: 'DRAFT' } }))).toEqual({ ok: false, error: ['INVOICE_NOT_ISSUED'] });
    expect(judgeTillInvoicePayment(facts({ document: { ...invoice, branchId: 'tma' } }))).toEqual({ ok: false, error: ['INVOICE_OTHER_BRANCH'] });
    expect(judgeTillInvoicePayment(facts({ document: { ...invoice, outstandingPesewas: 0n }, amount: Money.ofPesewas(1n) }))).toEqual({ ok: false, error: ['INVOICE_SETTLED'] });
  });

  it("takes a guest's issued receipt of a sales order with something outstanding, as an invoice (A-366 (d), the parent session's leave of 2026-11-24)", () => {
    const receipt = { kind: 'RECEIPT', status: 'ISSUED' as const, branchId: 'ddw', outstandingPesewas: 12_000n, orderDocumentId: 'order-1' };
    expect(judgeTillInvoicePayment(facts({ document: receipt, amount: Money.ofPesewas(12_000n) }))).toEqual({ ok: true, value: { change: Money.zero(), outstandingAfter: Money.zero() } });
    const part = judgeTillInvoicePayment(facts({ document: receipt, amount: Money.ofPesewas(5_000n) }));
    expect(part.ok && part.value.outstandingAfter.pesewas).toBe(7_000n);
    expect(judgeTillInvoicePayment(facts({ document: receipt, amount: Money.ofPesewas(12_001n) }))).toEqual({ ok: false, error: ['AMOUNT_EXCEEDS_OUTSTANDING'] });
    expect(judgeTillInvoicePayment(facts({ document: { ...receipt, branchId: 'tma' }, amount: Money.ofPesewas(1n) }))).toEqual({ ok: false, error: ['INVOICE_OTHER_BRANCH'] });
  });

  it('still refuses a receipt with nothing outstanding, one not of an order, one not issued, and every other kind, as NOT_AN_INVOICE', () => {
    const receipt = { kind: 'RECEIPT', status: 'ISSUED' as const, branchId: 'ddw', outstandingPesewas: 12_000n, orderDocumentId: 'order-1' };
    expect(judgeTillInvoicePayment(facts({ document: { ...receipt, outstandingPesewas: 0n }, amount: Money.ofPesewas(1n) }))).toEqual({ ok: false, error: ['NOT_AN_INVOICE'] });
    expect(judgeTillInvoicePayment(facts({ document: { ...receipt, orderDocumentId: null }, amount: Money.ofPesewas(1n) }))).toEqual({ ok: false, error: ['NOT_AN_INVOICE'] });
    expect(judgeTillInvoicePayment(facts({ document: { ...receipt, status: 'DRAFT' }, amount: Money.ofPesewas(1n) }))).toEqual({ ok: false, error: ['NOT_AN_INVOICE'] });
    for (const kind of ['CREDIT_NOTE', 'DEBIT_NOTE', 'PROFORMA']) expect(judgeTillInvoicePayment(facts({ document: { ...receipt, kind }, amount: Money.ofPesewas(1n) }))).toEqual({ ok: false, error: ['NOT_AN_INVOICE'] });
  });
});
