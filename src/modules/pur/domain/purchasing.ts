import { err, Money, ok, Quantity, type Rate, type Result } from '@hakorem/kernel';

/**
 * Purchase orders and supplier payments (FR-PUR-005 to FR-PUR-007, FR-PUR-010, FR-PUR-012). Pure: amounts are integer
 * pesewas, quantities exact thousandths; the database holds the same rules on its own rows (migration 0094).
 */
export type OrderStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'SENT' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED' | 'CANCELLED';
export type OrderAction = 'UPDATE' | 'SUBMIT' | 'SEND' | 'CLOSE' | 'CANCEL';
export type OrderRefusal = 'WRONG_STATUS' | 'RECEIVED_ALREADY' | 'NOTHING_RECEIVED';

/** A purchase line's anchor (ADR-0001): the unit price times the quantity, rounded half-up once. */
export function orderLineNet(unitPrice: Money, qty: Quantity): Money {
  return unitPrice.timesQuantity(qty);
}

export interface ReceivingLine {
  readonly qtyOrderedBase: Quantity;
  readonly qtyReceived: Quantity;
  readonly tolerance: Rate;
}

/** What a receipt of `qty` makes the line's received quantity, or a refusal past ordered plus tolerance. */
export function judgeReceipt(line: ReceivingLine, qty: Quantity): Result<Quantity, 'OVER_RECEIPT'> {
  const received = line.qtyReceived.plus(qty);
  const ceiling = line.qtyOrderedBase.thousandths * (line.tolerance.denominator + line.tolerance.numerator);
  return received.thousandths * line.tolerance.denominator <= ceiling ? ok(received) : err('OVER_RECEIPT');
}

/** Ordered less received, never below nothing (a receipt within tolerance can pass the ordered quantity). */
export function outstanding(line: Pick<ReceivingLine, 'qtyOrderedBase' | 'qtyReceived'>): Quantity {
  const left = line.qtyOrderedBase.minus(line.qtyReceived);
  return left.isNegative() ? Quantity.zero() : left;
}

/** An order with something received: RECEIVED once every line has its ordered quantity. */
export function receivedStatus(lines: readonly Pick<ReceivingLine, 'qtyOrderedBase' | 'qtyReceived'>[]): 'PARTIALLY_RECEIVED' | 'RECEIVED' {
  return lines.every((line) => outstanding(line).isZero()) ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
}

const ACTION_FROM: Readonly<Record<OrderAction, { readonly from: readonly OrderStatus[]; readonly to: OrderStatus }>> = {
  UPDATE: { from: ['DRAFT'], to: 'DRAFT' },
  SUBMIT: { from: ['DRAFT'], to: 'DRAFT' },
  SEND: { from: ['APPROVED'], to: 'SENT' },
  CLOSE: { from: ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'], to: 'CLOSED' },
  CANCEL: { from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED'], to: 'CANCELLED' },
};

/**
 * Whether an action may happen to an order in a status, and the status it leads to (SUBMIT's own outcome is decided
 * by the approval limit). An order is cancelled only before anything is received and closed only after (FR-PUR-006).
 */
export function judgeOrderAction(status: OrderStatus, action: OrderAction, anyReceived: boolean): Result<OrderStatus, OrderRefusal> {
  const rule = ACTION_FROM[action];
  if (!rule.from.includes(status)) return err('WRONG_STATUS');
  if (action === 'CANCEL' && anyReceived) return err('RECEIVED_ALREADY');
  if (action === 'CLOSE' && !anyReceived) return err('NOTHING_RECEIVED');
  return ok(rule.to);
}

export type AllocationRule = 'NO_ALLOCATIONS' | 'OTHER_SUPPLIER' | 'DUPLICATE_INVOICE' | 'NOT_APPROVED' | 'THREE_WAY_MATCH_FAILED' | 'EXCEEDS_OUTSTANDING';

export interface AllocationFacts {
  readonly invoiceId: string;
  readonly amount: Money;
  readonly invoice: {
    readonly supplierId: string;
    readonly kind: 'INVOICE' | 'CREDIT_NOTE';
    readonly status: string;
    readonly matchStatus: string;
    readonly grossPesewas: bigint;
    /** What live payments (not rejected or cancelled) already allocate to it. */
    readonly promisedPesewas: bigint;
    /** The gross of the credit notes against it that are not cancelled (FR-PUR-011): a waiting credit already counts. */
    readonly liveCreditsPesewas: bigint;
  };
}

/** The match results an invoice is paid on: matched, needing no match, or a mismatch a second person approved. */
export const PAYABLE_MATCH: ReadonlySet<string> = new Set(['MATCHED', 'NOT_REQUIRED', 'VARIANCE_APPROVED']);

/**
 * A payment's allocations (FR-PUR-010 to FR-PUR-012): each to an approved invoice of the payment's supplier that passed
 * the three-way match (or needed none, or had its variance approved), never more than it has left unpromised and
 * uncredited. The payment's amount is their sum.
 */
export function judgeAllocations(supplierId: string, allocations: readonly AllocationFacts[]): Result<Money, { readonly index: number; readonly rule: AllocationRule }[]> {
  if (allocations.length === 0) return err([{ index: -1, rule: 'NO_ALLOCATIONS' }]);
  const broken: { index: number; rule: AllocationRule }[] = [];
  const seen = new Set<string>();
  allocations.forEach((allocation, index) => {
    const { invoice } = allocation;
    if (seen.has(allocation.invoiceId)) {
      broken.push({ index, rule: 'DUPLICATE_INVOICE' });
    } else if (invoice.supplierId !== supplierId || invoice.kind !== 'INVOICE') {
      broken.push({ index, rule: 'OTHER_SUPPLIER' });
    } else if (!PAYABLE_MATCH.has(invoice.matchStatus)) {
      broken.push({ index, rule: 'THREE_WAY_MATCH_FAILED' });
    } else if (invoice.status !== 'APPROVED') {
      broken.push({ index, rule: 'NOT_APPROVED' });
    } else if (invoice.promisedPesewas + invoice.liveCreditsPesewas + allocation.amount.pesewas > invoice.grossPesewas) {
      broken.push({ index, rule: 'EXCEEDS_OUTSTANDING' });
    }
    seen.add(allocation.invoiceId);
  });
  return broken.length > 0 ? err(broken) : ok(Money.sum(allocations.map((a) => a.amount)));
}

/**
 * Whether an order's gross needs a second person under the approval limit in force (owner, 2026-11-15: a setting):
 * only above the limit. The threshold the order keeps, which `ck_purchase_order_approved` holds, is the limit plus one.
 */
export function orderLimitJudgement(grossPesewas: bigint, limitPesewas: bigint): { readonly required: boolean; readonly thresholdPesewas: bigint } {
  return { required: grossPesewas > limitPesewas, thresholdPesewas: limitPesewas + 1n };
}

export type PaymentApprovalReason = 'FIRST_PAYMENT_AFTER_PAYOUT_CHANGE' | 'PAYMENT_POLICY';

/**
 * Why a supplier payment waits for a second person (owner, 2026-11-15): the first payment to a supplier after its
 * payout details changed always does, whatever the amount; any other follows the `SUPPLIER_PAYMENT` policy.
 */
export function paymentApprovalReason(firstAfterPayoutChange: boolean, policyRequires: boolean): PaymentApprovalReason | null {
  if (firstAfterPayoutChange) return 'FIRST_PAYMENT_AFTER_PAYOUT_CHANGE';
  return policyRequires ? 'PAYMENT_POLICY' : null;
}

/**
 * Who may approve the first payment to a supplier after its payout details changed (owner, 2026-11-15, A-171): anyone
 * with the approver permission except the person who made that change. They may still prepare it; the change's
 * approver is not barred. `changeMakerId` is null for a payment that is not the first after a change.
 */
export function judgeFirstPaymentApprover(facts: { readonly changeMakerId: string | null; readonly approverId: string }): Result<void, 'PAYOUT_MAKER_CANNOT_APPROVE'> {
  return facts.changeMakerId !== null && facts.changeMakerId === facts.approverId ? err('PAYOUT_MAKER_CANNOT_APPROVE') : ok(undefined);
}
