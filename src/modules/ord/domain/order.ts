import { err, Money, ok, type Result } from '@hakorem/kernel';

/** The thirteen statuses of the one order machine (DOMAIN_MODEL section 7, FR-ORD-002). */
export const ORDER_STATUSES = [
  'PLACED',
  'CONFIRMED',
  'PICKING',
  'AWAITING_CUSTOMER',
  'PACKED',
  'READY_FOR_COLLECTION',
  'DISPATCHED',
  'DELIVERED',
  'DELIVERY_FAILED',
  'RETURNED',
  'COMPLETED',
  'CANCELLED',
  'VOIDED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Every edge of the machine; the database's `ord.sales_order_guard` holds the same list. */
const EDGES: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PLACED: ['CONFIRMED', 'COMPLETED', 'CANCELLED'],
  CONFIRMED: ['PICKING', 'CANCELLED'],
  PICKING: ['AWAITING_CUSTOMER', 'PACKED', 'CANCELLED'],
  AWAITING_CUSTOMER: ['PICKING', 'CANCELLED'],
  PACKED: ['READY_FOR_COLLECTION', 'DISPATCHED'],
  READY_FOR_COLLECTION: ['COMPLETED'],
  DISPATCHED: ['DELIVERED', 'DELIVERY_FAILED'],
  DELIVERY_FAILED: ['DISPATCHED', 'RETURNED'],
  DELIVERED: ['COMPLETED'],
  RETURNED: ['CANCELLED'],
  COMPLETED: ['VOIDED'],
  CANCELLED: [],
  VOIDED: [],
};

export function canMove(from: OrderStatus, to: OrderStatus): boolean {
  return EDGES[from].includes(to);
}

export type TenderRefusal = 'TENDER_SHORT' | 'TENDER_OVER';

/**
 * A sale on immediate terms (FR-ORD-006): its tenders settle the billing document's gross exactly, so nothing is left
 * owing and nothing is held over; change for cash handed over is the till's concern, not the payment's (B9b).
 */
export function judgeTenders(gross: Money, tenders: readonly Money[]): Result<Money, TenderRefusal> {
  const total = Money.sum(tenders);
  const order = total.compareTo(gross);
  if (order < 0) return err('TENDER_SHORT');
  if (order > 0) return err('TENDER_OVER');
  return ok(total);
}

export type PaymentStatus = 'UNPAID' | 'DEPOSIT_HELD' | 'PART_PAID' | 'PAID' | 'PART_REFUNDED' | 'REFUNDED';

export interface PaymentFigures {
  /** What the order's billing document asks for (gross less credits); null before it is issued. */
  readonly documentDue: Money | null;
  /** What payments have applied to that document. */
  readonly allocated: Money;
  /** What payments taken for the order hold unallocated. */
  readonly deposits: Money;
  /** Everything the order's payments received. */
  readonly paid: Money;
  /** Everything refunded of them. */
  readonly refunded: Money;
}

/** FR-ORD-016: the payment status beside the order status, derived and never set by hand. */
export function paymentStatusOf(f: PaymentFigures): PaymentStatus {
  if (!f.refunded.isZero()) {
    return f.refunded.compareTo(f.paid) >= 0 ? 'REFUNDED' : 'PART_REFUNDED';
  }
  if (f.documentDue === null) {
    return f.deposits.isZero() ? 'UNPAID' : 'DEPOSIT_HELD';
  }
  if (f.allocated.compareTo(f.documentDue) >= 0) return 'PAID';
  return f.allocated.isZero() && f.deposits.isZero() ? 'UNPAID' : 'PART_PAID';
}
