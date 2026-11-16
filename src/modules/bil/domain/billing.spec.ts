import { Money, Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { checkIssue, creditRefundableOf, correctable, documentTotals, fiscalYearOf, levyTotals, lineAnchor, noteReasonRule, planCreditLines, priceVariance, seriesLockKey, type CreditableLine, type LinePricing } from './billing';

const p = (n: number | bigint) => Money.ofPesewas(BigInt(n));
const q = (text: string) => Quantity.parse(text);
const pricing = (unit: number, qty: string, discount = 0, resolved = unit): LinePricing => ({ unitPrice: p(unit), resolvedUnitPrice: p(resolved), quantity: q(qty), discount: p(discount) });

describe('the line anchor is rounded half-up once (ADR-0001, FR-BIL-005)', () => {
  it('bills 30.800 kg at 2,800 pesewas a kilogram as exactly 86,240', () => {
    expect(lineAnchor(pricing(2_800, '30.800'))!.pesewas).toBe(86_240n);
  });
  it('rounds an exact half pesewa up: 2.500 at 3 pesewas is 8', () => {
    expect(lineAnchor(pricing(3, '2.500'))!.pesewas).toBe(8n);
  });
  it('rounds one below half down: 0.166 at 3 pesewas (0.498) is 0', () => {
    expect(lineAnchor(pricing(3, '0.166'))!.pesewas).toBe(0n);
  });
  it('rounds one above half up: 0.167 at 3 pesewas (0.501) is 1', () => {
    expect(lineAnchor(pricing(3, '0.167'))!.pesewas).toBe(1n);
  });
  it('takes the discount off after the one rounding: 2 crates at 6,000 less 500 is 11,500', () => {
    expect(lineAnchor(pricing(6_000, '2.000', 500))!.pesewas).toBe(11_500n);
  });
  it('allows a discount of the whole line, to zero', () => {
    expect(lineAnchor(pricing(6_000, '1.000', 6_000))!.pesewas).toBe(0n);
  });
  it('refuses a discount larger than the line', () => {
    expect(lineAnchor(pricing(6_000, '1.000', 6_001))).toBeNull();
  });
  it('carries the maximum amount exactly', () => {
    expect(lineAnchor(pricing(Number(Money.MAX_PESEWAS), '1.000'))!.pesewas).toBe(Money.MAX_PESEWAS);
  });
});

describe('the price variance is the resolved less the agreed, each extended once (ADR-0003, 4210)', () => {
  it('is 5,000 below when a goat resolved at 85,000 sold for 80,000', () => {
    expect(priceVariance(pricing(80_000, '1.000', 0, 85_000))).toBe(5_000n);
  });
  it('is negative when the agreed price is above the resolved one', () => {
    expect(priceVariance(pricing(2_900, '30.800', 0, 2_800))).toBe(-3_080n);
  });
  it('is zero at the resolved price', () => {
    expect(priceVariance(pricing(6_000, '2.000'))).toBe(0n);
  });
});

describe('document totals are sums of line integers (ADR-0001, FR-BIL-004)', () => {
  it('sums each figure of the lines', () => {
    const totals = documentTotals([
      { net: p(35_467), tax: p(7_093), gross: p(42_560) },
      { net: p(80_000), tax: p(0), gross: p(80_000) },
    ]);
    expect([totals.net.pesewas, totals.tax.pesewas, totals.gross.pesewas]).toEqual([115_467n, 7_093n, 122_560n]);
  });
  it('is zero with no lines', () => {
    expect(documentTotals([]).gross.pesewas).toBe(0n);
  });
});

describe('levy totals list every levy in calculation order, including those at zero (FR-BIL-004)', () => {
  it('sums each levy across lines and orders by calc order, then code', () => {
    const rows = [
      { levyCode: 'NHIL', levyName: 'NHIL', calcOrder: 2, amount: p(887) },
      { levyCode: 'VAT', levyName: 'VAT', calcOrder: 1, amount: p(5_320) },
      { levyCode: 'VAT', levyName: 'VAT', calcOrder: 1, amount: p(0) },
      { levyCode: 'GETFUND', levyName: 'GETFund', calcOrder: 3, amount: p(886) },
      { levyCode: 'COVID', levyName: 'COVID', calcOrder: 3, amount: p(0) },
    ];
    expect(levyTotals(rows).map((r) => [r.levyCode, r.amount.pesewas])).toEqual([
      ['VAT', 5_320n],
      ['NHIL', 887n],
      ['COVID', 0n],
      ['GETFUND', 886n],
    ]);
  });
  it('orders a lower calc order first whichever comes first', () => {
    const rows = [
      { levyCode: 'B', levyName: 'B', calcOrder: 1, amount: p(1) },
      { levyCode: 'A', levyName: 'A', calcOrder: 2, amount: p(1) },
    ];
    expect(levyTotals(rows).map((r) => r.levyCode)).toEqual(['B', 'A']);
  });
});

describe('numbering keys (FR-BIL-001, FR-BIL-002, ADR-0015)', () => {
  it('takes the fiscal year from the business date: a sale posted on 2 January 2027 takes a 2027 number', () => {
    expect(fiscalYearOf('2027-01-02')).toBe(2027);
  });
  it('names the series lock by kind, year and branch, and the register for a receipt with one', () => {
    expect(seriesLockKey('INVOICE', 'b-1', '2026-11-16')).toBe('INVOICE:2026:b-1');
    expect(seriesLockKey('RECEIPT', 'b-1', '2026-12-31', 'T1')).toBe('RECEIPT:2026:b-1:T1');
  });
});

describe('the rules of a new invoice, receipt or proforma (FR-BIL-006)', () => {
  const base = { kind: 'INVOICE' as const, customerId: 'c-1', issueDate: '2026-11-16', dueDate: '2026-12-16', lineCount: 1 };
  it('accepts an invoice to a customer with a due date after issue', () => {
    expect(checkIssue(base)).toEqual([]);
  });
  it('refuses an invoice with no customer, with no lines, or due before it is issued', () => {
    expect(checkIssue({ ...base, customerId: null, lineCount: 0, dueDate: '2026-11-15' })).toEqual([
      { field: '/lines', rule: 'NO_LINES' },
      { field: '/customerId', rule: 'CUSTOMER_REQUIRED' },
      { field: '/dueDate', rule: 'DUE_BEFORE_ISSUE' },
    ]);
  });
  it('accepts a walk-in receipt and refuses one with a due date', () => {
    expect(checkIssue({ ...base, kind: 'RECEIPT', customerId: null, dueDate: null })).toEqual([]);
    expect(checkIssue({ ...base, kind: 'RECEIPT' })).toEqual([{ field: '/dueDate', rule: 'RECEIPT_HAS_NO_DUE_DATE' }]);
  });
  it('refuses a note issued as if it were an invoice', () => {
    expect(checkIssue({ ...base, kind: 'CREDIT_NOTE' })).toEqual([{ field: '/kind', rule: 'KIND_NOT_ISSUABLE' }]);
  });
  it('accepts a proforma with no due date', () => {
    expect(checkIssue({ ...base, kind: 'PROFORMA', dueDate: null })).toEqual([]);
  });
});

describe('credit note lines never take more than a line has left (FR-BIL-007)', () => {
  const crates: CreditableLine = { id: 'l-1', pricing: pricing(6_000, '4.000', 1_000), anchor: p(23_000), creditedAnchor: p(0) };
  const meat: CreditableLine = { id: 'l-2', pricing: pricing(2_800, '30.800'), anchor: p(86_240), creditedAnchor: p(30_000) };

  it('credits a quantity at the line price less the same share of its discount: 2 of 4 crates is 11,500', () => {
    const { plans, broken } = planCreditLines([crates], [{ lineId: 'l-1', quantity: q('2.000') }]);
    expect(broken).toEqual([]);
    expect(plans[0]!.anchor.pesewas).toBe(11_500n);
    expect(plans[0]!.pricing.discount.pesewas).toBe(500n);
  });
  it('rounds the discount share half-up once: 1 of 4 crates with 1,000 off shares 250', () => {
    const { plans } = planCreditLines([crates], [{ lineId: 'l-1', quantity: q('1.000') }]);
    expect(plans[0]!.anchor.pesewas).toBe(5_750n);
  });
  it('credits an amount as itself, keeping the line quantity, and leaves 56,240 of 86,240 after 30,000', () => {
    const { plans, broken } = planCreditLines([meat], [{ lineId: 'l-2', amount: p(56_240) }]);
    expect(broken).toEqual([]);
    expect(plans[0]!.anchor.pesewas).toBe(56_240n);
    expect(lineAnchor(plans[0]!.pricing)!.pesewas).toBe(56_240n);
    expect(plans[0]!.pricing.quantity.toDecimalString()).toBe('30.800');
  });
  it('refuses a further credit beyond what the line has left (56,241 after 30,000 of 86,240)', () => {
    expect(planCreditLines([meat], [{ lineId: 'l-2', amount: p(56_241) }]).broken).toEqual([{ field: '/lines/0', rule: 'LINE_ALREADY_CREDITED' }]);
  });
  it('refuses an amount larger than the line, or zero', () => {
    expect(planCreditLines([meat], [{ lineId: 'l-2', amount: p(86_241) }]).broken).toEqual([{ field: '/lines/0/amountPesewas', rule: 'AMOUNT_EXCEEDS_LINE' }]);
    expect(planCreditLines([meat], [{ lineId: 'l-2', amount: p(0) }]).broken).toEqual([{ field: '/lines/0/amountPesewas', rule: 'AMOUNT_EXCEEDS_LINE' }]);
  });
  it('refuses a quantity above the line, zero or negative', () => {
    for (const text of ['4.001', '0.000', '-1.000']) {
      expect(planCreditLines([crates], [{ lineId: 'l-1', quantity: q(text) }]).broken, text).toEqual([{ field: '/lines/0/quantity', rule: 'QUANTITY_EXCEEDS_LINE' }]);
    }
  });
  it('refuses both or neither of quantity and amount, an unknown line, a repeated line and no lines', () => {
    expect(planCreditLines([crates], [{ lineId: 'l-1', quantity: q('1.000'), amount: p(1) }]).broken).toEqual([{ field: '/lines/0', rule: 'QUANTITY_OR_AMOUNT' }]);
    expect(planCreditLines([crates], [{ lineId: 'l-1' }]).broken).toEqual([{ field: '/lines/0', rule: 'QUANTITY_OR_AMOUNT' }]);
    expect(planCreditLines([crates], [{ lineId: 'l-9', amount: p(1) }]).broken).toEqual([{ field: '/lines/0/lineId', rule: 'LINE_NOT_ON_ORIGINAL' }]);
    expect(
      planCreditLines(
        [crates],
        [
          { lineId: 'l-1', amount: p(1) },
          { lineId: 'l-1', amount: p(1) },
        ],
      ).broken,
    ).toEqual([{ field: '/lines/1/lineId', rule: 'LINE_REPEATED' }]);
    expect(planCreditLines([crates], []).broken).toEqual([{ field: '/lines', rule: 'NO_LINES' }]);
  });
});

describe('the reasons and originals a note may take (FR-BIL-007, FR-MDM-011)', () => {
  it('takes a REFUND or RETURN reason on a credit note and a BILLING_ADJUSTMENT one on a debit note', () => {
    expect(noteReasonRule('CREDIT_NOTE', { domain: 'REFUND', requiresNote: false }, null)).toEqual([]);
    expect(noteReasonRule('CREDIT_NOTE', { domain: 'RETURN', requiresNote: false }, null)).toEqual([]);
    expect(noteReasonRule('DEBIT_NOTE', { domain: 'BILLING_ADJUSTMENT', requiresNote: true }, 'Two crates left off')).toEqual([]);
  });
  it('refuses a reason of another domain, an unknown reason, and a missing note the reason requires', () => {
    expect(noteReasonRule('DEBIT_NOTE', { domain: 'REFUND', requiresNote: false }, null)).toEqual([{ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' }]);
    expect(noteReasonRule('CREDIT_NOTE', undefined, null)).toEqual([{ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' }]);
    expect(noteReasonRule('CREDIT_NOTE', { domain: 'REFUND', requiresNote: true }, ' ')).toEqual([{ field: '/note', rule: 'NOTE_REQUIRED' }]);
    expect(noteReasonRule('CREDIT_NOTE', { domain: 'REFUND', requiresNote: true }, null)).toEqual([{ field: '/note', rule: 'NOTE_REQUIRED' }]);
  });
  it('corrects only an issued invoice or receipt', () => {
    expect(correctable({ kind: 'INVOICE', status: 'ISSUED' })).toBe(true);
    expect(correctable({ kind: 'RECEIPT', status: 'ISSUED' })).toBe(true);
    expect(correctable({ kind: 'PROFORMA', status: 'ISSUED' })).toBe(false);
    expect(correctable({ kind: 'CREDIT_NOTE', status: 'ISSUED' })).toBe(false);
    expect(correctable({ kind: 'INVOICE', status: 'DRAFT' })).toBe(false);
  });
});

describe('what a refund against a credit note may still draw on (FR-BIL-007, ADR-0066)', () => {
  const note = (grossPesewas: bigint, refundedPesewas: bigint, issued = true) => ({ kind: 'CREDIT_NOTE', issued, grossPesewas, refundedPesewas, refundablePesewas: 0n });

  it('is the credit note\'s 30,000 less the 10,000 already held against it, while its invoice owes back 30,000', () => {
    expect(creditRefundableOf(note(30_000n, 10_000n), 30_000n)).toBe(20_000n);
  });

  it('is never more than the invoice owes back: a 30,000 credit on an invoice that had 12,000 outstanding leaves 18,000', () => {
    expect(creditRefundableOf(note(30_000n, 0n), 18_000n)).toBe(18_000n);
    expect(creditRefundableOf(note(30_000n, 30_000n), 0n)).toBe(0n);
  });

  it('is nothing on a credit note not yet issued or whose original is unknown', () => {
    expect(creditRefundableOf(note(30_000n, 0n, false), 30_000n)).toBe(0n);
    expect(creditRefundableOf(note(30_000n, 0n), null)).toBe(0n);
  });

  it('is what an invoice or receipt owes back to the customer', () => {
    expect(creditRefundableOf({ kind: 'INVOICE', issued: true, grossPesewas: 86_240n, refundedPesewas: 0n, refundablePesewas: 30_000n }, null)).toBe(30_000n);
  });
});
