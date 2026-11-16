import { describe, expect, it } from 'vitest';
import { remittanceLines, remittanceRenderData } from './remittance';

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

describe('remittanceRenderData prints the advice from its stored integers (FR-PUR-013, ADR-0062)', () => {
  const advice = {
    supplierPaymentId: '019a7acf-6a08-798f-8ec7-a1c59af51aa3',
    paymentNo: 'SPY-2026-DDW-000004' as string | null,
    paidAt: new Date('2026-11-15T23:30:00Z'),
    method: 'BANK' as const,
    payeeMasked: 'GCB ****4321',
    externalReference: 'TRF-88120',
    supplierName: 'Awutu Poultry Farm',
    branch: { code: 'DDW', name: 'Dodowa' },
    amountPesewas: 150_001n,
    lines: [
      { supplierInvoiceId: 'a', supplierInvoiceNo: 'APF-101', invoiceDate: '2026-11-02', grossPesewas: 112_000n, creditedPesewas: 11_000n, amountPesewas: 101_000n, outstandingAfterPesewas: 0n },
      { supplierInvoiceId: 'b', supplierInvoiceNo: 'APF-102', invoiceDate: '2026-11-03', grossPesewas: 99_999n, creditedPesewas: 0n, amountPesewas: 49_001n, outstandingAfterPesewas: 50_998n },
    ],
  };

  it('formats every amount from pesewas exactly and dates the payment in Africa/Accra', () => {
    expect(remittanceRenderData(advice)).toEqual({
      title: 'Remittance advice',
      paymentNo: 'SPY-2026-DDW-000004',
      paidDate: '2026-11-15',
      method: 'BANK',
      payee: 'GCB ****4321',
      externalReference: 'TRF-88120',
      supplier: { name: 'Awutu Poultry Farm' },
      branch: { code: 'DDW', name: 'Dodowa' },
      amount: 'GHS 1,500.01',
      lines: [
        { supplierInvoiceNo: 'APF-101', invoiceDate: '2026-11-02', gross: 'GHS 1,120.00', credited: 'GHS 110.00', amount: 'GHS 1,010.00', outstandingAfter: 'GHS 0.00' },
        { supplierInvoiceNo: 'APF-102', invoiceDate: '2026-11-03', gross: 'GHS 999.99', credited: 'GHS 0.00', amount: 'GHS 490.01', outstandingAfter: 'GHS 509.98' },
      ],
    });
  });

  it('leaves the payee out of a cash payment and prints the paid date as the business date after midnight in Accra', () => {
    const data = remittanceRenderData({ ...advice, method: 'CASH', payeeMasked: null, paidAt: new Date('2026-11-16T00:00:00Z') });
    expect(data).toMatchObject({ method: 'CASH', payee: null, paidDate: '2026-11-16' });
  });

  it('quotes the payment id while supplier payments carry no number (A-205)', () => {
    expect(remittanceRenderData({ ...advice, paymentNo: null })['paymentNo']).toBe('019a7acf-6a08-798f-8ec7-a1c59af51aa3');
  });
});
