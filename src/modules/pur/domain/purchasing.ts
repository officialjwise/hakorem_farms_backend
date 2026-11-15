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
  };
}

/**
 * A payment's allocations (FR-PUR-010, FR-PUR-012): each to an approved invoice of the payment's supplier that passed
 * the three-way match (or needed none), never more than it has left unpromised. The payment's amount is their sum.
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
    } else if (invoice.matchStatus !== 'MATCHED' && invoice.matchStatus !== 'NOT_REQUIRED') {
      broken.push({ index, rule: 'THREE_WAY_MATCH_FAILED' });
    } else if (invoice.status !== 'APPROVED') {
      broken.push({ index, rule: 'NOT_APPROVED' });
    } else if (invoice.promisedPesewas + allocation.amount.pesewas > invoice.grossPesewas) {
      broken.push({ index, rule: 'EXCEEDS_OUTSTANDING' });
    }
    seen.add(allocation.invoiceId);
  });
  return broken.length > 0 ? err(broken) : ok(Money.sum(allocations.map((a) => a.amount)));
}
