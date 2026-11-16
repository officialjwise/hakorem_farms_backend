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

export interface NewOrder extends Omit<OrderHeaderRecord, 'status' | 'finalTotalPesewas' | 'billingDocumentId' | 'completedAt' | 'recordedAt' | 'version' | 'orderNo'> {
  readonly orderNo: string;
  readonly actorId: string;
}

/** A line as written: open, or (a sale fulfilled at once) fulfilled with its movement. */
export type NewOrderLine = Omit<OrderLineRecord, 'stockExceptionId'>;

/** ORD's own tables (schema `ord`). The status history is inserted only. */
export interface OrderStore {
  insertOrder(tx: Transaction, order: NewOrder): Promise<void>;
  insertLines(tx: Transaction, lines: readonly NewOrderLine[]): Promise<void>;
  recordStatus(tx: Transaction, orderId: string, change: Omit<StatusChangeRecord, 'recordedAt'>): Promise<void>;
  complete(tx: Transaction, orderId: string, completion: { readonly billingDocumentId: string; readonly finalTotalPesewas: bigint; readonly completedAt: Date; readonly actorId: string }): Promise<void>;
  orders(tx: Transaction, ids: readonly string[]): Promise<OrderRecord[]>;
  history(tx: Transaction, orderId: string): Promise<StatusChangeRecord[]>;
}
