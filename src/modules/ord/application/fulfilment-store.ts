import type { Transaction } from '../../../platform/database/unit-of-work';
import type { OrderStatus } from '../domain/order';
import type { PickWeightSource } from '../domain/picking';

export const FULFILMENT_STORE = Symbol('FULFILMENT_STORE');

export type FulfilmentStatus = 'PICK_LIST' | 'PICKING' | 'PACKED' | 'DISPATCHED' | 'COLLECTED' | 'CANCELLED';

/** `ord.fulfilment`: a pick list of all or part of an order at one pick location (migration 0294). */
export interface FulfilmentHeaderRecord {
  readonly id: string;
  readonly fulfilmentNo: string;
  readonly salesOrderId: string;
  readonly pickLocationId: string;
  readonly status: FulfilmentStatus;
  readonly pickerId: string | null;
  readonly pickedAt: Date | null;
  readonly packedAt: Date | null;
  readonly dispatchedAt: Date | null;
  readonly packageCount: number | null;
  readonly cancelReason: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdBy: string;
}

/** `ord.pick_list_line`: what a pick list asks of one order line. */
export interface PickListLineRecord {
  readonly id: string;
  readonly fulfilmentId: string;
  readonly salesOrderLineId: string;
  readonly lineNo: number;
  readonly qtyToPick: string;
  readonly status: 'OPEN' | 'CANCELLED';
}

/** `ord.fulfilment_line`: one pick, its client id the key. */
export interface PickRecord {
  readonly id: string;
  readonly fulfilmentId: string;
  readonly pickListLineId: string;
  readonly salesOrderLineId: string;
  readonly stockUnitId: string | null;
  readonly packBarcode: string | null;
  /** In the order line's unit (packs of a catch-weight line). */
  readonly qty: string;
  /** In the product's base unit: the weighed kilograms of a catch-weight pick. */
  readonly qtyBase: string;
  readonly weightKg: string | null;
  readonly weightSource: PickWeightSource | null;
  readonly withdrawnAt: Date | null;
  readonly recordedAt: Date;
  readonly createdBy: string;
}

export interface FulfilmentRecord extends FulfilmentHeaderRecord {
  readonly pickList: readonly PickListLineRecord[];
  readonly picks: readonly PickRecord[];
}

export type ConsentKind = 'HIGHER_TOTAL' | 'SUBSTITUTION' | 'SHORT_PICK';
export type ConsentStatus = 'PENDING' | 'ACCEPTED' | 'REFUSED' | 'WITHDRAWN';
export type ConsentMethod = 'PHONE' | 'IN_PERSON' | 'WHATSAPP' | 'SIGNED_LINK' | 'CUSTOMER_ACCOUNT' | 'SYSTEM';

/** `ord.order_consent`: what an order asks its customer, and the answer. */
export interface OrderConsentRecord {
  readonly id: string;
  readonly salesOrderId: string;
  readonly salesOrderLineId: string;
  readonly kind: ConsentKind;
  readonly status: ConsentStatus;
  readonly proposedProductId: string | null;
  readonly proposedStockUnitId: string | null;
  readonly proposedQty: string | null;
  readonly proposedUom: string | null;
  readonly priceListEntryId: string | null;
  readonly priceBasis: 'PER_HEAD' | 'PER_UNIT' | null;
  readonly resolvedUnitPricePesewas: bigint | null;
  readonly floorUnitPricePesewas: bigint | null;
  readonly ceilingUnitPricePesewas: bigint | null;
  readonly proposedLineTotalPesewas: bigint | null;
  readonly weighedWeightKg: string | null;
  readonly weighedTotalPesewas: bigint | null;
  readonly note: string | null;
  readonly askedAt: Date;
  readonly answeredBy: string | null;
  readonly answeredAt: Date | null;
  readonly method: ConsentMethod | null;
  readonly answerNote: string | null;
  readonly substituteLineId: string | null;
  readonly branchId: string;
  readonly createdBy: string;
}

export type NewConsent = Omit<OrderConsentRecord, 'status' | 'answeredBy' | 'answeredAt' | 'method' | 'answerNote' | 'substituteLineId'>;

export interface FulfilmentFilter {
  readonly branchIds: readonly string[];
  readonly orderId: string | null;
  readonly status: FulfilmentStatus | null;
  readonly pickLocationId: string | null;
  /** The Africa/Accra day the pick list was made: [from, to). */
  readonly from: Date | null;
  readonly to: Date | null;
}

/** The figures a line's picks come to, written on the order line while it is picked (fixed at dispatch). */
export interface LinePicked {
  readonly qtyPicked: string;
  readonly weightKg: string | null;
  readonly weightSource: PickWeightSource | null;
  readonly finalLineTotalPesewas: bigint | null;
}

/** ORD's fulfilment tables (schema `ord`): pick lists, picks and the customer's answers. Nothing is ever deleted. */
export interface FulfilmentStore {
  insertFulfilment(tx: Transaction, f: Omit<FulfilmentHeaderRecord, 'status' | 'pickerId' | 'pickedAt' | 'packedAt' | 'dispatchedAt' | 'packageCount' | 'cancelReason' | 'version'>): Promise<void>;
  insertPickListLines(tx: Transaction, lines: readonly PickListLineRecord[], actorId: string): Promise<void>;
  /** Pick lists with their lines and picks (withdrawn ones too), in the order of the ids given. */
  fulfilments(tx: Transaction, ids: readonly string[]): Promise<FulfilmentRecord[]>;
  /** The pick list under its row lock, or null. */
  lock(tx: Transaction, id: string): Promise<FulfilmentHeaderRecord | null>;
  /** Ids of the order's pick lists, oldest first. */
  ofOrders(tx: Transaction, orderIds: readonly string[]): Promise<Array<{ readonly id: string; readonly salesOrderId: string; readonly fulfilmentNo: string; readonly status: FulfilmentStatus }>>;
  /** Ids of the pick lists matching the filter, newest first, before `beforeId`, at most `limit`. */
  list(tx: Transaction, filter: FulfilmentFilter, beforeId: string | null, limit: number): Promise<string[]>;
  /** PICK_LIST to PICKING, naming who picks and when the first pick was recorded. */
  startPicking(tx: Transaction, id: string, s: { readonly pickerId: string; readonly at: Date }): Promise<void>;
  pack(tx: Transaction, id: string, p: { readonly packageCount: number; readonly at: Date; readonly actorId: string }): Promise<void>;
  cancel(tx: Transaction, id: string, c: { readonly reason: string; readonly at: Date; readonly actorId: string }): Promise<void>;
  cancelPickListLines(tx: Transaction, ids: readonly string[], at: Date, actorId: string): Promise<void>;
  /** The stored picks of these client ids, whatever pick list they are on. */
  picksById(tx: Transaction, ids: readonly string[]): Promise<PickRecord[]>;
  insertPicks(tx: Transaction, picks: readonly PickRecord[]): Promise<void>;
  withdrawPicks(tx: Transaction, ids: readonly string[], at: Date, actorId: string): Promise<void>;
  /** Every pick not withdrawn of the order, on pick lists not cancelled (all of its fulfilments). */
  activePicksOfOrder(tx: Transaction, orderId: string): Promise<PickRecord[]>;
  /** What open lines of pick lists not cancelled ask of each order line, summed. */
  askedOf(tx: Transaction, orderLineIds: readonly string[]): Promise<Map<string, string>>;
  setLinePicked(tx: Transaction, lineId: string, picked: LinePicked): Promise<void>;
  setLineStatus(tx: Transaction, lineId: string, status: 'CANCELLED' | 'SUBSTITUTED'): Promise<void>;
  /** A substitute line names the line it replaces (`substituted_for_line_id`), once, as it is written. */
  setSubstitutedFor(tx: Transaction, lineId: string, originalLineId: string): Promise<void>;
  /** Every pick list of the order not packed, dispatched, collected or cancelled, cancelled with its reason (a cancelled order). */
  cancelOpenOfOrder(tx: Transaction, orderId: string, c: { readonly reason: string; readonly at: Date; readonly actorId: string }): Promise<string[]>;
  /** The order moved along its machine (the caller has judged the edge and writes the history row). */
  moveOrder(tx: Transaction, orderId: string, to: OrderStatus, at: Date, actorId: string): Promise<void>;
  insertConsent(tx: Transaction, c: NewConsent): Promise<void>;
  /** The order's question waiting for an answer, under its row lock, or null. */
  pendingConsent(tx: Transaction, orderId: string): Promise<OrderConsentRecord | null>;
  consentsOf(tx: Transaction, orderIds: readonly string[]): Promise<OrderConsentRecord[]>;
  answerConsent(tx: Transaction, id: string, a: { readonly status: 'ACCEPTED' | 'REFUSED' | 'WITHDRAWN'; readonly answeredBy: string; readonly at: Date; readonly method: ConsentMethod; readonly note: string | null }): Promise<void>;
  setSubstituteLine(tx: Transaction, consentId: string, lineId: string, at: Date, actorId: string): Promise<void>;
}
