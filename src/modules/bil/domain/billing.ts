import { halfUpDivide, Money, type Quantity } from '@hakorem/kernel';

/** The five billing documents (bil.md). A RECEIPT is the document of a sale paid at once and posts as an invoice. */
export type BillingKind = 'PROFORMA' | 'INVOICE' | 'RECEIPT' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
export type LineKind = 'PRODUCT' | 'DELIVERY_FEE' | 'ADJUSTMENT';

/** A rule a billing request breaks: the field (a JSON pointer) and the rule's code. */
export interface BrokenRule {
  readonly field: string | null;
  readonly rule: string;
}

/** The figures a line is priced by: the agreed unit price, what the engine or quote resolved, the quantity, the discount. */
export interface LinePricing {
  readonly unitPrice: Money;
  readonly resolvedUnitPrice: Money;
  readonly quantity: Quantity;
  readonly discount: Money;
}

/**
 * The line's one rounded figure (ADR-0001): `half_up(unit price × quantity)` less its discount. It is the net of a
 * tax-exclusive line and the gross of a tax-inclusive one; the tax calculator derives everything else from it. Null
 * when the discount is larger than the extended price.
 */
export function lineAnchor(line: LinePricing): Money | null {
  const extended = line.unitPrice.timesQuantity(line.quantity);
  return line.discount.compareTo(extended) > 0 ? null : extended.minus(line.discount);
}

/**
 * What the line would have cost at the resolved price less what was agreed, both extended once (ADR-0003, 4210):
 * above zero the agreed price was below the resolved one (a debit to 4210), below zero it was above (a credit).
 */
export function priceVariance(line: LinePricing): bigint {
  return line.resolvedUnitPrice.timesQuantity(line.quantity).pesewas - line.unitPrice.timesQuantity(line.quantity).pesewas;
}

export interface LineFigures {
  readonly net: Money;
  readonly tax: Money;
  readonly gross: Money;
}

/** A document's totals: sums of its line integers, never recomputed from another total (ADR-0001). */
export function documentTotals(lines: readonly LineFigures[]): LineFigures {
  return {
    net: Money.sum(lines.map((l) => l.net)),
    tax: Money.sum(lines.map((l) => l.tax)),
    gross: Money.sum(lines.map((l) => l.gross)),
  };
}

export interface LevyRow {
  readonly levyCode: string;
  readonly levyName: string;
  readonly calcOrder: number;
  readonly amount: Money;
}

function byCalcOrder(a: { readonly calcOrder: number; readonly levyCode: string }, b: { readonly calcOrder: number; readonly levyCode: string }): number {
  if (a.calcOrder !== b.calcOrder) return a.calcOrder < b.calcOrder ? -1 : 1;
  return a.levyCode.localeCompare(b.levyCode);
}

/** The document's total per levy, in calculation order, every levy listed even at zero (FR-BIL-004, ADR-0020). */
export function levyTotals(rows: readonly LevyRow[]): { readonly levyCode: string; readonly levyName: string; readonly amount: Money }[] {
  const totals = new Map<string, { levyCode: string; levyName: string; calcOrder: number; amount: Money }>();
  for (const row of rows) {
    const seen = totals.get(row.levyCode);
    totals.set(row.levyCode, seen === undefined ? { ...row } : { ...seen, amount: seen.amount.plus(row.amount) });
  }
  return [...totals.values()].sort(byCalcOrder).map(({ levyCode, levyName, amount }) => ({ levyCode, levyName, amount }));
}

/** The fiscal year of a business date (`YYYY-MM-DD`, Africa/Accra): the calendar year (ADR-0015, A-028). */
export function fiscalYearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/**
 * The series lock a command names in `seriesLocks` before it issues a document of this kind (ADR-0005, ADR-0015), the
 * same shape as the journal's: `<DOC TYPE>:<YEAR>:<BRANCH>`, with the register for a receipt that has one.
 */
export function seriesLockKey(kind: BillingKind, branchId: string, issueDate: string, register?: string): string {
  return `${kind}:${fiscalYearOf(issueDate)}:${branchId}${register === undefined ? '' : `:${register}`}`;
}

/** The rules of a new invoice, receipt or proforma that need no database (FR-BIL-006). */
export function checkIssue(request: {
  readonly kind: BillingKind;
  readonly customerId: string | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly lineCount: number;
}): BrokenRule[] {
  const broken: BrokenRule[] = [];
  if (!['PROFORMA', 'INVOICE', 'RECEIPT'].includes(request.kind)) broken.push({ field: '/kind', rule: 'KIND_NOT_ISSUABLE' });
  if (request.lineCount === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
  if (request.kind === 'INVOICE' && request.customerId === null) broken.push({ field: '/customerId', rule: 'CUSTOMER_REQUIRED' });
  if (request.dueDate !== null) {
    if (request.kind === 'RECEIPT') broken.push({ field: '/dueDate', rule: 'RECEIPT_HAS_NO_DUE_DATE' });
    else if (request.dueDate < request.issueDate) broken.push({ field: '/dueDate', rule: 'DUE_BEFORE_ISSUE' });
  }
  return broken;
}

/** One line of an issued invoice or receipt, as a credit note sees it. */
export interface CreditableLine {
  readonly id: string;
  readonly pricing: LinePricing;
  /** The line's anchor as issued: its net if the document is tax-exclusive, its gross if inclusive. */
  readonly anchor: Money;
  /** What issued credit notes already took off this line, in the same terms. */
  readonly creditedAnchor: Money;
}

export interface CreditLineInput {
  readonly lineId: string;
  readonly quantity?: Quantity | undefined;
  readonly amount?: Money | undefined;
}

/** A credit note line as priced: its quantity and figures, its anchor and what it credits. */
export interface CreditLinePlan {
  readonly lineId: string;
  readonly pricing: LinePricing;
  readonly anchor: Money;
}

/**
 * The lines of a credit note (FR-BIL-007). Each names a line of the original once, with a quantity or an amount:
 * a quantity credits `half_up(unit price × quantity)` less the same share of the line's discount, an amount credits
 * itself; either way never more than the line has left uncredited. The amount is in the original's terms (net when it
 * was tax-exclusive, gross when inclusive), so the levies are recomputed from it by the calculator.
 */
export function planCreditLines(original: readonly CreditableLine[], inputs: readonly CreditLineInput[]): { readonly plans: CreditLinePlan[]; readonly broken: BrokenRule[] } {
  const broken: BrokenRule[] = [];
  const plans: CreditLinePlan[] = [];
  if (inputs.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
  const byId = new Map(original.map((line) => [line.id, line] as const));
  const seen = new Set<string>();
  inputs.forEach((input, i) => {
    const field = `/lines/${i}`;
    const line = byId.get(input.lineId);
    if (line === undefined) {
      broken.push({ field: `${field}/lineId`, rule: 'LINE_NOT_ON_ORIGINAL' });
      return;
    }
    if (seen.has(input.lineId)) {
      broken.push({ field: `${field}/lineId`, rule: 'LINE_REPEATED' });
      return;
    }
    seen.add(input.lineId);
    if ((input.quantity === undefined) === (input.amount === undefined)) {
      broken.push({ field, rule: 'QUANTITY_OR_AMOUNT' });
      return;
    }
    let pricing: LinePricing;
    let anchor: Money;
    if (input.quantity !== undefined) {
      const q = input.quantity;
      if (q.isZero() || q.isNegative() || q.compareTo(line.pricing.quantity) > 0) {
        broken.push({ field: `${field}/quantity`, rule: 'QUANTITY_EXCEEDS_LINE' });
        return;
      }
      const discount = Money.ofPesewas(halfUpDivide(line.pricing.discount.pesewas * q.thousandths, line.pricing.quantity.thousandths));
      pricing = { ...line.pricing, quantity: q, discount };
      anchor = lineAnchor(pricing)!;
    } else {
      anchor = input.amount!;
      if (anchor.isZero() || anchor.compareTo(line.anchor) > 0) {
        broken.push({ field: `${field}/amountPesewas`, rule: 'AMOUNT_EXCEEDS_LINE' });
        return;
      }
      // An amount credit keeps the line's quantity and price; the discount is what makes its anchor the amount.
      const extended = line.pricing.unitPrice.timesQuantity(line.pricing.quantity);
      pricing = { ...line.pricing, discount: extended.minus(anchor) };
    }
    if (line.creditedAnchor.plus(anchor).compareTo(line.anchor) > 0) {
      broken.push({ field, rule: 'LINE_ALREADY_CREDITED' });
      return;
    }
    plans.push({ lineId: line.id, pricing, anchor });
  });
  return { plans, broken };
}

/** A reason a credit or debit note may carry: a credit note a REFUND or RETURN reason, a debit note a BILLING_ADJUSTMENT one. */
export function noteReasonRule(kind: 'CREDIT_NOTE' | 'DEBIT_NOTE', reason: { readonly domain: string; readonly requiresNote: boolean } | undefined, note: string | null): BrokenRule[] {
  if (reason === undefined) return [{ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' }];
  const domains = kind === 'CREDIT_NOTE' ? ['REFUND', 'RETURN'] : ['BILLING_ADJUSTMENT'];
  if (!domains.includes(reason.domain)) return [{ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' }];
  if (reason.requiresNote && (note === null || note.trim() === '')) return [{ field: '/note', rule: 'NOTE_REQUIRED' }];
  return [];
}

/** Whether a document may be corrected by a credit or debit note: an issued invoice or receipt (FR-BIL-007). */
export function correctable(original: { readonly kind: BillingKind; readonly status: 'DRAFT' | 'ISSUED' }): boolean {
  return original.status === 'ISSUED' && (original.kind === 'INVOICE' || original.kind === 'RECEIPT');
}

/**
 * What a refund may still draw on (ADR-0066). On an invoice or receipt, what it owes back to the customer once credited
 * beyond what it had outstanding. On an issued credit note, its amount less the refunds held against it, never more than
 * its original owes back (null: the original is unknown, so nothing). Nothing on any other document.
 */
export function creditRefundableOf(
  document: { readonly kind: string; readonly issued: boolean; readonly grossPesewas: bigint; readonly refundedPesewas: bigint; readonly refundablePesewas: bigint },
  originalOwesBackPesewas: bigint | null,
): bigint {
  if (document.kind !== 'CREDIT_NOTE') return document.refundablePesewas;
  if (!document.issued || originalOwesBackPesewas === null) return 0n;
  const left = document.grossPesewas - document.refundedPesewas;
  return left < originalOwesBackPesewas ? left : originalOwesBackPesewas;
}
