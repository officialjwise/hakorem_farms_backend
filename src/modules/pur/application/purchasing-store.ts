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
  /** On a credit note, where goods sent back to the supplier leave from, and the lot or animal (FR-PUR-011). */
  readonly returnLocationId: string | null;
  readonly returnStockUnitId: string | null;
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
  /** A credit note's reason for goods sent back (a RETURN reason code); null otherwise. */
  readonly returnReasonCode: string | null;
}

/** An invoice's match result, or a credit note's (never matched), with the variance a second person approved. */
export type InvoiceMatchStatus = MatchStatus | 'VARIANCE_APPROVED';

export interface InvoiceRecord extends InvoiceHeader {
  readonly id: string;
  readonly kind: 'INVOICE' | 'CREDIT_NOTE';
  readonly status: InvoiceStatus;
  readonly supplierId: string;
  readonly purchaseOrderId: string | null;
  readonly originalInvoiceId: string | null;
  readonly paidPesewas: bigint;
  /** The gross of the approved credit notes against this invoice (FR-PUR-011). */
  readonly creditedPesewas: bigint;
  readonly matchStatus: InvoiceMatchStatus;
  /** A credit note's approval, or an invoice's variance approval, waiting or decided (A-172). */
  readonly approvalRequestId: string | null;
  readonly varianceReason: string | null;
  readonly postedBy: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly lines: readonly InvoiceLineRecord[];
}

export interface InvoiceFilter {
  readonly status?: InvoiceStatus | undefined;
  readonly kind?: 'INVOICE' | 'CREDIT_NOTE' | undefined;
  readonly supplierId?: string | undefined;
  readonly matchStatus?: InvoiceMatchStatus | undefined;
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
  /** The approved payout change a first payment follows; its maker may not approve the payment (A-171). */
  readonly payoutFirstUseChangeId: string | null;
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

/** A paid payment's remittance advice data, fixed when it was marked paid (FR-PUR-013). */
export interface RemittanceRecord {
  readonly id: string;
  readonly supplierPaymentId: string;
  readonly supplierId: string;
  readonly method: PaymentMethod;
  readonly payeeMasked: string | null;
  readonly amountPesewas: bigint;
  readonly paidAt: Date;
  readonly externalReference: string;
  readonly branchId: string;
  readonly recordedAt: Date;
  readonly lines: readonly {
    readonly supplierInvoiceId: string;
    readonly supplierInvoiceNo: string;
    readonly invoiceDate: string;
    readonly grossPesewas: bigint;
    readonly creditedPesewas: bigint;
    readonly amountPesewas: bigint;
    readonly outstandingAfterPesewas: bigint;
  }[];
}

/** One goods receipt line from a supplier, as the score reads it (FR-PUR-014). */
export interface ReceiptFact {
  readonly goodsReceiptLineId: string;
  readonly goodsReceiptId: string;
  readonly supplierId: string;
  readonly purchaseOrderId: string | null;
  readonly productId: string;
  readonly receivedOn: string;
  readonly promisedOn: string | null;
  readonly qtyAccepted: string;
  readonly qtyRejected: string;
  readonly branchId: string;
}

/** What a period's scores are computed from, every supplier at once; quantities in base thousandths. */
export interface ScoreFacts {
  readonly receipts: readonly Pick<ReceiptFact, 'supplierId' | 'purchaseOrderId' | 'receivedOn' | 'promisedOn' | 'qtyAccepted' | 'qtyRejected'>[];
  /** Approved and paid invoice lines with a product, by supplier and product. */
  readonly priced: readonly { readonly supplierId: string; readonly productId: string; readonly netPesewas: bigint; readonly qtyBase: string }[];
  /** Base quantities sent back on approved credit notes, by supplier. */
  readonly returned: readonly { readonly supplierId: string; readonly qtyBase: string }[];
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
    header: InvoiceHeader & {
      readonly kind: 'INVOICE' | 'CREDIT_NOTE';
      readonly supplierId: string;
      readonly purchaseOrderId: string | null;
      readonly originalInvoiceId: string | null;
      readonly branchId: string;
    },
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
  /** Per invoice, the gross of the credit notes against it that are not CANCELLED (FR-PUR-011). */
  liveCredits(tx: Transaction, invoiceIds: readonly string[]): Promise<ReadonlyMap<string, bigint>>;
  /** A credit note's approval or an invoice's variance asked for: it waits, frozen (A-172). */
  markInvoicePending(tx: Transaction, id: string, approvalRequestId: string, varianceReason: string | null, actorId: string): Promise<void>;
  /** The approval refused or withdrawn: the document may be corrected again. */
  clearInvoicePending(tx: Transaction, id: string, actorId: string): Promise<void>;
  /** A credit note approved, needing no match; the database adds it to its invoice's credited amount. */
  markCreditApproved(tx: Transaction, id: string, at: Date, approverId: string): Promise<void>;
  /** A mismatched invoice approved for payment on its approved variance (FR-PUR-010). */
  markVarianceApproved(tx: Transaction, id: string, at: Date, approverId: string): Promise<void>;

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

  // Remittance advice data (FR-PUR-013).
  insertRemittance(tx: Transaction, record: Omit<RemittanceRecord, 'recordedAt'>, actorId: string): Promise<void>;
  remittance(tx: Transaction, supplierPaymentId: string): Promise<RemittanceRecord | null>;

  // Supplier score facts (FR-PUR-014).
  insertReceiptFacts(tx: Transaction, facts: readonly ReceiptFact[], actorId: string): Promise<void>;
  /** The supplier's expected lead time in days from its profile, or null when none is set. */
  supplierLeadTimeDays(tx: Transaction, supplierId: string): Promise<number | null>;
  /** Every supplier's facts for the days `from` to `to` inclusive (business dates, Africa/Accra). */
  scoreFacts(tx: Transaction, from: string, to: string): Promise<ScoreFacts>;
}
