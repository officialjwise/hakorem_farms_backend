import type { Transaction } from '../../../platform/database/unit-of-work';
import type { SubmittedOrder } from '../domain/order-splitting';
import type { OrderStatus } from '../domain/purchasing';
import type { MatchReason, MatchStatus } from '../domain/three-way-match';

/** What a list may reach: the branches (and, for a location grant, the location) the reader's grants name. */
export interface ReadScope {
  readonly branchId: string;
  readonly locationId: string | null;
}

export interface OrderLineRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly description: string | null;
  readonly uom: string;
  readonly qtyOrdered: string;
  readonly qtyOrderedBase: string;
  readonly unitPricePesewas: bigint;
  readonly lineNetPesewas: bigint;
  readonly taxCategoryId: string;
  readonly taxPesewas: bigint;
  readonly qtyReceived: string;
  readonly tolerancePercent: string;
  readonly expenseCategory: string | null;
}

export interface OrderHeader {
  readonly supplierId: string;
  readonly deliverToLocationId: string;
  readonly orderDate: string;
  readonly expectedOn: string | null;
  readonly taxInclusive: boolean;
  readonly taxSchemeVersionId: string;
  readonly netPesewas: bigint;
  readonly taxPesewas: bigint;
  readonly grossPesewas: bigint;
  readonly branchId: string;
}

export interface OrderRecord extends OrderHeader {
  readonly id: string;
  readonly orderNo: string | null;
  readonly status: OrderStatus;
  readonly approvalThresholdPesewas: bigint | null;
  readonly approvalRequestId: string | null;
  readonly sentAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly lines: readonly OrderLineRecord[];
}

export interface OrderFilter {
  readonly status?: OrderStatus | undefined;
  readonly supplierId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface LevyRecord {
  readonly levyId: string;
  readonly levyCode: string;
  readonly levyName: string;
  readonly treatment: string;
  readonly ratePercent: string;
  readonly basePesewas: bigint;
  readonly amountPesewas: bigint;
  readonly calculatedAmountPesewas: bigint;
  readonly isReclaimable: boolean;
  readonly calcOrder: number;
}

export interface InvoiceLineRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string | null;
  readonly description: string;
  readonly purchaseOrderLineId: string | null;
  readonly goodsReceiptLineId: string | null;
  readonly uom: string | null;
  readonly qty: string;
  readonly qtyBase: string | null;
  readonly unitPricePesewas: bigint;
  readonly lineNetPesewas: bigint;
  readonly taxCategoryId: string;
  readonly expenseCategory: string | null;
  readonly qtyVariance: string | null;
  readonly priceVariancePesewas: bigint | null;
  readonly priceVarianceDirection: 'OVER' | 'UNDER' | null;
  readonly matchStatus: MatchStatus;
  readonly matchReasons: readonly MatchReason[];
  readonly levies: readonly LevyRecord[];
}

export type InvoiceStatus = 'DRAFT' | 'MATCHED' | 'MISMATCH' | 'APPROVED' | 'PAID' | 'CANCELLED';

export interface InvoiceHeader {
  readonly supplierInvoiceNo: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly fileId: string | null;
  readonly taxSchemeVersionId: string;
  readonly netPesewas: bigint;
  readonly taxPesewas: bigint;
  readonly grossPesewas: bigint;
  readonly statedGrossPesewas: bigint | null;
}

export interface InvoiceRecord extends InvoiceHeader {
  readonly id: string;
  readonly kind: 'INVOICE' | 'CREDIT_NOTE';
  readonly status: InvoiceStatus;
  readonly supplierId: string;
  readonly purchaseOrderId: string | null;
  readonly originalInvoiceId: string | null;
  readonly paidPesewas: bigint;
  readonly matchStatus: MatchStatus;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly lines: readonly InvoiceLineRecord[];
}

export interface InvoiceFilter {
  readonly status?: InvoiceStatus | undefined;
  readonly supplierId?: string | undefined;
  readonly matchStatus?: MatchStatus | undefined;
  readonly dueBefore?: string | undefined;
  readonly outstandingOnly: boolean;
}

export interface LineMatchRecord {
  readonly lineId: string;
  readonly matchStatus: Exclude<MatchStatus, 'UNMATCHED'>;
  readonly reasons: readonly MatchReason[];
  readonly qtyVariance: string | null;
  readonly priceVariancePesewas: bigint | null;
  readonly priceVarianceDirection: 'OVER' | 'UNDER' | null;
}

export type PaymentStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'PAID' | 'REJECTED' | 'CANCELLED';
export type PaymentMethod = 'BANK' | 'MOBILE_MONEY' | 'CASH' | 'CHEQUE';

export interface PaymentRecord {
  readonly id: string;
  readonly paymentNo: string | null;
  readonly status: PaymentStatus;
  readonly supplierId: string;
  readonly method: PaymentMethod;
  readonly amountPesewas: bigint;
  readonly scheduledFor: string | null;
  readonly paidAt: Date | null;
  readonly externalReference: string | null;
  readonly approvalRequestId: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  /** The approved payout details the payment pays, fixed when it was prepared (FR-PUR-002); null for cash and cheques. */
  readonly payoutChangeId: string | null;
  /** The first payment prepared for the supplier since its payout details changed, as the database decided (A-170). */
  readonly payoutFirstUse: boolean;
  readonly payeeMasked: string | null;
  readonly allocations: readonly { readonly supplierInvoiceId: string; readonly supplierInvoiceNo: string; readonly amountPesewas: bigint }[];
}

export interface PaymentHeader {
  readonly supplierId: string;
  readonly method: PaymentMethod;
  readonly amountPesewas: bigint;
  readonly scheduledFor: string | null;
  readonly branchId: string;
  readonly payoutChangeId: string | null;
}

export interface PaymentFilter {
  readonly status?: PaymentStatus | undefined;
  readonly supplierId?: string | undefined;
  readonly scheduledBefore?: string | undefined;
}

export const PURCHASING_STORE = Symbol('PURCHASING_STORE');

/** PUR's own tables (migration 0094), always in the caller's transaction. */
export interface PurchasingStore {
  // Purchase orders.
  insertOrder(tx: Transaction, id: string, header: OrderHeader, lines: readonly OrderLineRecord[], actorId: string): Promise<void>;
  replaceOrder(tx: Transaction, id: string, header: OrderHeader, lines: readonly OrderLineRecord[], actorId: string): Promise<void>;
  order(tx: Transaction, id: string): Promise<OrderRecord | null>;
  /** The order, its row locked for a change. */
  lockOrder(tx: Transaction, id: string): Promise<OrderRecord | null>;
  orders(tx: Transaction, ids: readonly string[]): Promise<OrderRecord[]>;
  listOrders(tx: Transaction, filter: OrderFilter, scopes: readonly ReadScope[], beforeId: string | null, limit: number): Promise<OrderRecord[]>;
  /** The order lines by id, each with its order's id, locked for a receipt. */
  lockOrderLines(tx: Transaction, ids: readonly string[]): Promise<(OrderLineRecord & { readonly purchaseOrderId: string })[]>;
  setReceived(tx: Transaction, lineId: string, qtyReceived: string): Promise<void>;
  markOrderJudged(
    tx: Transaction,
    id: string,
    judged: { readonly status: 'PENDING_APPROVAL' | 'APPROVED'; readonly thresholdPesewas: bigint; readonly approvalRequestId: string | null; readonly at: Date },
    actorId: string,
  ): Promise<void>;
  /** An order's approval decided: APPROVED, or back to DRAFT with its judgement cleared when refused or withdrawn. */
  markOrderDecided(tx: Transaction, id: string, status: 'APPROVED' | 'DRAFT', at: Date, actorId: string): Promise<void>;
  markOrderSent(tx: Transaction, id: string, at: Date, actorId: string): Promise<void>;
  markOrderReceived(tx: Transaction, id: string, status: 'PARTIALLY_RECEIVED' | 'RECEIVED', actorId: string): Promise<void>;
  markOrderEnded(tx: Transaction, id: string, status: 'CLOSED' | 'CANCELLED', reason: string, actorId: string): Promise<void>;
  /** Per order line, the base quantity live invoices (MATCHED, APPROVED, PAID) hold against it, leaving one invoice out. */
  invoicedQty(tx: Transaction, orderLineIds: readonly string[], exceptInvoiceId: string | null): Promise<ReadonlyMap<string, string>>;

  // Supplier invoices.
  insertInvoice(
    tx: Transaction,
    id: string,
    header: InvoiceHeader & { readonly kind: 'INVOICE'; readonly supplierId: string; readonly purchaseOrderId: string | null; readonly branchId: string },
    lines: readonly InvoiceLineRecord[],
    actorId: string,
  ): Promise<void>;
  replaceInvoice(tx: Transaction, id: string, header: InvoiceHeader, lines: readonly InvoiceLineRecord[], actorId: string): Promise<void>;
  invoice(tx: Transaction, id: string): Promise<InvoiceRecord | null>;
  lockInvoice(tx: Transaction, id: string): Promise<InvoiceRecord | null>;
  invoices(tx: Transaction, ids: readonly string[]): Promise<InvoiceRecord[]>;
  listInvoices(tx: Transaction, filter: InvoiceFilter, branches: readonly string[], beforeId: string | null, limit: number): Promise<InvoiceRecord[]>;
  supplierInvoiceNoTaken(tx: Transaction, supplierId: string, supplierInvoiceNo: string, exceptId: string | null): Promise<boolean>;
  recordMatch(tx: Transaction, id: string, lines: readonly LineMatchRecord[], matchStatus: Exclude<MatchStatus, 'UNMATCHED'>, at: Date, actorId: string): Promise<void>;
  markInvoiceApproved(tx: Transaction, id: string, at: Date, actorId: string): Promise<void>;
  markInvoiceCancelled(tx: Transaction, id: string, reason: string, actorId: string): Promise<void>;
  /** Per invoice, what live payments (not REJECTED or CANCELLED) allocate to it. */
  promised(tx: Transaction, invoiceIds: readonly string[]): Promise<ReadonlyMap<string, bigint>>;

  // Supplier payments.
  /** Orders judged against the approval limit and submitted between two instants, for the order splitting rule. */
  submittedOrders(tx: Transaction, from: Date, to: Date): Promise<SubmittedOrder[]>;
  insertPayment(
    tx: Transaction,
    id: string,
    header: PaymentHeader,
    allocations: readonly { readonly id: string; readonly supplierInvoiceId: string; readonly amountPesewas: bigint }[],
    actorId: string,
  ): Promise<void>;
  payment(tx: Transaction, id: string): Promise<PaymentRecord | null>;
  lockPayment(tx: Transaction, id: string): Promise<PaymentRecord | null>;
  listPayments(tx: Transaction, filter: PaymentFilter, branches: readonly string[], beforeId: string | null, limit: number): Promise<PaymentRecord[]>;
  markPaymentPending(tx: Transaction, id: string, approvalRequestId: string, actorId: string): Promise<void>;
  markPaymentDecided(tx: Transaction, id: string, status: 'APPROVED' | 'REJECTED' | 'CANCELLED', reason: string | null, actorId: string): Promise<void>;
  markPaymentPaid(tx: Transaction, id: string, paidAt: Date, externalReference: string, at: Date, actorId: string): Promise<void>;
}
