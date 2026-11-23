import type { Transaction } from '../../../platform/database/unit-of-work';
import type { WayOut } from '../domain/van-return';

export const VAN_RETURN_STORE = Symbol('VAN_RETURN_STORE');

export type VanReturnStatus = 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED';
export type VanRefundDestination = 'ORIGINAL_METHOD' | 'STORE_CREDIT';

/** `ord.delivery_return` (migration 0323): one way a failed delivery's goods left the van other than by delivery. */
export interface VanReturnRecord {
  readonly id: string;
  readonly deliveryId: string;
  readonly salesOrderId: string;
  readonly originalBillingDocumentId: string;
  readonly wayOut: WayOut;
  readonly returnsLocationId: string | null;
  readonly reasonCode: string | null;
  readonly stockAdjustmentId: string | null;
  readonly note: string | null;
  readonly refundDestination: VanRefundDestination;
  readonly status: VanReturnStatus;
  readonly creditNoteId: string | null;
  readonly refundId: string | null;
  readonly branchId: string;
  readonly createdBy: string;
}

export type NewVanReturn = Omit<VanReturnRecord, 'status' | 'creditNoteId' | 'refundId'> & { readonly at: Date };

/** ORD's record of the van's other ways out. Nothing is deleted; the guard decides what may change. */
export interface VanReturnStore {
  /** Written PENDING_APPROVAL (a write-off waiting for its stock approval). */
  insertPending(tx: Transaction, r: NewVanReturn): Promise<void>;
  /** Written POSTED with the credit note of the delivery's document. */
  insertPosted(tx: Transaction, r: NewVanReturn & { readonly creditNoteId: string }): Promise<void>;
  /** PENDING_APPROVAL to POSTED with its credit note, by whoever let the write-off post. */
  post(tx: Transaction, id: string, p: { readonly creditNoteId: string; readonly at: Date; readonly actorId: string }): Promise<void>;
  /** PENDING_APPROVAL to REJECTED: the write-off was refused, the goods are still on the van. */
  reject(tx: Transaction, id: string, p: { readonly at: Date; readonly actorId: string }): Promise<void>;
  /** The refund asked for against its credit note, once. */
  setRefund(tx: Transaction, id: string, p: { readonly refundId: string; readonly at: Date; readonly actorId: string }): Promise<void>;
  /** The delivery's way out that was not refused, under its row lock, or null. */
  liveOfDelivery(tx: Transaction, deliveryId: string): Promise<VanReturnRecord | null>;
  /** The way out a stock adjustment was drafted for, under its row lock, or null. */
  ofAdjustment(tx: Transaction, stockAdjustmentId: string): Promise<VanReturnRecord | null>;
  /** The way out a credit note was drafted for, under its row lock, or null. */
  ofCreditNote(tx: Transaction, creditNoteId: string): Promise<VanReturnRecord | null>;
}
