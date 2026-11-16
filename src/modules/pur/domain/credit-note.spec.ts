import { describe, expect, it } from 'vitest';
import { invoicePayable, judgeCreditNote, judgeCreditTarget, settledStatus, type CreditTarget } from './credit-note';

describe('a supplier credit note against its invoice (FR-PUR-011)', () => {
  const awutu110k = { grossPesewas: 110_000n, liveCreditsPesewas: 0n, promisedPesewas: 0n };

  it('takes a credit of 11,000 against a 110,000 invoice and leaves 99,000 payable', () => {
    expect(judgeCreditNote(awutu110k, 11_000n)).toEqual({ ok: true, value: 99_000n });
  });

  it('refuses a second credit of 100,000 once 11,000 is credited, since only 99,000 is uncredited', () => {
    expect(judgeCreditNote({ ...awutu110k, liveCreditsPesewas: 11_000n }, 100_000n)).toEqual({ ok: false, error: 'CREDIT_EXCEEDS_UNCREDITED' });
  });

  it('takes exactly the uncredited amount and refuses one pesewa more', () => {
    expect(judgeCreditNote({ ...awutu110k, liveCreditsPesewas: 11_000n }, 99_000n)).toEqual({ ok: true, value: 0n });
    expect(judgeCreditNote({ ...awutu110k, liveCreditsPesewas: 11_000n }, 99_001n)).toEqual({ ok: false, error: 'CREDIT_EXCEEDS_UNCREDITED' });
  });

  it('counts what live payments already promise the invoice, so a credit never takes it below what is being paid', () => {
    expect(judgeCreditNote({ ...awutu110k, promisedPesewas: 60_000n }, 50_000n)).toEqual({ ok: true, value: 0n });
    expect(judgeCreditNote({ ...awutu110k, promisedPesewas: 60_000n }, 50_001n)).toEqual({ ok: false, error: 'CREDIT_EXCEEDS_UNCREDITED' });
  });

  it('refuses a credit of nothing', () => {
    expect(judgeCreditNote(awutu110k, 0n)).toEqual({ ok: false, error: 'CREDIT_EMPTY' });
  });

  it('carries the largest amount the database holds exactly', () => {
    const max = 9_007_199_254_740_991n;
    expect(judgeCreditNote({ grossPesewas: max, liveCreditsPesewas: 0n, promisedPesewas: 0n }, max)).toEqual({ ok: true, value: 0n });
  });
});

describe('what an invoice still has to be paid (FR-PUR-011, FR-PUR-012)', () => {
  it('is the gross less approved credits and payments made', () => {
    expect(invoicePayable({ grossPesewas: 110_000n, creditedPesewas: 11_000n, paidPesewas: 0n })).toBe(99_000n);
    expect(invoicePayable({ grossPesewas: 110_000n, creditedPesewas: 11_000n, paidPesewas: 99_000n })).toBe(0n);
  });

  it('is settled (PAID) only once a payment has been made and payments and credits together reach the gross', () => {
    expect(settledStatus({ grossPesewas: 110_000n, creditedPesewas: 11_000n, paidPesewas: 99_000n })).toBe('PAID');
    expect(settledStatus({ grossPesewas: 110_000n, creditedPesewas: 11_000n, paidPesewas: 98_999n })).toBe('APPROVED');
    // Credited in full with nothing paid: nothing is owed, but no payment was made, so it is not shown as paid.
    expect(settledStatus({ grossPesewas: 110_000n, creditedPesewas: 110_000n, paidPesewas: 0n })).toBe('APPROVED');
  });
});

describe('which invoice a credit note may reduce (FR-PUR-011)', () => {
  const target = (over: Partial<CreditTarget> = {}): CreditTarget => ({ kind: 'INVOICE', status: 'APPROVED', supplierId: 'awutu', purchaseOrderId: 'po-1', branchId: 'ddw', ...over });

  it('takes an approved invoice of the same supplier, its order and its branch', () => {
    expect(judgeCreditTarget(target(), { supplierId: 'awutu', purchaseOrderId: 'po-1', branchId: 'ddw' })).toEqual({ ok: true, value: undefined });
    expect(judgeCreditTarget(target(), { supplierId: 'awutu', purchaseOrderId: null, branchId: null })).toEqual({ ok: true, value: undefined });
  });

  it('refuses another credit note, an invoice not yet approved, a paid or cancelled one, and one of another supplier, order or branch', () => {
    expect(judgeCreditTarget(target({ kind: 'CREDIT_NOTE' }), { supplierId: 'awutu', purchaseOrderId: null, branchId: null })).toEqual({ ok: false, error: 'ORIGINAL_NOT_AN_INVOICE' });
    for (const status of ['DRAFT', 'MATCHED', 'MISMATCH', 'CANCELLED'] as const) {
      expect(judgeCreditTarget(target({ status }), { supplierId: 'awutu', purchaseOrderId: null, branchId: null })).toEqual({ ok: false, error: 'ORIGINAL_NOT_APPROVED' });
    }
    expect(judgeCreditTarget(target({ status: 'PAID' }), { supplierId: 'awutu', purchaseOrderId: null, branchId: null })).toEqual({ ok: false, error: 'ORIGINAL_SETTLED' });
    expect(judgeCreditTarget(target(), { supplierId: 'kpone', purchaseOrderId: null, branchId: null })).toEqual({ ok: false, error: 'ORIGINAL_OF_ANOTHER_SUPPLIER' });
    expect(judgeCreditTarget(target(), { supplierId: 'awutu', purchaseOrderId: 'po-2', branchId: null })).toEqual({ ok: false, error: 'ORDER_DIFFERS' });
    expect(judgeCreditTarget(target(), { supplierId: 'awutu', purchaseOrderId: null, branchId: 'kumasi' })).toEqual({ ok: false, error: 'BRANCH_DIFFERS' });
  });
});
