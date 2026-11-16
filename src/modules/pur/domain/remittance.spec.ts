import { describe, expect, it } from 'vitest';
import { remittanceLines } from './remittance';

describe('the remittance advice of a paid supplier payment (FR-PUR-013)', () => {
  it('lists each invoice paid with the amount, and the lines add up to the payment exactly', () => {
    const advice = remittanceLines(110_000n, [
      { supplierInvoiceId: 'a', supplierInvoiceNo: 'KLT-0601', invoiceDate: '2026-11-01', grossPesewas: 60_000n, creditedPesewas: 0n, paidAfterPesewas: 60_000n, amountPesewas: 60_000n },
      { supplierInvoiceId: 'b', supplierInvoiceNo: 'KLT-0602', invoiceDate: '2026-11-02', grossPesewas: 50_000n, creditedPesewas: 0n, paidAfterPesewas: 50_000n, amountPesewas: 50_000n },
    ]);
    expect(advice).toEqual({
      ok: true,
      value: [
        { supplierInvoiceId: 'a', supplierInvoiceNo: 'KLT-0601', invoiceDate: '2026-11-01', grossPesewas: 60_000n, creditedPesewas: 0n, amountPesewas: 60_000n, outstandingAfterPesewas: 0n },
        { supplierInvoiceId: 'b', supplierInvoiceNo: 'KLT-0602', invoiceDate: '2026-11-02', grossPesewas: 50_000n, creditedPesewas: 0n, amountPesewas: 50_000n, outstandingAfterPesewas: 0n },
      ],
    });
  });

  it('shows the credit beside an invoice paid net of it: 110,000 less 11,000 credited, 99,000 paid, nothing left', () => {
    const advice = remittanceLines(99_000n, [
      { supplierInvoiceId: 'a', supplierInvoiceNo: 'APF-0088', invoiceDate: '2026-11-03', grossPesewas: 110_000n, creditedPesewas: 11_000n, paidAfterPesewas: 99_000n, amountPesewas: 99_000n },
    ]);
    expect(advice.ok && advice.value[0]).toEqual({ supplierInvoiceId: 'a', supplierInvoiceNo: 'APF-0088', invoiceDate: '2026-11-03', grossPesewas: 110_000n, creditedPesewas: 11_000n, amountPesewas: 99_000n, outstandingAfterPesewas: 0n });
  });

  it('shows what is left on an invoice paid in part', () => {
    const advice = remittanceLines(40_000n, [
      { supplierInvoiceId: 'a', supplierInvoiceNo: 'APF-0089', invoiceDate: '2026-11-03', grossPesewas: 110_000n, creditedPesewas: 0n, paidAfterPesewas: 40_000n, amountPesewas: 40_000n },
    ]);
    expect(advice.ok && advice.value[0]!.outstandingAfterPesewas).toBe(70_000n);
  });

  it('refuses lines that do not add up to the payment, and an empty advice', () => {
    expect(remittanceLines(110_001n, [{ supplierInvoiceId: 'a', supplierInvoiceNo: 'X', invoiceDate: '2026-11-01', grossPesewas: 110_000n, creditedPesewas: 0n, paidAfterPesewas: 110_000n, amountPesewas: 110_000n }])).toEqual({
      ok: false,
      error: 'LINES_DIFFER_FROM_PAYMENT',
    });
    expect(remittanceLines(0n, [])).toEqual({ ok: false, error: 'NO_INVOICES' });
  });
});
