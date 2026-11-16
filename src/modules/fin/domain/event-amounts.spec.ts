import { describe, expect, it } from 'vitest';
import {
  expenseCategoryKey,
  stockMovementAmounts,
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
