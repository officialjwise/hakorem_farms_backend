import type { Transaction } from '../../../platform/database/unit-of-work';
import type { OrderStatus } from '../domain/order';

export const ORDER_STORE = Symbol('ORDER_STORE');

export type PriceBasis = 'PER_HEAD' | 'PER_KG' | 'PER_UNIT';
export type WeightSource = 'SCALE' | 'MANUAL' | 'ESTIMATE';

export interface OrderHeaderRecord {
  readonly id: string;
  readonly orderNo: string | null;
  readonly channel: 'POS' | 'ONLINE' | 'WHOLESALE' | 'QUOTE';
  readonly customerId: string | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly status: OrderStatus;
  readonly paymentTerms: 'IMMEDIATE' | 'PREPAID' | 'COD' | 'CREDIT';
  readonly fulfilmentMode: 'COUNTER' | 'COLLECTION' | 'DELIVERY';
  readonly sourceDocumentId: string | null;
  readonly shiftDocumentId: string | null;
  readonly salespersonId: string | null;
  readonly taxInclusive: boolean;
  readonly deliveryFeePesewas: bigint;
  readonly estimatedTotalPesewas: bigint;
  readonly maximumTotalPesewas: bigint;
  readonly finalTotalPesewas: bigint | null;
  readonly billingDocumentId: string | null;
  readonly isOffline: boolean;
  readonly placedAt: Date;
  readonly completedAt: Date | null;
  readonly recordedAt: Date;
  readonly notes: string | null;
  readonly branchId: string;
  readonly version: number;
  /** Read only: written by the confirmation, fulfilment (B11) and backorders. `delivery_id` arrives with B11's expand migration. */
  readonly parentOrderId: string | null;
  readonly creditCheck: 'PASSED' | 'OVERRIDDEN' | 'NOT_REQUIRED' | null;
  readonly deliveryAddressSnapshot: unknown;
  readonly deliveryZoneId: string | null;
  /** Who wrote the order: for a counter sale, the cashier who posted it (a void's approver is never this person). */
  readonly createdBy: string;
  /** The order's proforma (issueProforma, A-201), once issued; never replaced. */
  readonly proformaDocumentId: string | null;
}

export interface OrderLineRecord {
  readonly id: string;
  readonly salesOrderId: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly qtyOrdered: string;
  readonly uom: string;
  readonly qtyFulfilled: string;
  readonly fulfilledWeightKg: string | null;
  readonly weightSource: WeightSource | null;
  readonly priceSource: 'ENGINE' | 'QUOTE' | 'MANUAL_APPROVED';
  readonly priceBasis: PriceBasis;
  readonly priceListEntryId: string | null;
  readonly resolvedUnitPricePesewas: bigint;
  readonly floorUnitPricePesewas: bigint;
  readonly ceilingUnitPricePesewas: bigint;
  readonly agreedUnitPricePesewas: bigint;
  readonly variancePesewas: bigint;
  readonly varianceDirection: 'BELOW' | 'ABOVE' | null;
  readonly varianceReasonCode: string | null;
  readonly varianceRequiresApproval: boolean;
  readonly discountPesewas: bigint;
  readonly estimatedLineTotalPesewas: bigint;
  readonly finalLineTotalPesewas: bigint | null;
  readonly reservationId: string | null;
  readonly stockMovementId: string | null;
  readonly stockExceptionId: string | null;
  /** Read only until catch weight (B11), quotes (B10) and override approvals (B09a continued 2c). */
  readonly estimatedWeightKg: string | null;
  readonly tolerancePercent: string | null;
  readonly qtyBackordered: string;
  readonly quoteLineRef: string | null;
  /** The PRICE_OVERRIDE approval a flagged line waits for or holds, and who approved it and when (A-230). */
  readonly varianceApprovalRequestId: string | null;
  readonly varianceApprovedBy: string | null;
  readonly varianceApprovedAt: Date | null;
  readonly lineStatus: 'OPEN' | 'FULFILLED' | 'PARTIAL' | 'BACKORDERED' | 'SUBSTITUTED' | 'CANCELLED' | 'RETURNED';
}

export interface OrderRecord extends OrderHeaderRecord {
  readonly lines: readonly OrderLineRecord[];
}

export interface StatusChangeRecord {
  readonly id: string;
  readonly fromStatus: OrderStatus | null;
  readonly toStatus: OrderStatus;
  readonly reason: string | null;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly actorId: string;
}

type ReadOnlyHeader = 'parentOrderId' | 'creditCheck' | 'deliveryAddressSnapshot' | 'deliveryZoneId' | 'createdBy' | 'proformaDocumentId';
type ReadOnlyLine = 'stockExceptionId' | 'estimatedWeightKg' | 'tolerancePercent' | 'qtyBackordered' | 'quoteLineRef';

export interface NewOrder extends Omit<OrderHeaderRecord, 'status' | 'finalTotalPesewas' | 'billingDocumentId' | 'completedAt' | 'recordedAt' | 'version' | 'orderNo' | ReadOnlyHeader> {
  readonly orderNo: string;
  readonly actorId: string;
  /** An online order's delivery as the checkout took it (A-232); null for every other order. */
  readonly deliveryAddressSnapshot?: unknown;
  readonly deliveryZoneId?: string | null;
}

/** A line as written: open, or (a sale fulfilled at once) fulfilled with its movement. */
export type NewOrderLine = Omit<OrderLineRecord, ReadOnlyLine> & {
  /** A catch-weight line's estimate at order time (ADR-0021): packs times the nominal pack, and the product's tolerance. */
  readonly estimatedWeightKg?: string | null;
  readonly tolerancePercent?: string | null;
};

/** One void asked for of a completed sale (`ord.order_void`, migration 0194). */
export interface OrderVoidRecord {
  readonly id: string;
  readonly salesOrderId: string;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  readonly approvalRequestId: string;
  readonly creditNoteId: string | null;
  readonly decidedBy: string | null;
  readonly branchId: string;
  readonly createdBy: string;
}

/** ORD's own tables (schema `ord`). The status history is inserted only. */
/** One tracking link's token, as stored: its hash only (ADR-0074). */
export interface TrackingTokenRecord {
  readonly id: string;
  readonly salesOrderId: string;
  readonly tokenHash: Buffer;
  readonly recordedAt: Date;
  readonly expiresAt: Date;
  readonly actorId: string;
}

/** What a till shift sold (FR-POS-017): completed sales, voids and price given away below list, in pesewas. */
export interface ShiftSalesSummary {
  readonly salesCount: number;
  readonly grossSalesPesewas: bigint;
  readonly voidsCount: number;
  readonly voidsPesewas: bigint;
  readonly overridesCount: number;
  readonly overridesPesewas: bigint;
}

export interface OrderStore {
  /** The summary of the sales a till shift took. */
  shiftSales(tx: Transaction, shiftDocumentId: string): Promise<ShiftSalesSummary>;
  insertOrder(tx: Transaction, order: NewOrder): Promise<void>;
  insertTrackingToken(tx: Transaction, token: TrackingTokenRecord): Promise<void>;
  /** The token stored under this hash that has not expired at `at`, by the unique hash (a point read). */
  trackingToken(tx: Transaction, tokenHash: Buffer, at: Date): Promise<{ readonly salesOrderId: string; readonly tokenHash: Buffer } | null>;
  insertLines(tx: Transaction, lines: readonly NewOrderLine[]): Promise<void>;
  recordStatus(tx: Transaction, orderId: string, change: Omit<StatusChangeRecord, 'recordedAt'>): Promise<void>;
  complete(
    tx: Transaction,
    orderId: string,
    completion: { readonly billingDocumentId: string; readonly finalTotalPesewas: bigint; readonly completedAt: Date; readonly actorId: string },
  ): Promise<void>;
  orders(tx: Transaction, ids: readonly string[]): Promise<OrderRecord[]>;
  history(tx: Transaction, orderId: string): Promise<StatusChangeRecord[]>;
  /** The order under its row lock (a confirmation, a cancellation), or null. */
  lock(tx: Transaction, orderId: string): Promise<OrderHeaderRecord | null>;
  /** PLACED to CONFIRMED with the check's result; the history row is the caller's. */
  confirm(tx: Transaction, orderId: string, c: { readonly creditCheck: 'PASSED' | 'NOT_REQUIRED'; readonly at: Date; readonly actorId: string }): Promise<void>;
  /** The one reservation that holds an open line, when one does. */
  holdLine(tx: Transaction, lineId: string, reservationId: string): Promise<void>;
  /** PLACED or CONFIRMED to CANCELLED with its reason, every open line cancelled; the history row is the caller's. */
  cancel(tx: Transaction, orderId: string, c: { readonly reasonCode: string; readonly at: Date; readonly actorId: string }): Promise<void>;
  /** COMPLETED to VOIDED with its approval, the supervisor who approved it and when. */
  markVoided(tx: Transaction, orderId: string, v: { readonly approvalRequestId: string; readonly voidedBy: string; readonly at: Date }): Promise<void>;
  insertVoid(tx: Transaction, v: Omit<OrderVoidRecord, 'status' | 'creditNoteId' | 'decidedBy'>): Promise<void>;
  /** The void that is not rejected (waiting or approved), under its row lock, or null. */
  openVoidOf(tx: Transaction, orderId: string): Promise<OrderVoidRecord | null>;
  voidByApproval(tx: Transaction, approvalRequestId: string): Promise<OrderVoidRecord | null>;
  decideVoid(tx: Transaction, id: string, d: { readonly status: 'APPROVED' | 'REJECTED'; readonly creditNoteId: string | null; readonly decidedBy: string; readonly at: Date }): Promise<void>;
  /** Every flagged line waiting for the approval named: approved by whom and when (PRICE_OVERRIDE, A-230). */
  approveVariances(tx: Transaction, orderId: string, a: { readonly approvalRequestId: string; readonly approvedBy: string; readonly at: Date }): Promise<void>;
  /** The order's proforma, written once. */
  setProforma(tx: Transaction, orderId: string, p: { readonly documentId: string; readonly at: Date; readonly actorId: string }): Promise<void>;
  /** Ids of the orders matching the filter at the branches given, newest first, before `beforeId`, at most `limit`. */
  list(tx: Transaction, filter: OrderFilter, beforeId: string | null, limit: number): Promise<string[]>;
  /** Ids of one customer's orders at every branch, newest first, before `beforeId`, at most `limit` (listMyOrders). */
  ofCustomer(tx: Transaction, customerId: string, beforeId: string | null, limit: number): Promise<string[]>;
  /** The ONLINE order placed from a checkout (its source document), under its row lock, or null. */
  lockOnlineBySource(tx: Transaction, sourceDocumentId: string): Promise<OrderHeaderRecord | null>;
}

export interface OrderFilter {
  readonly branchIds: readonly string[];
  readonly channel: OrderHeaderRecord['channel'] | null;
  readonly status: OrderStatus | null;
  readonly customerId: string | null;
  readonly shiftId: string | null;
  readonly salespersonId: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
  /** The start of an order number, or part of a guest's name. */
  readonly q: string | null;
}
