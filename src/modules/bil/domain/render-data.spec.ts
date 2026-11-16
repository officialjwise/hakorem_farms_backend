import { describe, expect, it } from 'vitest';
import { formatCedis, renderDataOf, type PrintableDocument } from './render-data';

describe('formatCedis prints the stored integer, never a float (ADR-0001)', () => {
  it.each([
    [0n, 'GHS 0.00'],
    [5n, 'GHS 0.05'],
    [100n, 'GHS 1.00'],
    [124_489n, 'GHS 1,244.89'],
    [100_000_000n, 'GHS 1,000,000.00'],
    [9_007_199_254_740_993n, 'GHS 90,071,992,547,409.93'],
    [-36_000n, '-GHS 360.00'],
  ])('%s pesewas print as %s', (pesewas, printed) => {
    expect(formatCedis(pesewas)).toBe(printed);
  });
});

describe('renderDataOf (FR-BIL-004)', () => {
  const invoice: PrintableDocument = {
    kind: 'INVOICE',
    documentNo: 'INV-2026-DDW-000001',
    provisionalRef: null,
    issueDate: '2026-11-16',
    dueDate: '2026-12-16',
    branch: { code: 'DDW', name: 'Dodowa farm (SEED)' },
    customer: { name: 'Tema Cold Store Ltd (SEED)', tin: null, address: null },
    original: null,
    reasonCode: null,
    taxInclusive: true,
    netPesewas: 115_467n,
    taxPesewas: 7_093n,
    grossPesewas: 122_560n,
    levyTotals: [
      { levyCode: 'VAT', levyName: 'Value Added Tax', amountPesewas: 5_320n },
      { levyCode: 'NHIL', levyName: 'National Health Insurance Levy', amountPesewas: 887n },
      { levyCode: 'GETFUND', levyName: 'GETFund Levy', amountPesewas: 886n },
    ],
    lines: [
      {
        lineNo: 1,
        description: 'Goat meat, 15 kg pack',
        identifier: null,
        quantity: '1.000',
        uom: 'PACK',
        weightKg: null,
        unitPricePesewas: 42_560n,
        discountPesewas: 0n,
        netPesewas: 35_467n,
        taxPesewas: 7_093n,
        grossPesewas: 42_560n,
        levies: [{ levyCode: 'VAT', levyName: 'Value Added Tax', treatment: 'STANDARD', ratePercent: '15', basePesewas: 35_467n, amountPesewas: 5_320n }],
      },
      {
        lineNo: 2,
        description: 'Goat',
        identifier: 'G-0142',
        quantity: '1.000',
        uom: 'HEAD',
        weightKg: '26.400',
        unitPricePesewas: 80_000n,
        discountPesewas: 500n,
        netPesewas: 80_000n,
        taxPesewas: 0n,
        grossPesewas: 80_000n,
        levies: [{ levyCode: 'VAT', levyName: 'Value Added Tax', treatment: 'ZERO_RATED', ratePercent: '0', basePesewas: 80_000n, amountPesewas: 0n }],
      },
    ],
  };

  it('formats every stored amount, keeps every levy row, zero rows included, and computes nothing', () => {
    const data = renderDataOf(invoice);
    expect(data).toMatchObject({
      title: 'Invoice',
      pricing: 'include tax',
      net: 'GHS 1,154.67',
      tax: 'GHS 70.93',
      gross: 'GHS 1,225.60',
      levyTotals: [
        { levyCode: 'VAT', amount: 'GHS 53.20' },
        { levyCode: 'NHIL', amount: 'GHS 8.87' },
        { levyCode: 'GETFUND', amount: 'GHS 8.86' },
      ],
    });
    const lines = data['lines'] as Record<string, unknown>[];
    expect(lines[0]).toMatchObject({ unitPrice: 'GHS 425.60', discount: null, gross: 'GHS 425.60', levies: [{ treatment: 'STANDARD', base: 'GHS 354.67', amount: 'GHS 53.20' }] });
    expect(lines[1]).toMatchObject({ identifier: 'G-0142', weightKg: '26.400', discount: 'GHS 5.00', levies: [{ treatment: 'ZERO_RATED', ratePercent: '0', amount: 'GHS 0.00' }] });
  });

  it('titles each kind and says when prices exclude tax', () => {
    expect(renderDataOf({ ...invoice, kind: 'CREDIT_NOTE', taxInclusive: false, original: { documentNo: 'INV-2026-DDW-000001' }, reasonCode: 'RETURN' })).toMatchObject({
      title: 'Credit note',
      pricing: 'exclude tax',
      original: { documentNo: 'INV-2026-DDW-000001' },
    });
    expect(renderDataOf({ ...invoice, kind: 'RECEIPT', customer: null })['customer']).toBeNull();
    expect(renderDataOf({ ...invoice, kind: 'PROFORMA' })['title']).toBe('Proforma invoice');
    expect(renderDataOf({ ...invoice, kind: 'DEBIT_NOTE' })['title']).toBe('Debit note');
  });
});
