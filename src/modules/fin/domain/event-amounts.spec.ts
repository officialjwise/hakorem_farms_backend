import { describe, expect, it } from 'vitest';
import {
  creditNoteIssuedAmounts,
  customerParty,
  debitNoteIssuedAmounts,
  depositAllocatedAmounts,
  providerParty,
  refundPaidAmounts,
  chequeClearedAmounts,
  expenseCategoryKey,
  invoiceIssuedAmounts,
  paymentClearedAmounts,
  providerSettledAmounts,
  unidentifiedReceiptAmounts,
  WALK_IN_CUSTOMER,
  type BillingLevy,
  type BillingLine,
  stockMovementAmounts,
  tillAmounts,
  supplierCreditNoteAmounts,
  supplierInvoiceAmounts,
  supplierPaymentAmounts,
  UNASSIGNED_BANK_ACCOUNT,
  valueAmount,
  type PurchaseLevy,
  type PurchaseLine,
} from './event-amounts';

const supplier = { kind: 'SUPPLIER' as const, refId: 'sup-1', displayName: 'Kpone Livestock Traders' };
const flat = (amounts: ReturnType<typeof supplierInvoiceAmounts>) =>
  amounts.map((a) => [a.key, a.amount.pesewas, a.determinants ?? null, (a.subledgers ?? []).map((s) => s.refId)]);
const line = (lineNo: number, netPesewas: number, orderValuePesewas: number | null, expenseCategory: string | null = null): PurchaseLine => ({
  lineNo,
  netPesewas,
  orderValuePesewas,
  expenseCategory,
});
const levy = (lineNo: number, levyId: string, levyCode: string, amountPesewas: number, isReclaimable: boolean): PurchaseLevy => ({ lineNo, levyId, levyCode, amountPesewas, isReclaimable });

describe('the amounts of a stock movement event (ADR-0003)', () => {
  it('names the value with the product GL group, the reason loss group and the unit as cost object', () => {
    expect(stockMovementAmounts({ valuePesewas: 71_400, stockUnitId: 'unit-1', movementType: 'MORTALITY' }, { glGroup: 'LIVE_ANIMALS', lossGroup: 'MORTALITY' })).toEqual([
      { key: 'value', amount: expect.objectContaining({ pesewas: 71_400n }), determinants: { GL_GROUP: 'LIVE_ANIMALS', LOSS_GROUP: 'MORTALITY' }, costObjectId: 'unit-1', memo: 'MORTALITY' },
    ]);
  });

  it('leaves the loss group to the default when the reason names none', () => {
    expect(stockMovementAmounts({ valuePesewas: 0, stockUnitId: null, movementType: 'RECEIPT_HARVEST' }, { glGroup: 'PRODUCE_EGGS', lossGroup: null })[0]).toEqual({
      key: 'value',
      amount: expect.objectContaining({ pesewas: 0n }),
      determinants: { GL_GROUP: 'PRODUCE_EGGS' },
      costObjectId: null,
      memo: 'RECEIPT_HARVEST',
    });
  });

  it('names a single value for a processing cost', () => {
    expect(valueAmount('directCost', 5_000, 'order-1')).toEqual([{ key: 'directCost', amount: expect.objectContaining({ pesewas: 5_000n }), costObjectId: 'order-1' }]);
  });
});

describe('the amounts of an approved supplier invoice (FR-PUR-015, A-027)', () => {
  it('clears 2010 at the receipt value and puts the price above the order on purchase price variance', () => {
    // FR-PUR-015: receipt 110,000 then invoice at 111,000 with no reclaimable levy.
    const amounts = supplierInvoiceAmounts({ grossPesewas: 111_000, lines: [line(1, 111_000, 110_000)], levies: [] }, supplier);
    expect(flat(amounts)).toEqual([
      ['receiptValue', 110_000n, null, []],
      ['priceVarianceUnfavourable', 1_000n, null, []],
      ['priceVarianceFavourable', 0n, null, []],
      ['gross', 111_000n, null, ['sup-1']],
    ]);
  });

  it('puts a price below the order on the favourable side, and a non-reclaimable levy into the variance', () => {
    const amounts = supplierInvoiceAmounts(
      { grossPesewas: 100_500, lines: [line(1, 99_000, 100_000)], levies: [levy(1, 'levy-covid', 'COVID', 1_500, false)] },
      supplier,
    );
    expect(flat(amounts)).toEqual([
      ['receiptValue', 100_000n, null, []],
      ['priceVarianceUnfavourable', 500n, null, []],
      ['priceVarianceFavourable', 0n, null, []],
      ['gross', 100_500n, null, ['sup-1']],
    ]);
    const below = supplierInvoiceAmounts({ grossPesewas: 98_000, lines: [line(1, 98_000, 100_000)], levies: [] }, supplier);
    expect(flat(below).slice(1, 3)).toEqual([
      ['priceVarianceUnfavourable', 0n, null, []],
      ['priceVarianceFavourable', 2_000n, null, []],
    ]);
  });

  it('debits each reclaimable levy to its own levy subledger and an expense line by its category', () => {
    const amounts = supplierInvoiceAmounts(
      {
        grossPesewas: 23_000,
        lines: [line(1, 20_000, null, 'Vehicle repairs'), line(2, 0, null, null)],
        levies: [levy(1, 'levy-vat', 'VAT', 3_000, true)],
      },
      supplier,
    );
    expect(flat(amounts)).toEqual([
      ['receiptValue', 0n, null, []],
      ['priceVarianceUnfavourable', 0n, null, []],
      ['priceVarianceFavourable', 0n, null, []],
      ['expense', 20_000n, { EXPENSE_CATEGORY: 'VEHICLE_REPAIRS' }, []],
      ['expense', 0n, { EXPENSE_CATEGORY: '*' }, []],
      ['reclaimableLevy', 3_000n, { TAX_LEVY: 'VAT' }, ['levy-vat']],
      ['gross', 23_000n, null, ['sup-1']],
    ]);
  });
});

describe('the amounts of an approved supplier credit note (FR-PUR-011)', () => {
  it('debits payables, clears 2010 at the cost of goods sent back and puts the rest of a matched credit on the variance', () => {
    const amounts = supplierCreditNoteAmounts(
      { grossPesewas: 30_000, purchaseOrderId: 'po-1', lines: [line(1, 30_000, 28_000)], levies: [], returns: [{ costPesewas: 27_500 }] },
      supplier,
    );
    expect(flat(amounts)).toEqual([
      ['gross', 30_000n, null, ['sup-1']],
      ['returnCost', 27_500n, null, []],
      ['priceVarianceFavourable', 2_500n, null, []],
      ['priceVarianceUnfavourable', 0n, null, []],
    ]);
  });

  it('puts a return that cost more than the credit on the unfavourable side', () => {
    const amounts = supplierCreditNoteAmounts(
      { grossPesewas: 10_000, purchaseOrderId: 'po-1', lines: [line(1, 10_000, null)], levies: [], returns: [{ costPesewas: 12_000 }] },
      supplier,
    );
    expect(flat(amounts).slice(2, 4)).toEqual([
      ['priceVarianceFavourable', 0n, null, []],
      ['priceVarianceUnfavourable', 2_000n, null, []],
    ]);
  });

  it('credits the expense of an expense invoice and reverses its reclaimable levies', () => {
    const amounts = supplierCreditNoteAmounts(
      { grossPesewas: 5_750, purchaseOrderId: null, lines: [line(1, 5_000, null, 'Transport')], levies: [levy(1, 'levy-vat', 'VAT', 750, true)], returns: [] },
      supplier,
    );
    expect(flat(amounts)).toEqual([
      ['gross', 5_750n, null, ['sup-1']],
      ['returnCost', 0n, null, []],
      ['expense', 5_000n, { EXPENSE_CATEGORY: 'TRANSPORT' }, []],
      ['priceVarianceFavourable', 0n, null, []],
      ['priceVarianceUnfavourable', 0n, null, []],
      ['reclaimableLevy', 750n, { TAX_LEVY: 'VAT' }, ['levy-vat']],
    ]);
  });
});

describe('the amounts of a supplier payment', () => {
  it('debits payables with the supplier and credits the account of the method', () => {
    expect(flat(supplierPaymentAmounts({ amountPesewas: 15_000, method: 'CASH' }, supplier))).toEqual([['amount', 15_000n, { PAYMENT_METHOD_KIND: 'CASH' }, ['sup-1', UNASSIGNED_BANK_ACCOUNT.refId]]]);
  });

  it('holds a bank or wallet payment against its named account, or the unassigned one until PUR names it (A-185)', () => {
    const wallet = { kind: 'BANK_ACCOUNT' as const, refId: 'bank-momo', displayName: 'MTN MoMo merchant' };
    expect(flat(supplierPaymentAmounts({ amountPesewas: 40_000, method: 'MOBILE_MONEY', bankAccount: wallet }, supplier))[0]![3]).toEqual(['sup-1', 'bank-momo']);
    expect(flat(supplierPaymentAmounts({ amountPesewas: 40_000, method: 'MOBILE_MONEY', bankAccount: null }, supplier))[0]![3]).toEqual(['sup-1', UNASSIGNED_BANK_ACCOUNT.refId]);
  });
});

describe('the determination key of an expense category', () => {
  it('upper-cases free text into a key and falls back to the default for nothing usable', () => {
    expect(expenseCategoryKey('Vehicle repairs & tyres')).toBe('VEHICLE_REPAIRS_TYRES');
    expect(expenseCategoryKey(null)).toBe('*');
    expect(expenseCategoryKey('  ')).toBe('*');
    expect(expenseCategoryKey('2026 rent')).toBe('*');
    expect(expenseCategoryKey('x'.repeat(70))).toBe('X'.repeat(60));
  });
});

describe('the amounts of an issued invoice or receipt (ADR-0003, bil.InvoiceIssued, A-200)', () => {
  const customer = { kind: 'CUSTOMER' as const, refId: 'cus-1', displayName: 'Royal Palm Hotel Ltd' };
  const billed = (overrides: Partial<BillingLine> & Pick<BillingLine, 'lineNo'>): BillingLine => ({
    lineKind: 'PRODUCT',
    glGroup: 'MEAT',
    netPesewas: 0,
    taxPesewas: 0,
    grossPesewas: 0,
    discountPesewas: 0,
    priceVariancePesewas: 0,
    stockUnitId: null,
    ...overrides,
  });
  const billedLevy = (lineNo: number, levyId: string, levyCode: string, amountPesewas: number): BillingLevy => ({ lineNo, levyId, levyCode, amountPesewas });

  it('owes the agreed gross, credits sales at the resolved amount by GL group and each levy, and the variance and promotion apart', () => {
    const amounts = invoiceIssuedAmounts(
      {
        grossPesewas: 136_000 + 42_560 + 3_000,
        lines: [
          // A goat resolved at 85,000 sold at 80,000 (zero-rated): 5,000 below.
          billed({ lineNo: 1, glGroup: 'LIVE_ANIMALS', netPesewas: 80_000, grossPesewas: 80_000, priceVariancePesewas: 5_000, stockUnitId: 'goat-1' }),
          // Meat above its resolved price by 1,000, with a 500 promotion; inclusive 42,560 split as FR-BIL-004 shows.
          billed({ lineNo: 2, netPesewas: 35_467, taxPesewas: 7_093, grossPesewas: 42_560, discountPesewas: 500, priceVariancePesewas: -1_000 }),
          billed({ lineNo: 3, lineKind: 'DELIVERY_FEE', glGroup: 'SERVICE', netPesewas: 2_500, taxPesewas: 500, grossPesewas: 3_000 }),
          billed({ lineNo: 4, glGroup: 'PRODUCE_EGGS', netPesewas: 56_000, grossPesewas: 56_000 }),
        ],
        levies: [billedLevy(2, 'vat', 'VAT', 5_320), billedLevy(2, 'nhil', 'NHIL', 887), billedLevy(2, 'getfund', 'GETFUND', 886), billedLevy(3, 'vat', 'VAT', 500), billedLevy(1, 'vat', 'VAT', 0)],
      },
      customer,
    );
    expect(flat(amounts)).toEqual([
      ['gross', 181_560n, null, ['cus-1']],
      ['sales', 85_000n, { GL_GROUP: 'LIVE_ANIMALS' }, []],
      ['sales', 34_967n, { GL_GROUP: 'MEAT' }, []],
      ['deliveryFee', 2_500n, null, []],
      ['sales', 56_000n, { GL_GROUP: 'PRODUCE_EGGS' }, []],
      ['levy', 5_320n, { TAX_LEVY: 'VAT' }, ['vat']],
      ['levy', 887n, { TAX_LEVY: 'NHIL' }, ['nhil']],
      ['levy', 886n, { TAX_LEVY: 'GETFUND' }, ['getfund']],
      ['levy', 500n, { TAX_LEVY: 'VAT' }, ['vat']],
      ['levy', 0n, { TAX_LEVY: 'VAT' }, ['vat']],
      ['priceVarianceBelow', 5_000n, null, []],
      ['priceVarianceAbove', 0n, null, []],
      ['priceVarianceBelow', 0n, null, []],
      ['priceVarianceAbove', 1_000n, null, []],
      ['priceVarianceBelow', 0n, null, []],
      ['priceVarianceAbove', 0n, null, []],
      ['priceVarianceBelow', 0n, null, []],
      ['priceVarianceAbove', 0n, null, []],
      ['promotion', 0n, null, []],
      ['promotion', 500n, null, []],
      ['promotion', 0n, null, []],
      ['promotion', 0n, null, []],
    ]);
    const debit = amounts.filter((a) => ['gross', 'priceVarianceBelow', 'promotion'].includes(a.key)).reduce((s, a) => s + a.amount.pesewas, 0n);
    const credit = amounts.filter((a) => ['sales', 'deliveryFee', 'levy', 'priceVarianceAbove'].includes(a.key)).reduce((s, a) => s + a.amount.pesewas, 0n);
    expect(debit).toBe(credit);
  });

  it('carries the goat as the cost object of its sales line', () => {
    const [, sales] = invoiceIssuedAmounts({ grossPesewas: 80_000, lines: [billed({ lineNo: 1, netPesewas: 80_000, grossPesewas: 80_000, stockUnitId: 'goat-1' })], levies: [] }, customer);
    expect(sales!.costObjectId).toBe('goat-1');
  });

  it('holds a walk-in receipt against the one walk-in customer party', () => {
    expect(customerParty(null, null)).toEqual(WALK_IN_CUSTOMER);
    expect(customerParty('cus-1', 'Royal Palm Hotel Ltd')).toEqual(customer);
    expect(customerParty('cus-2', null)).toEqual({ kind: 'CUSTOMER', refId: 'cus-2', displayName: 'cus-2' });
  });
});

describe('the amounts of an issued credit note (ADR-0003, bil.CreditNoteIssued)', () => {
  const customer = { kind: 'CUSTOMER' as const, refId: 'cus-1', displayName: 'Royal Palm Hotel Ltd' };
  it('debits returns and allowances at the net and each levy back, and credits receivables at the gross', () => {
    const amounts = creditNoteIssuedAmounts(
      { netPesewas: 25_000, grossPesewas: 30_000, levies: [{ lineNo: 1, levyId: 'vat', levyCode: 'VAT', amountPesewas: 3_750 }, { lineNo: 1, levyId: 'nhil', levyCode: 'NHIL', amountPesewas: 625 }, { lineNo: 1, levyId: 'getfund', levyCode: 'GETFUND', amountPesewas: 625 }] },
      customer,
    );
    expect(flat(amounts)).toEqual([
      ['net', 25_000n, null, []],
      ['levy', 3_750n, { TAX_LEVY: 'VAT' }, ['vat']],
      ['levy', 625n, { TAX_LEVY: 'NHIL' }, ['nhil']],
      ['levy', 625n, { TAX_LEVY: 'GETFUND' }, ['getfund']],
      ['gross', 30_000n, null, ['cus-1']],
    ]);
  });
});

describe('the amounts of an issued debit note (ADR-0003, bil.DebitNoteIssued)', () => {
  const customer = { kind: 'CUSTOMER' as const, refId: 'cus-1', displayName: 'Royal Palm Hotel Ltd' };
  it('debits receivables at the gross and credits each charge by GL group, a delivery fee to its own key, and each levy', () => {
    const amounts = debitNoteIssuedAmounts(
      {
        grossPesewas: 11_500 + 1_000,
        lines: [
          { lineNo: 1, lineKind: 'ADJUSTMENT', glGroup: 'OTHER', netPesewas: 10_000, taxPesewas: 1_500, grossPesewas: 11_500, discountPesewas: 0, priceVariancePesewas: 0, stockUnitId: null },
          { lineNo: 2, lineKind: 'DELIVERY_FEE', glGroup: 'SERVICE', netPesewas: 1_000, taxPesewas: 0, grossPesewas: 1_000, discountPesewas: 0, priceVariancePesewas: 0, stockUnitId: null },
        ],
        levies: [{ lineNo: 1, levyId: 'vat', levyCode: 'VAT', amountPesewas: 1_500 }],
      },
      customer,
    );
    expect(flat(amounts)).toEqual([
      ['gross', 12_500n, null, ['cus-1']],
      ['sales', 10_000n, { GL_GROUP: 'OTHER' }, []],
      ['deliveryFee', 1_000n, null, []],
      ['levy', 1_500n, { TAX_LEVY: 'VAT' }, ['vat']],
    ]);
  });
});

describe('the amounts of a cleared payment (ADR-0003, pay.PaymentCleared)', () => {
  const tema = customerParty('cus-1', 'Tema Cold Store Ltd');
  const till = { id: 'reg-1', code: 'T1' };

  it('debits the tender by the method kind against its till and credits the allocated part to receivables against the customer', () => {
    expect(flat(paymentClearedAmounts({ methodKind: 'CASH', amountPesewas: 44_000, allocatedPesewas: 44_000, unallocatedPesewas: 0, register: till }, tema))).toEqual([
      ['tender', 44_000n, { PAYMENT_METHOD_KIND: 'CASH' }, ['reg-1']],
      ['allocated', 44_000n, null, ['cus-1']],
      ['unallocated', 0n, null, ['cus-1']],
    ]);
  });

  it('holds what was not allocated as the customer’s deposit, the two parts summing to the tender exactly', () => {
    const amounts = paymentClearedAmounts({ methodKind: 'CASH', amountPesewas: 120_000, allocatedPesewas: 100_000, unallocatedPesewas: 20_000, register: till }, tema);
    expect(amounts.map((a) => a.amount.pesewas)).toEqual([120_000n, 100_000n, 20_000n]);
  });

  it('names a walk-in sale’s receivable against the one walk-in party', () => {
    const amounts = paymentClearedAmounts({ methodKind: 'CASH', amountPesewas: 1, allocatedPesewas: 1, unallocatedPesewas: 0, register: till }, customerParty(null, null));
    expect(amounts[1]!.subledgers).toEqual([WALK_IN_CUSTOMER]);
  });

  it('refuses a payload whose parts do not sum to the tender', () => {
    expect(() => paymentClearedAmounts({ methodKind: 'CASH', amountPesewas: 44_000, allocatedPesewas: 44_000, unallocatedPesewas: 1, register: till }, tema)).toThrow(/sum/);
  });

  it('names no till for a tender that has none', () => {
    expect(paymentClearedAmounts({ methodKind: 'CHEQUE', amountPesewas: 5, allocatedPesewas: 0, unallocatedPesewas: 5, register: null }, tema)[0]!.subledgers).toEqual([]);
  });
});

describe('the amounts of a provider payment, an allocation from deposit and a refund (ADR-0003, A-210)', () => {
  const tema = customerParty('cus-1', 'Tema Cold Store Ltd');
  const till = { id: 'reg-1', code: 'T1' };

  it('debits a mobile money tender against the provider that took it, and holds it all on deposit', () => {
    expect(flat(paymentClearedAmounts({ methodKind: 'MOBILE_MONEY', amountPesewas: 50_000, allocatedPesewas: 0, unallocatedPesewas: 50_000, register: null, provider: 'PAYSTACK' }, tema))).toEqual([
      ['tender', 50_000n, { PAYMENT_METHOD_KIND: 'MOBILE_MONEY' }, [providerParty('PAYSTACK').refId]],
      ['allocated', 0n, null, ['cus-1']],
      ['unallocated', 50_000n, null, ['cus-1']],
    ]);
  });

  it('names one stable party per provider, and refuses a provider it does not know', () => {
    expect(providerParty('PAYSTACK')).toEqual({ kind: 'PROVIDER', refId: '01900000-0000-7000-8500-000000000003', displayName: 'Paystack' });
    expect(() => providerParty('HUBTEL')).toThrow(/HUBTEL/);
  });

  it('applies a deposit to a document, or takes an allocation off back to deposit, against the customer', () => {
    expect(flat(depositAllocatedAmounts({ appliedPesewas: 100_000, unappliedPesewas: 0 }, tema))).toEqual([
      ['applied', 100_000n, null, ['cus-1']],
      ['unapplied', 0n, null, ['cus-1']],
    ]);
    expect(flat(depositAllocatedAmounts({ appliedPesewas: 0, unappliedPesewas: 1 }, tema)).map((a) => a[1])).toEqual([0n, 1n]);
  });

  it('refuses an allocation event that both applies and takes off', () => {
    expect(() => depositAllocatedAmounts({ appliedPesewas: 5, unappliedPesewas: 5 }, tema)).toThrow(/one/);
  });

  it('pays a refund out of the deposit to the original tender, against its till or its provider', () => {
    expect(flat(refundPaidAmounts({ amountPesewas: 25_000, methodKind: 'MOBILE_MONEY', register: null, provider: 'PAYSTACK' }, tema))).toEqual([
      ['refund', 25_000n, { PAYMENT_METHOD_KIND: 'MOBILE_MONEY' }, ['cus-1', providerParty('PAYSTACK').refId]],
    ]);
    expect(flat(refundPaidAmounts({ amountPesewas: 6_000, methodKind: 'CASH', register: till, provider: null }, tema))).toEqual([
      ['refund', 6_000n, { PAYMENT_METHOD_KIND: 'CASH' }, ['cus-1', 'reg-1']],
    ]);
  });
});

describe('the amounts of a cheque, store credit and a cheque’s clearing (ADR-0003, ADR-0064)', () => {
  const tema = customerParty('cus-1', 'Tema Cold Store Ltd');
  const gcb = { kind: 'BANK_ACCOUNT' as const, refId: 'bank-1', displayName: 'GCB current account' };

  it('debits a cheque of 100,000 to its tender, with no party, and credits the allocated part to receivables', () => {
    expect(flat(paymentClearedAmounts({ methodKind: 'CHEQUE', amountPesewas: 100_000, allocatedPesewas: 100_000, unallocatedPesewas: 0, register: null }, tema))).toEqual([
      ['tender', 100_000n, { PAYMENT_METHOD_KIND: 'CHEQUE' }, []],
      ['allocated', 100_000n, null, ['cus-1']],
      ['unallocated', 0n, null, ['cus-1']],
    ]);
  });

  it('debits store credit redeemed against the customer whose credit it was', () => {
    expect(flat(paymentClearedAmounts({ methodKind: 'STORE_CREDIT', amountPesewas: 6_000, allocatedPesewas: 6_000, unallocatedPesewas: 0, register: null }, tema))).toEqual([
      ['tender', 6_000n, { PAYMENT_METHOD_KIND: 'STORE_CREDIT' }, ['cus-1']],
      ['allocated', 6_000n, null, ['cus-1']],
      ['unallocated', 0n, null, ['cus-1']],
    ]);
  });

  it('refunds to store credit against the customer: the tender is store credit', () => {
    expect(flat(refundPaidAmounts({ amountPesewas: 6_000, methodKind: 'STORE_CREDIT', register: null, provider: null }, tema))).toEqual([
      ['refund', 6_000n, { PAYMENT_METHOD_KIND: 'STORE_CREDIT' }, ['cus-1']],
    ]);
  });

  it('pays a refund against a credit note out of receivables (Dr 1200 against the customer) to the original tender', () => {
    expect(flat(refundPaidAmounts({ amountPesewas: 30_000, methodKind: 'MOBILE_MONEY', register: null, provider: 'PAYSTACK', creditNoteId: 'crn-1' }, tema))).toEqual([
      ['creditRefund', 30_000n, { PAYMENT_METHOD_KIND: 'MOBILE_MONEY' }, ['cus-1', providerParty('PAYSTACK').refId]],
    ]);
    expect(flat(refundPaidAmounts({ amountPesewas: 1, methodKind: 'STORE_CREDIT', register: null, provider: null, creditNoteId: 'crn-1' }, tema))).toEqual([
      ['creditRefund', 1n, { PAYMENT_METHOD_KIND: 'STORE_CREDIT' }, ['cus-1']],
    ]);
  });

  it('pays a cheque back through a bank payout out of the bank account the cheque was paid into', () => {
    expect(flat(refundPaidAmounts({ amountPesewas: 30_000, methodKind: 'BANK_TRANSFER', register: null, provider: null, creditNoteId: 'crn-1' }, tema, gcb))).toEqual([
      ['creditRefund', 30_000n, { PAYMENT_METHOD_KIND: 'BANK_TRANSFER' }, ['cus-1', 'bank-1']],
    ]);
    expect(flat(refundPaidAmounts({ amountPesewas: 12_500, methodKind: 'BANK_TRANSFER', register: null, provider: null, creditNoteId: null }, tema, gcb))).toEqual([
      ['refund', 12_500n, { PAYMENT_METHOD_KIND: 'BANK_TRANSFER' }, ['cus-1', 'bank-1']],
    ]);
  });

  it('clears a cheque of 100,000 into the bank account it was paid into', () => {
    expect(flat(chequeClearedAmounts({ amountPesewas: 100_000 }, gcb))).toEqual([['cheque', 100_000n, null, ['bank-1']]]);
    expect(flat(chequeClearedAmounts({ amountPesewas: 1 }, gcb))).toEqual([['cheque', 1n, null, ['bank-1']]]);
  });
});

describe('the amounts of a provider settlement, a bank transfer cleared by its line and a receipt held in suspense (ADR-0003, ADR-0065)', () => {
  const gcb = { kind: 'BANK_ACCOUNT' as const, refId: 'bank-1', displayName: 'GCB current account' };
  const tema = customerParty('cus-1', 'Tema Cold Store Ltd');

  it('settles three payments of 150,000 with a fee of 1,500: 148,500 into the bank, 1,500 to fees, 150,000 off the provider', () => {
    expect(flat(providerSettledAmounts({ provider: 'PAYSTACK', grossPesewas: 150_000, feePesewas: 1_500, netPesewas: 148_500 }, gcb))).toEqual([
      ['net', 148_500n, null, ['bank-1']],
      ['fee', 1_500n, null, []],
      ['gross', 150_000n, null, [providerParty('PAYSTACK').refId]],
    ]);
  });

  it('settles a single pesewa with no fee', () => {
    expect(flat(providerSettledAmounts({ provider: 'PAYSTACK', grossPesewas: 1, feePesewas: 0, netPesewas: 1 }, gcb))).toEqual([
      ['net', 1n, null, ['bank-1']],
      ['fee', 0n, null, []],
      ['gross', 1n, null, [providerParty('PAYSTACK').refId]],
    ]);
  });

  it('refuses a settlement whose net and fee do not sum to its gross, before anything posts', () => {
    expect(() => providerSettledAmounts({ provider: 'PAYSTACK', grossPesewas: 150_000, feePesewas: 1_500, netPesewas: 148_501 }, gcb)).toThrow(/sum/);
  });

  it('clears a bank transfer of 75,000 into the bank account its statement line names, held as the customer\'s deposit', () => {
    expect(flat(paymentClearedAmounts({ methodKind: 'BANK_TRANSFER', amountPesewas: 75_000, allocatedPesewas: 0, unallocatedPesewas: 75_000, register: null }, tema, gcb))).toEqual([
      ['tender', 75_000n, { PAYMENT_METHOD_KIND: 'BANK_TRANSFER' }, ['bank-1']],
      ['allocated', 0n, null, ['cus-1']],
      ['unallocated', 75_000n, null, ['cus-1']],
    ]);
  });

  it('refuses a bank transfer with no bank account to land in', () => {
    expect(() => paymentClearedAmounts({ methodKind: 'BANK_TRANSFER', amountPesewas: 75_000, allocatedPesewas: 0, unallocatedPesewas: 75_000, register: null }, tema)).toThrow(/bank account/);
  });

  it('holds an unidentified receipt of 2,000 in suspense: the bank less its fee, the fee, the whole in 2290', () => {
    expect(flat(unidentifiedReceiptAmounts({ amountPesewas: 2_000, feePesewas: 0 }, gcb))).toEqual([
      ['banked', 2_000n, null, ['bank-1']],
      ['fee', 0n, null, []],
      ['held', 2_000n, null, []],
    ]);
    expect(flat(unidentifiedReceiptAmounts({ amountPesewas: 2_000, feePesewas: 39 }, gcb))).toEqual([
      ['banked', 1_961n, null, ['bank-1']],
      ['fee', 39n, null, []],
      ['held', 2_000n, null, []],
    ]);
  });

  it('refuses an unidentified receipt whose fee is more than its amount', () => {
    expect(() => unidentifiedReceiptAmounts({ amountPesewas: 100, feePesewas: 101 }, gcb)).toThrow(/fee/);
  });
});

describe('the till\'s events (B9b, FR-POS-015, FR-POS-016, FR-POS-019)', () => {
  const t1 = { id: '019a8000-0000-7000-8000-00000000a7a1', code: 'T1' };
  const till = { kind: 'REGISTER', refId: t1.id, displayName: 'T1' };

  it('holds the float, a drop and a pay-in against the till that took them', () => {
    const shown = (amounts: ReturnType<typeof tillAmounts>) => amounts.map((a) => ({ ...a, amount: a.amount.pesewas }));
    expect(shown(tillAmounts({ register: t1, amountsPesewas: { float: 50_000 }, reasonCode: null }))).toEqual([{ key: 'float', amount: 50_000n, subledgers: [till] }]);
    expect(shown(tillAmounts({ register: t1, amountsPesewas: { drop: 30_000 }, reasonCode: 'SAFE_DROP' }))).toEqual([{ key: 'drop', amount: 30_000n, subledgers: [till] }]);
  });

  it('names a pay-out\'s expense by its reason, against the till', () => {
    expect(tillAmounts({ register: t1, amountsPesewas: { payOut: 1_250 }, reasonCode: 'FUEL_PAYOUT' }).map((a) => ({ ...a, amount: a.amount.pesewas }))).toEqual([
      { key: 'payOut', amount: 1_250n, subledgers: [till], determinants: { EXPENSE_CATEGORY: 'FUEL_PAYOUT' } },
    ]);
  });

  it('closes a short till as 64,000 expected, 63,500 to the safe and 500 short, balanced', () => {
    const amounts = tillAmounts({ register: t1, amountsPesewas: { expected: 64_000, returnedToSafe: 63_500, short: 500, over: 0 }, reasonCode: null });
    expect(amounts.map((a) => [a.key, a.amount.pesewas])).toEqual([['expected', 64_000n], ['returnedToSafe', 63_500n], ['short', 500n], ['over', 0n]]);
  });

  it('refuses a close that leaves one of its four amounts out', () => {
    expect(() => tillAmounts({ register: t1, amountsPesewas: { expected: 64_000, returnedToSafe: 63_500, short: 500 }, reasonCode: null })).toThrow(/names expected, returnedToSafe, short and over/);
  });

  it('refuses a close whose parts do not balance by one pesewa', () => {
    expect(() => tillAmounts({ register: t1, amountsPesewas: { expected: 64_000, returnedToSafe: 63_500, short: 499, over: 0 }, reasonCode: null })).toThrow(/balance/);
  });
});
