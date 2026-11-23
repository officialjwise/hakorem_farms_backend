import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DeliveryStatus } from '../domain/deliveries';

export const DELIVERY_STORE = Symbol('DELIVERY_STORE');

/** One line of what a delivery carries, as dispatch summarised it for the driver and the delivery note (CR-055 point 1). */
export interface ContentsLine {
  readonly orderLineId: string;
  readonly name: string;
  readonly quantity: string;
  readonly uom: string;
  readonly weightKg: string | null;
}

export interface DeliveryRecord {
  readonly id: string;
  readonly deliveryNo: string;
  readonly orderDocumentId: string;
  readonly billingDocumentId: string;
  readonly customerId: string | null;
  readonly slotId: string | null;
  readonly deliveryZoneId: string;
  readonly recipientName: string;
  readonly recipientPhoneE164: string;
  readonly addressSnapshot: Readonly<Record<string, unknown>>;
  readonly contents: readonly ContentsLine[];
  readonly driverId: string | null;
  readonly vehicleLocationId: string | null;
  readonly codDuePesewas: bigint;
  readonly codCollectedPesewas: bigint | null;
  readonly attemptCount: number;
  readonly dispatchedAt: Date;
  readonly deliveredAt: Date | null;
  readonly deliveryNoteDocumentId: string | null;
  readonly status: DeliveryStatus;
  readonly branchId: string;
  readonly version: number;
}

export type NewDelivery = Omit<DeliveryRecord, 'codCollectedPesewas' | 'attemptCount' | 'deliveredAt' | 'deliveryNoteDocumentId' | 'version'> & { readonly actorId: string };

export interface ProofRecord {
  readonly id: string;
  readonly deliveryId: string;
  readonly recipientName: string;
  readonly signatureFileId: string | null;
  readonly photoFileId: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly positionAccuracyM: number | null;
  readonly codCollectedPesewas: bigint;
  readonly codVarianceReasonCode: string | null;
  readonly codVarianceNote: string | null;
  readonly paymentId: string | null;
  readonly capturedAt: Date;
  readonly createdBy: string;
}

export interface AttemptRecord {
  readonly id: string;
  readonly deliveryId: string;
  readonly attemptNo: number;
  readonly outcome: 'DELIVERED' | 'FAILED';
  readonly failureReasonCode: string | null;
  readonly nextAction: 'REATTEMPT' | 'RETURN_TO_STOCK' | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly occurredAt: Date;
  readonly actorId: string;
}

export interface DeliveryFilter {
  readonly branchIds: readonly string[];
  readonly status: DeliveryStatus | null;
  readonly driverId: string | null;
  readonly orderId: string | null;
  readonly zoneId: string | null;
  /** Dispatched on this Africa/Accra calendar date (UTC+0 all year, A-028). */
  readonly date: string | null;
}

/** How a delivery's goods were written off the van (migration 0322). */
export interface WriteOffFacts {
  readonly reasonCode: string;
  readonly valuePesewas: bigint;
  readonly stockAdjustmentId: string;
}

export interface WrittenOffRecord extends WriteOffFacts {
  readonly deliveryId: string;
  readonly deliveryNo: string;
  readonly orderDocumentId: string;
  readonly driverId: string | null;
  readonly vehicleLocationId: string | null;
  readonly routeId: string | null;
  readonly writtenOffAt: Date;
  readonly branchId: string;
}

export interface WrittenOffFilter {
  readonly branchIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly driverId: string | null;
  /** Written off on these Africa/Accra calendar dates, both included (UTC+0 all year, A-028). */
  readonly from: string | null;
  readonly to: string | null;
}

/** DEL's deliveries, attempts and proofs (migration 0303). The attempts and proofs are inserted only. */
export interface DeliveryStore {
  insert(tx: Transaction, d: NewDelivery): Promise<void>;
  deliveries(tx: Transaction, ids: readonly string[]): Promise<DeliveryRecord[]>;
  /** The delivery under its row lock, or null. */
  lock(tx: Transaction, id: string): Promise<DeliveryRecord | null>;
  /** The order's delivery that is not cancelled, or null. */
  liveOfOrder(tx: Transaction, orderDocumentId: string): Promise<DeliveryRecord | null>;
  /** Ids matching the filter at the branches given, newest first, before `beforeId`, at most `limit`. */
  list(tx: Transaction, f: DeliveryFilter, beforeId: string | null, limit: number): Promise<string[]>;
  proofsOf(tx: Transaction, deliveryIds: readonly string[]): Promise<ProofRecord[]>;
  proofById(tx: Transaction, id: string): Promise<ProofRecord | null>;
  insertAttempt(tx: Transaction, a: AttemptRecord): Promise<void>;
  insertProof(tx: Transaction, p: ProofRecord): Promise<void>;
  /** ASSIGNED or OUT_FOR_DELIVERY to DELIVERED with the cash collected; one more attempt. */
  markDelivered(tx: Transaction, id: string, d: { readonly collectedPesewas: bigint; readonly at: Date; readonly actorId: string }): Promise<void>;
  /** ASSIGNED to OUT_FOR_DELIVERY, its time recorded (FR-DEL-007). */
  markOnTheWay(tx: Transaction, id: string, d: { readonly at: Date; readonly actorId: string }): Promise<void>;
  /** To FAILED, one attempt more (FR-DEL-011). */
  markFailed(tx: Transaction, id: string, d: { readonly at: Date; readonly actorId: string }): Promise<void>;
  attemptById(tx: Transaction, id: string): Promise<AttemptRecord | null>;
  /** FAILED to RETURNED, posted: the goods came off the van into the returns hold (FR-DEL-011). */
  markReturned(tx: Transaction, id: string, d: { readonly at: Date; readonly actorId: string }): Promise<void>;
  /** FAILED to WRITTEN_OFF, posted, with its reason, its value at cost and the stock adjustment that took the goods. */
  markWrittenOff(tx: Transaction, id: string, d: WriteOffFacts & { readonly at: Date; readonly actorId: string }): Promise<void>;
  /** Deliveries written off with one of these reasons at the branches given, newest first, before `beforeId`, at most `limit`. */
  writtenOff(tx: Transaction, f: WrittenOffFilter, beforeId: string | null, limit: number): Promise<WrittenOffRecord[]>;
  /** The status of the route the delivery sits on; null when it is on none. */
  routeStatusOf(tx: Transaction, deliveryId: string): Promise<'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | null>;
}
