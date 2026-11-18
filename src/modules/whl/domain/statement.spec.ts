import { describe, expect, it } from 'vitest';
import { classifyLine, judgePeriod, MAX_STATEMENT_DAYS, numberedLines, statementOf, statementRenderData, type ReceivableLine } from './statement';

let seq = 0;
function line(over: Partial<ReceivableLine> & Pick<ReceivableLine, 'side' | 'amountPesewas'>): ReceivableLine {
  seq += 1;
  return {
    postingDate: '2026-10-06',
    entryId: `019a7b05-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    entryNo: `JNL-2026-DDW-${String(seq).padStart(6, '0')}`,
    lineNo: 1,
    eventCode: 'bil.InvoiceIssued',
    entryKind: 'AUTO',
    sourceDocumentId: `019a7b06-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    sourceNumber: null,
    ...over,
  };
}

const invoice = (amount: bigint, number: string, date = '2026-10-06') => line({ side: 'D', amountPesewas: amount, eventCode: 'bil.InvoiceIssued', sourceNumber: number, postingDate: date });
const creditNote = (amount: bigint, number: string, date = '2026-10-10') => line({ side: 'C', amountPesewas: amount, eventCode: 'bil.CreditNoteIssued', sourceNumber: number, postingDate: date });
const payment = (amount: bigint, date = '2026-10-14') => line({ side: 'C', amountPesewas: amount, eventCode: 'pay.PaymentCleared', postingDate: date });

describe('the statement balances opening to closing exactly (FR-WHL-009)', () => {
  it('gives closing 180,000 from opening 100,000, invoices 250,000, a credit note of 20,000 and a payment of 150,000', () => {
    const s = statementOf(100_000n, [invoice(150_000n, 'INV-2026-DDW-000001'), invoice(100_000n, 'INV-2026-DDW-000002', '2026-10-08'), creditNote(20_000n, 'CRN-2026-DDW-000001'), payment(150_000n)], '2026-10-01');
    expect([s.openingPesewas, s.openingCreditPesewas, s.invoicedPesewas, s.creditedPesewas, s.paidPesewas, s.otherChargesPesewas, s.otherCreditsPesewas, s.closingPesewas, s.closingCreditPesewas]).toEqual([
      100_000n, 0n, 250_000n, 20_000n, 150_000n, 0n, 0n, 180_000n, 0n,
    ]);
    expect(s.lines.map((l) => [l.date, l.kind, l.reference, l.debitPesewas, l.creditPesewas, l.balancePesewas, l.balanceSide])).toEqual([
      ['2026-10-01', 'OPENING', 'Balance brought forward', 0n, 0n, 100_000n, 'D'],
      ['2026-10-06', 'INVOICE', 'INV-2026-DDW-000001', 150_000n, 0n, 250_000n, 'D'],
      ['2026-10-08', 'INVOICE', 'INV-2026-DDW-000002', 100_000n, 0n, 350_000n, 'D'],
      ['2026-10-10', 'CREDIT_NOTE', 'CRN-2026-DDW-000001', 0n, 20_000n, 330_000n, 'D'],
      ['2026-10-14', 'PAYMENT', expect.stringMatching(/^Payment JNL-2026-DDW-\d{6}$/), 0n, 150_000n, 180_000n, 'D'],
    ]);
  });

  it('shows a customer in credit with a closing balance of zero and the credit apart, each line marked in credit', () => {
    // A paid invoice of 50,000 is credited 12,000 in full afterwards: the farm owes the customer 12,000.
    const s = statementOf(0n, [invoice(50_000n, 'INV-2026-DDW-000010'), payment(50_000n), creditNote(12_000n, 'CRN-2026-DDW-000004', '2026-10-20')], '2026-10-01');
    expect([s.openingPesewas, s.openingCreditPesewas, s.closingPesewas, s.closingCreditPesewas]).toEqual([0n, 0n, 0n, 12_000n]);
    expect(s.lines.at(-1)).toMatchObject({ kind: 'CREDIT_NOTE', balancePesewas: 12_000n, balanceSide: 'C' });
  });

  it('opens in credit and closes owing, crossing zero on the way', () => {
    const s = statementOf(-5_000n, [invoice(8_000n, 'INV-2026-DDW-000011')], '2026-10-01');
    expect([s.openingPesewas, s.openingCreditPesewas, s.closingPesewas, s.closingCreditPesewas]).toEqual([0n, 5_000n, 3_000n, 0n]);
    expect(s.lines.map((l) => [l.balancePesewas, l.balanceSide])).toEqual([[5_000n, 'C'], [3_000n, 'D']]);
  });

  it('shows a balance of exactly zero as owing nothing, on the debit side', () => {
    const s = statementOf(0n, [], '2026-10-01');
    expect(s.lines).toEqual([{ date: '2026-10-01', kind: 'OPENING', reference: 'Balance brought forward', debitPesewas: 0n, creditPesewas: 0n, balancePesewas: 0n, balanceSide: 'D', sourceDocumentId: null }]);
    expect([s.closingPesewas, s.closingCreditPesewas]).toEqual([0n, 0n]);
  });

  it('carries refunds, reversed payments and journals as other charges and other credits, so the sum still ties', () => {
    const s = statementOf(
      10_000n,
      [
        line({ side: 'D', amountPesewas: 4_000n, eventCode: 'pay.RefundPaid' }),
        line({ side: 'D', amountPesewas: 3_000n, eventCode: 'pay.PaymentReversed', entryKind: 'REVERSAL' }),
        line({ side: 'D', amountPesewas: 2_000n, eventCode: 'fin.ManualJournalApproved', entryKind: 'MANUAL' }),
        line({ side: 'C', amountPesewas: 1_500n, eventCode: 'fin.ManualJournalApproved', entryKind: 'MANUAL' }),
        line({ side: 'D', amountPesewas: 700n, eventCode: 'bil.DebitNoteIssued', sourceNumber: 'DBN-2026-DDW-000001' }),
      ],
      '2026-10-01',
    );
    expect([s.invoicedPesewas, s.otherChargesPesewas, s.otherCreditsPesewas, s.closingPesewas]).toEqual([700n, 9_000n, 1_500n, 18_200n]);
    expect(s.openingPesewas - s.openingCreditPesewas + s.invoicedPesewas + s.otherChargesPesewas - s.creditedPesewas - s.paidPesewas - s.otherCreditsPesewas).toBe(s.closingPesewas - s.closingCreditPesewas);
    expect(s.lines.slice(1).map((l) => l.kind)).toEqual(['REFUND', 'PAYMENT_REVERSAL', 'ADJUSTMENT', 'ADJUSTMENT', 'DEBIT_NOTE']);
  });

  it('numbers the lines from 1, the brought-forward line first', () => {
    const s = statementOf(0n, [invoice(1_000n, 'INV-2026-DDW-000050'), payment(1_000n)], '2026-10-01');
    expect(numberedLines(s).map((l) => [l.lineNo, l.kind])).toEqual([[1, 'OPENING'], [2, 'INVOICE'], [3, 'PAYMENT']]);
  });

  it('keeps the largest balance the database holds exact', () => {
    const max = 9_007_199_254_740_991n;
    const s = statementOf(max - 1n, [invoice(1n, 'INV-2026-DDW-000099')], '2026-10-01');
    expect(s.closingPesewas).toBe(max);
  });
});

describe('each ledger line is named by its source document (ADR-0085)', () => {
  it('classifies by the event that posted it and the side it is on', () => {
    const kind = (eventCode: string | null, side: 'D' | 'C', entryKind: ReceivableLine['entryKind'] = 'AUTO') => classifyLine(line({ side, amountPesewas: 1n, eventCode, entryKind }));
    expect(kind('bil.InvoiceIssued', 'D')).toBe('INVOICE');
    expect(kind('bil.DebitNoteIssued', 'D')).toBe('DEBIT_NOTE');
    expect(kind('bil.CreditNoteIssued', 'C')).toBe('CREDIT_NOTE');
    expect(kind('pay.PaymentCleared', 'C')).toBe('PAYMENT');
    expect(kind('pay.DepositAllocated', 'C')).toBe('PAYMENT');
    expect(kind('pay.DepositAllocated', 'D')).toBe('PAYMENT_REVERSAL');
    expect(kind('pay.PaymentReversed', 'D', 'REVERSAL')).toBe('PAYMENT_REVERSAL');
    expect(kind('pay.RefundPaid', 'D')).toBe('REFUND');
    // Anything else is an adjustment: a manual or opening journal, or an event on the side it never posts to.
    expect(kind('fin.ManualJournalApproved', 'D', 'OPENING')).toBe('ADJUSTMENT');
    expect(kind('bil.InvoiceIssued', 'C')).toBe('ADJUSTMENT');
    expect(kind('bil.CreditNoteIssued', 'D')).toBe('ADJUSTMENT');
    expect(kind('bil.DebitNoteIssued', 'C')).toBe('ADJUSTMENT');
    expect(kind('pay.RefundPaid', 'C')).toBe('ADJUSTMENT');
    expect(kind(null, 'C')).toBe('ADJUSTMENT');
  });

  it('names a line by its source document’s number, or by its journal’s when the source has none', () => {
    const s = statementOf(0n, [invoice(1_000n, 'INV-2026-DDW-000123'), line({ side: 'C', amountPesewas: 1_000n, eventCode: 'pay.PaymentCleared', entryNo: 'JNL-2026-DDW-000777' }), line({ side: 'D', amountPesewas: 5n, eventCode: 'fin.ManualJournalApproved', entryKind: 'OPENING', entryNo: 'JNL-2026-DDW-000778' })], '2026-10-01');
    expect(s.lines.slice(1).map((l) => l.reference)).toEqual(['INV-2026-DDW-000123', 'Payment JNL-2026-DDW-000777', 'Journal JNL-2026-DDW-000778']);
  });
});

describe('the period a statement covers', () => {
  it('takes a period of one day up to today', () => {
    expect(judgePeriod('2026-11-17', '2026-11-17', '2026-11-17')).toEqual([]);
  });

  it('refuses a period that ends before it starts, ends after today, or runs longer than the limit', () => {
    expect(judgePeriod('2026-10-31', '2026-10-01', '2026-11-17')).toEqual([{ field: '/periodEnd', rule: 'PERIOD_REVERSED' }]);
    expect(judgePeriod('2026-11-01', '2026-11-18', '2026-11-17')).toEqual([{ field: '/periodEnd', rule: 'PERIOD_NOT_ENDED' }]);
    expect(MAX_STATEMENT_DAYS).toBe(366);
    expect(judgePeriod('2025-01-01', '2026-01-01', '2026-11-17')).toEqual([]);
    expect(judgePeriod('2025-01-01', '2026-01-02', '2026-11-17')).toEqual([{ field: '/periodStart', rule: 'PERIOD_TOO_LONG' }]);
  });
});

describe('what the statement prints (ADR-0061: the template never computes)', () => {
  it('formats every amount from its integer pesewas and marks a balance in credit', () => {
    const figures = statementOf(-5_000n, [invoice(2_000n, 'INV-2026-DDW-000011', '2026-10-03')], '2026-10-01');
    const data = statementRenderData({
      statementNo: 'STM-2026-DDW-000001',
      issuedOn: '2026-11-17',
      customer: { name: 'Osu Fresh Mart (SEED)', publicId: 'cus_3Q4VCE9ZY779GAT6' },
      branch: { code: 'DDW', name: 'HaKorem Farms, Dodowa' },
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      figures,
    });
    expect(data).toEqual({
      title: 'Customer statement',
      statementNo: 'STM-2026-DDW-000001',
      issuedOn: '2026-11-17',
      customer: { name: 'Osu Fresh Mart (SEED)', publicId: 'cus_3Q4VCE9ZY779GAT6' },
      branch: { code: 'DDW', name: 'HaKorem Farms, Dodowa' },
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      opening: 'GHS 50.00 CR',
      invoiced: 'GHS 20.00',
      otherCharges: 'GHS 0.00',
      credited: 'GHS 0.00',
      paid: 'GHS 0.00',
      otherCredits: 'GHS 0.00',
      closing: 'GHS 30.00 CR',
      inCredit: true,
      lines: [
        { date: '2026-10-01', kind: 'Brought forward', reference: 'Balance brought forward', debit: '', credit: '', balance: 'GHS 50.00 CR' },
        { date: '2026-10-03', kind: 'Invoice', reference: 'INV-2026-DDW-000011', debit: 'GHS 20.00', credit: '', balance: 'GHS 30.00 CR' },
      ],
    });
    expect(statementRenderData({ statementNo: 'STM-2026-DDW-000002', issuedOn: '2026-11-17', customer: { name: 'A', publicId: 'cus_X' }, branch: { code: 'DDW', name: 'D' }, periodStart: '2026-10-01', periodEnd: '2026-10-31', figures: statementOf(0n, [payment(1n), line({ side: 'D', amountPesewas: 1n, eventCode: 'pay.RefundPaid' }), line({ side: 'D', amountPesewas: 1n, eventCode: 'pay.DepositAllocated' }), line({ side: 'C', amountPesewas: 1n, eventCode: null }), creditNote(1n, 'CRN-1'), line({ side: 'D', amountPesewas: 1n, eventCode: 'bil.DebitNoteIssued', sourceNumber: 'DBN-1' })], '2026-10-01') })['lines']).toEqual([
      expect.objectContaining({ kind: 'Brought forward' }),
      expect.objectContaining({ kind: 'Payment', credit: 'GHS 0.01', balance: 'GHS 0.01 CR' }),
      expect.objectContaining({ kind: 'Refund', debit: 'GHS 0.01', balance: 'GHS 0.00' }),
      expect.objectContaining({ kind: 'Payment reversed' }),
      expect.objectContaining({ kind: 'Adjustment' }),
      expect.objectContaining({ kind: 'Credit note' }),
      expect.objectContaining({ kind: 'Debit note' }),
    ]);
  });
});
