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
  /** The provider that took a mobile money or card payment (its party on 1120), null for any other tender. */
  readonly provider?: string | null;
}

/**
 * The payment providers' parties on 1120 Payment provider clearing: one stable party per provider PAY's port names
 * (A-210). A provider FIN does not know refuses the posting, so the payment rolls back rather than post to no one.
 */
const PROVIDER_PARTIES: Readonly<Record<string, SubledgerRef>> = {
  PAYSTACK: { kind: 'PROVIDER', refId: '01900000-0000-7000-8500-000000000003', displayName: 'Paystack' },
};

export function providerParty(provider: string): SubledgerRef {
  const party = PROVIDER_PARTIES[provider];
  if (party === undefined) throw new Error(`payment provider ${provider} has no subledger party`);
  return party;
}

/** The till or the provider a tender is held against, by what the payment names. */
function tenderParties(register: { readonly id: string; readonly code: string } | null, provider: string | null | undefined): SubledgerRef[] {
  return [
    ...(register === null ? [] : [{ kind: 'REGISTER' as const, refId: register.id, displayName: register.code }]),
    ...(provider === null || provider === undefined ? [] : [providerParty(provider)]),
  ];
}

/**
 * `pay.PaymentCleared` (ADR-0003): the tender to its account by the method's kind (cash against the till that took
 * it); the allocated part off 1200 and the unallocated part into 2200, both against the customer. The two parts are
 * the tender exactly, or the payload is refused before anything posts.
 */
export function paymentClearedAmounts(payload: PaymentClearedFields, customer: SubledgerRef, bankAccount: SubledgerRef | null = null): PostingAmount[] {
  if (payload.methodKind === 'BANK_TRANSFER' && bankAccount === null) {
    throw new Error('pay.PaymentCleared: a bank transfer names the bank account it landed in');
  }
  const tender = Money.fromJsonInteger(payload.amountPesewas);
  const allocated = Money.fromJsonInteger(payload.allocatedPesewas);
  const unallocated = Money.fromJsonInteger(payload.unallocatedPesewas);
  if (!allocated.plus(unallocated).equals(tender)) {
    throw new Error(`pay.PaymentCleared: allocated ${allocated.pesewas} and unallocated ${unallocated.pesewas} do not sum to the tender ${tender.pesewas}`);
  }
  return [
    {
      key: 'tender',
      amount: tender,
      determinants: { PAYMENT_METHOD_KIND: payload.methodKind },
      // Store credit redeemed comes off the customer's own credit (2210); every other tender is held against its till or provider.
      // A bank transfer lands in the bank account its statement line names (ADR-0065).
      subledgers: payload.methodKind === 'STORE_CREDIT' ? [customer] : bankAccount !== null ? [bankAccount] : tenderParties(payload.register, payload.provider),
    },
    { key: 'allocated', amount: allocated, subledgers: [customer] },
    { key: 'unallocated', amount: unallocated, subledgers: [customer] },
  ];
}

/**
 * `pay.DepositAllocated` (ADR-0003, A-210): a cleared payment's deposit applied to a billing document (Dr 2200, Cr
 * 1200), or an allocation taken off back to deposit (Dr 1200, Cr 2200), both against the customer. One event does one
 * of the two.
 */
export function depositAllocatedAmounts(payload: { readonly appliedPesewas: number; readonly unappliedPesewas: number }, customer: SubledgerRef): PostingAmount[] {
  const applied = Money.fromJsonInteger(payload.appliedPesewas);
  const unapplied = Money.fromJsonInteger(payload.unappliedPesewas);
  if (!applied.isZero() && !unapplied.isZero()) {
    throw new Error('pay.DepositAllocated: an allocation event applies or takes off, only one of the two');
  }
  return [
    { key: 'applied', amount: applied, subledgers: [customer] },
    { key: 'unapplied', amount: unapplied, subledgers: [customer] },
  ];
}

/**
 * `pay.ChequeCleared` (ADR-0003, ADR-0064): a cheque awaiting clearance (1130) cleared into the bank account it was
 * paid into (1100, against that account's own party).
 */
export function chequeClearedAmounts(payload: { readonly amountPesewas: number }, bankAccount: SubledgerRef): PostingAmount[] {
  return [{ key: 'cheque', amount: Money.fromJsonInteger(payload.amountPesewas), subledgers: [bankAccount] }];
}

/**
 * `pay.ProviderSettled` (ADR-0003, ADR-0065): the provider paid out the payments a settlement report matched: the net
 * into the bank account it paid into (1100, against that account's party), its fee to 6910, the gross off the
 * provider's clearing account (1120, against the provider). Net and fee sum to the gross, or nothing posts.
 */
export function providerSettledAmounts(
  payload: { readonly provider: string; readonly grossPesewas: number; readonly feePesewas: number; readonly netPesewas: number },
  bankAccount: SubledgerRef,
): PostingAmount[] {
  const gross = Money.fromJsonInteger(payload.grossPesewas);
  const fee = Money.fromJsonInteger(payload.feePesewas);
  const net = Money.fromJsonInteger(payload.netPesewas);
  if (!net.plus(fee).equals(gross)) {
    throw new Error(`pay.ProviderSettled: net ${net.pesewas} and fee ${fee.pesewas} do not sum to the gross ${gross.pesewas}`);
  }
  return [
    { key: 'net', amount: net, subledgers: [bankAccount] },
    { key: 'fee', amount: fee },
    { key: 'gross', amount: gross, subledgers: [providerParty(payload.provider)] },
  ];
}

/**
 * `pay.UnidentifiedReceiptHeld` (FR-PAY-010, FR-PAY-017, ADR-0065): money that reached the bank from a payer nobody can
 * name, approved by a second person: what was banked (the line less any provider fee) into 1100 against the bank
 * account, the fee to 6910, the whole held in 2290 Suspense until the payer is found. Never revenue.
 */
export function unidentifiedReceiptAmounts(payload: { readonly amountPesewas: number; readonly feePesewas: number }, bankAccount: SubledgerRef): PostingAmount[] {
  const held = Money.fromJsonInteger(payload.amountPesewas);
  const fee = Money.fromJsonInteger(payload.feePesewas);
  if (fee.compareTo(held) > 0) throw new Error(`pay.UnidentifiedReceiptHeld: the fee ${fee.pesewas} is more than the amount ${held.pesewas}`);
  return [
    { key: 'banked', amount: held.minus(fee), subledgers: [bankAccount] },
    { key: 'fee', amount: fee },
    { key: 'held', amount: held },
  ];
}

/**
 * `pay.RefundPaid` (ADR-0003, A-210): the refund paid out of the customer's deposit (Dr 2200 against the customer) to
 * the original payment's tender account by its method's kind (against its till or its provider). A refund to store credit
 * names the tender `STORE_CREDIT` (2210, against the customer, ADR-0064). A refund against a credit note is paid out of
 * receivables instead (`creditRefund`: Dr 1200 against the customer, the money the credit note left owed to them,
 * ADR-0003's "1200 or 2200"). A cheque goes back through a bank payout: the tender `BANK_TRANSFER` (1100) against the
 * bank account the cheque was paid into (ADR-0066).
 */
export function refundPaidAmounts(
  payload: {
    readonly amountPesewas: number;
    readonly methodKind: string;
    readonly register: { readonly id: string; readonly code: string } | null;
    readonly provider: string | null;
    readonly creditNoteId?: string | null;
  },
  customer: SubledgerRef,
  bankAccount: SubledgerRef | null = null,
): PostingAmount[] {
  return [
    {
      key: payload.creditNoteId === undefined || payload.creditNoteId === null ? 'refund' : 'creditRefund',
      amount: Money.fromJsonInteger(payload.amountPesewas),
      determinants: { PAYMENT_METHOD_KIND: payload.methodKind },
      subledgers: [customer, ...(bankAccount === null ? tenderParties(payload.register, payload.provider) : [bankAccount])],
    },
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
