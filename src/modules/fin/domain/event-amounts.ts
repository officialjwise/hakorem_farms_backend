import { Money } from '@hakorem/kernel';
import { DEFAULT_DETERMINANT_KEY, type PostingAmount, type SubledgerRef } from './posting';

/*
 * The named amounts of each financial event FIN posts from (ADR-0003). FIN reads the published payloads by their
 * documented fields (docs/DOMAIN_MODEL.md section 5) and never imports a higher module; the shapes below are the
 * fields it relies on. Amounts arrive as JSON integers of pesewas and are summed exactly.
 */

/** The fields of an INV stock posting event FIN reads (`inv.GoodsReceived`, `inv.StockIssuedForSale`, ...). */
export interface StockPostingFields {
  readonly valuePesewas: number;
  readonly stockUnitId: string | null;
  readonly movementType: string;
}

/** The value of a stock movement, determined by the product's GL group and, for a write-off, the reason's loss group. */
export function stockMovementAmounts(payload: StockPostingFields, facts: { readonly glGroup: string; readonly lossGroup: string | null }): PostingAmount[] {
  return [
    {
      key: 'value',
      amount: Money.fromJsonInteger(payload.valuePesewas),
      determinants: facts.lossGroup === null ? { GL_GROUP: facts.glGroup } : { GL_GROUP: facts.glGroup, LOSS_GROUP: facts.lossGroup },
      costObjectId: payload.stockUnitId,
      memo: payload.movementType,
    },
  ];
}

/** One named amount on fixed accounts, for example a processing order's direct cost. */
export function valueAmount(key: string, pesewas: number, costObjectId: string): PostingAmount[] {
  return [{ key, amount: Money.fromJsonInteger(pesewas), costObjectId }];
}

export interface PurchaseLine {
  readonly lineNo: number;
  readonly netPesewas: number;
  /** What the receipt booked to 2010 for the invoiced quantity; null for a line with no order line. */
  readonly orderValuePesewas: number | null;
  readonly expenseCategory: string | null;
}

export interface PurchaseLevy {
  readonly lineNo: number;
  readonly levyId: string;
  readonly levyCode: string;
  readonly amountPesewas: number;
  readonly isReclaimable: boolean;
}

const MAX_KEY_LENGTH = 60;

/** An expense category as a determination key: upper case, words joined by `_`; the default when nothing usable is left. */
export function expenseCategoryKey(category: string | null): string {
  const key = (category ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_KEY_LENGTH);
  return /^[A-Z]/.test(key) ? key : DEFAULT_DETERMINANT_KEY;
}

function nonReclaimableOn(lineNo: number, levies: readonly PurchaseLevy[]): Money {
  return Money.sum(levies.filter((l) => l.lineNo === lineNo && !l.isReclaimable).map((l) => Money.fromJsonInteger(l.amountPesewas)));
}

function reclaimableLevies(levies: readonly PurchaseLevy[]): PostingAmount[] {
  return levies
    .filter((l) => l.isReclaimable)
    .map((l) => ({
      key: 'reclaimableLevy',
      amount: Money.fromJsonInteger(l.amountPesewas),
      determinants: { TAX_LEVY: l.levyCode },
      subledgers: [{ kind: 'TAX_LEVY' as const, refId: l.levyId, displayName: l.levyCode }],
    }));
}

function expenseLines(lines: readonly PurchaseLine[], levies: readonly PurchaseLevy[]): PostingAmount[] {
  return lines.map((l) => ({
    key: 'expense',
    amount: Money.fromJsonInteger(l.netPesewas).plus(nonReclaimableOn(l.lineNo, levies)),
    determinants: { EXPENSE_CATEGORY: expenseCategoryKey(l.expenseCategory) },
  }));
}

/** A difference split onto the side it falls: above zero is unfavourable (a debit), below is favourable (a credit). */
function variance(difference: bigint): PostingAmount[] {
  return [
    { key: 'priceVarianceUnfavourable', amount: Money.ofPesewas(difference > 0n ? difference : 0n) },
    { key: 'priceVarianceFavourable', amount: Money.ofPesewas(difference < 0n ? -difference : 0n) },
  ];
}

/**
 * `pur.SupplierInvoiceMatched` and `pur.ExpenseInvoiceApproved` (FR-PUR-015, A-027): a line with an order line clears
 * 2010 at its order value, and whatever it costs beyond that (its net and any levy that cannot be reclaimed) lands on
 * purchase price variance, never back onto the stock; a line with no order line is an expense by its category;
 * each reclaimable levy goes to 1400 against its levy; the gross is owed to the supplier.
 */
export function supplierInvoiceAmounts(
  payload: { readonly grossPesewas: number; readonly lines: readonly PurchaseLine[]; readonly levies: readonly PurchaseLevy[] },
  supplier: SubledgerRef,
): PostingAmount[] {
  const ordered = payload.lines.filter((l) => l.orderValuePesewas !== null);
  const receiptValue = Money.sum(ordered.map((l) => Money.fromJsonInteger(l.orderValuePesewas!)));
  const cost = Money.sum(ordered.map((l) => Money.fromJsonInteger(l.netPesewas).plus(nonReclaimableOn(l.lineNo, payload.levies))));
  return [
    { key: 'receiptValue', amount: receiptValue },
    ...variance(cost.pesewas - receiptValue.pesewas),
    ...expenseLines(
      payload.lines.filter((l) => l.orderValuePesewas === null),
      payload.levies,
    ),
    ...reclaimableLevies(payload.levies),
    { key: 'gross', amount: Money.fromJsonInteger(payload.grossPesewas), subledgers: [supplier] },
  ];
}

/**
 * `pur.SupplierCreditNoteApproved` (FR-PUR-011): payables are reduced by the gross, 2010 is cleared at the cost of any
 * goods sent back, each reclaimable levy is taken back from 1400; the rest of a credit against an order lands on
 * purchase price variance, and a credit against an expense reduces the expense.
 */
export function supplierCreditNoteAmounts(
  payload: {
    readonly grossPesewas: number;
    readonly purchaseOrderId: string | null;
    readonly lines: readonly PurchaseLine[];
    readonly levies: readonly PurchaseLevy[];
    readonly returns: readonly { readonly costPesewas: number }[];
  },
  supplier: SubledgerRef,
): PostingAmount[] {
  const returnCost = Money.sum(payload.returns.map((r) => Money.fromJsonInteger(r.costPesewas)));
  const credited = Money.sum(payload.lines.map((l) => Money.fromJsonInteger(l.netPesewas).plus(nonReclaimableOn(l.lineNo, payload.levies))));
  const againstExpense = payload.purchaseOrderId === null;
  return [
    { key: 'gross', amount: Money.fromJsonInteger(payload.grossPesewas), subledgers: [supplier] },
    { key: 'returnCost', amount: returnCost },
    ...(againstExpense ? expenseLines(payload.lines, payload.levies) : []),
    ...variance(againstExpense ? returnCost.pesewas : returnCost.pesewas - credited.pesewas).reverse(),
    ...reclaimableLevies(payload.levies),
  ];
}

/**
 * The bank account subledger party of a payment that names none (A-185): PUR cannot name the farm's own account yet, so
 * a bank, mobile money or cheque payment is held on 1100 or 1110 against this one party until the accountant reclasses it.
 */
export const UNASSIGNED_BANK_ACCOUNT: SubledgerRef = { kind: 'BANK_ACCOUNT', refId: '01900000-0000-7000-8500-000000000001', displayName: 'Bank account not yet named' };

/** `pur.SupplierPaymentMade`: payables debited against the supplier, the account of the method credited. */
export function supplierPaymentAmounts(
  payload: { readonly amountPesewas: number; readonly method: string; readonly bankAccount?: SubledgerRef | null },
  supplier: SubledgerRef,
): PostingAmount[] {
  return [
    {
      key: 'amount',
      amount: Money.fromJsonInteger(payload.amountPesewas),
      determinants: { PAYMENT_METHOD_KIND: payload.method },
      subledgers: [supplier, payload.bankAccount ?? UNASSIGNED_BANK_ACCOUNT],
    },
  ];
}

/** The fields of a billing document line FIN reads from `bil.InvoiceIssued` and `bil.DebitNoteIssued`. */
export interface BillingLine {
  readonly lineNo: number;
  readonly lineKind: 'PRODUCT' | 'DELIVERY_FEE' | 'ADJUSTMENT';
  readonly glGroup: string;
  readonly netPesewas: number;
  readonly taxPesewas: number;
  readonly grossPesewas: number;
  /** The promotion and allocated header discount taken off the line (4220). */
  readonly discountPesewas: number;
  /** The line extended at its resolved price less at its agreed price: above zero agreed was below resolved. */
  readonly priceVariancePesewas: number;
  readonly stockUnitId: string | null;
}

/** One levy row of a billing document line: the levy and its amount, posted against the levy (ADR-0020). */
export interface BillingLevy {
  readonly lineNo: number;
  readonly levyId: string;
  readonly levyCode: string;
  readonly amountPesewas: number;
}

/**
 * The customer a billing document is held against on 1200. A walk-in sale has no customer, so its receipt is held
 * against this one party until the payment clears it (A-200).
 */
export const WALK_IN_CUSTOMER: SubledgerRef = { kind: 'CUSTOMER', refId: '01900000-0000-7000-8500-000000000002', displayName: 'Walk-in customer' };

export function customerParty(customerId: string | null, name: string | null): SubledgerRef {
  return customerId === null ? WALK_IN_CUSTOMER : { kind: 'CUSTOMER', refId: customerId, displayName: name ?? customerId };
}

/** The fields of PAY's `pay.PaymentCleared` FIN reads. */
export interface PaymentClearedFields {
  readonly methodKind: string;
  readonly amountPesewas: number;
  readonly allocatedPesewas: number;
  readonly unallocatedPesewas: number;
  readonly register: { readonly id: string; readonly code: string } | null;
}

/**
 * `pay.PaymentCleared` (ADR-0003): the tender to its account by the method's kind (cash against the till that took
 * it); the allocated part off 1200 and the unallocated part into 2200, both against the customer. The two parts are
 * the tender exactly, or the payload is refused before anything posts.
 */
export function paymentClearedAmounts(payload: PaymentClearedFields, customer: SubledgerRef): PostingAmount[] {
  const tender = Money.fromJsonInteger(payload.amountPesewas);
  const allocated = Money.fromJsonInteger(payload.allocatedPesewas);
  const unallocated = Money.fromJsonInteger(payload.unallocatedPesewas);
  if (!allocated.plus(unallocated).equals(tender)) {
    throw new Error(`pay.PaymentCleared: allocated ${allocated.pesewas} and unallocated ${unallocated.pesewas} do not sum to the tender ${tender.pesewas}`);
  }
  const till: SubledgerRef[] = payload.register === null ? [] : [{ kind: 'REGISTER', refId: payload.register.id, displayName: payload.register.code }];
  return [
    { key: 'tender', amount: tender, determinants: { PAYMENT_METHOD_KIND: payload.methodKind }, subledgers: till },
    { key: 'allocated', amount: allocated, subledgers: [customer] },
    { key: 'unallocated', amount: unallocated, subledgers: [customer] },
  ];
}

function billingLevies(levies: readonly BillingLevy[]): PostingAmount[] {
  return levies.map((l) => ({
    key: 'levy',
    amount: Money.fromJsonInteger(l.amountPesewas),
    determinants: { TAX_LEVY: l.levyCode },
    subledgers: [{ kind: 'TAX_LEVY' as const, refId: l.levyId, displayName: l.levyCode }],
  }));
}

/** A line's income: sales by GL group, or the delivery fee, at the amount the line would have had at its resolved price. */
function incomeLine(l: BillingLine, amount: Money): PostingAmount {
  return l.lineKind === 'DELIVERY_FEE'
    ? { key: 'deliveryFee', amount }
    : { key: 'sales', amount, determinants: { GL_GROUP: l.glGroup }, ...(l.stockUnitId === null ? {} : { costObjectId: l.stockUnitId }) };
}

/**
 * `bil.InvoiceIssued` (ADR-0003; a RECEIPT posts the same): 1200 owes the agreed gross against the customer; each line
 * credits its income at what it would have been at the resolved price (its net, plus its discount, plus its variance),
 * each levy credits 2100 against the levy, a variance below the resolved price debits 4210 and one above credits it,
 * and a discount debits 4220. The variance and discount are carried as the line shows them (A-200).
 */
export function invoiceIssuedAmounts(
  payload: { readonly grossPesewas: number; readonly lines: readonly BillingLine[]; readonly levies: readonly BillingLevy[] },
  customer: SubledgerRef,
): PostingAmount[] {
  const resolved = (l: BillingLine) => Money.ofPesewas(BigInt(l.netPesewas) + BigInt(l.discountPesewas) + BigInt(l.priceVariancePesewas));
  return [
    { key: 'gross', amount: Money.fromJsonInteger(payload.grossPesewas), subledgers: [customer] },
    ...payload.lines.map((l) => incomeLine(l, resolved(l))),
    ...billingLevies(payload.levies),
    ...payload.lines.flatMap((l) => {
      const variance = BigInt(l.priceVariancePesewas);
      return [
        { key: 'priceVarianceBelow', amount: Money.ofPesewas(variance > 0n ? variance : 0n) },
        { key: 'priceVarianceAbove', amount: Money.ofPesewas(variance < 0n ? -variance : 0n) },
      ];
    }),
    ...payload.lines.map((l) => ({ key: 'promotion', amount: Money.fromJsonInteger(l.discountPesewas) })),
  ];
}

/** `bil.CreditNoteIssued` (ADR-0003): 4200 at the net and each levy back from 2100, against 1200 at the gross. */
export function creditNoteIssuedAmounts(
  payload: { readonly netPesewas: number; readonly grossPesewas: number; readonly levies: readonly BillingLevy[] },
  customer: SubledgerRef,
): PostingAmount[] {
  return [{ key: 'net', amount: Money.fromJsonInteger(payload.netPesewas) }, ...billingLevies(payload.levies), { key: 'gross', amount: Money.fromJsonInteger(payload.grossPesewas), subledgers: [customer] }];
}

/** `bil.DebitNoteIssued` (ADR-0003): 1200 at the gross, each charge by GL group (or the delivery fee), each levy. */
export function debitNoteIssuedAmounts(
  payload: { readonly grossPesewas: number; readonly lines: readonly BillingLine[]; readonly levies: readonly BillingLevy[] },
  customer: SubledgerRef,
): PostingAmount[] {
  return [
    { key: 'gross', amount: Money.fromJsonInteger(payload.grossPesewas), subledgers: [customer] },
    ...payload.lines.map((l) => incomeLine(l, Money.fromJsonInteger(l.netPesewas))),
    ...billingLevies(payload.levies),
  ];
}
