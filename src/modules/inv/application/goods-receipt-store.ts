import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ReceiptKind } from '../domain/goods-receipt';
import type { WeightSource } from './stock-store';

export const GOODS_RECEIPT_STORE = Symbol('GOODS_RECEIPT_STORE');

export type ReceiptStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';
export type AnimalSex = 'MALE' | 'FEMALE' | 'UNKNOWN';
export type AnimalPurpose = 'GROWING' | 'BREEDING';

export interface AnimalRecord {
  readonly id: string;
  readonly seqNo: number;
  readonly tagNo: string;
  readonly sex: AnimalSex;
  readonly breed: string | null;
  readonly weightKg: string | null;
  readonly weightSource: WeightSource | null;
  readonly dateOfBirth: string | null;
  readonly purpose: AnimalPurpose;
  readonly stockUnitId: string | null;
}

export interface ReceiptLineRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly orderLineRef: string | null;
  /** Both in the product's base unit: what stock, the cost pool and the purchase order's match read. */
  readonly qtyReceived: string;
  readonly qtyRejected: string;
  /** The unit the line was entered in when it is not the base unit (a crate), with its quantities as entered; else null. */
  readonly uom: string | null;
  readonly qtyReceivedUom: string | null;
  readonly qtyRejectedUom: string | null;
  /** The GOODS_RECEIPT_REJECTION reason of a rejected quantity and its note (migration 0221); null when nothing was rejected. */
  readonly rejectionReasonCode: string | null;
  readonly rejectionNote: string | null;
  readonly weightKg: string | null;
  readonly weightSource: WeightSource | null;
  readonly valuePesewas: bigint;
  readonly stockUnitId: string | null;
  readonly batchNo: string | null;
  readonly expiresOn: string | null;
  readonly animals: readonly AnimalRecord[];
}

export interface ReceiptHeader {
  readonly kind: ReceiptKind;
  readonly supplierId: string | null;
  readonly locationId: string;
  readonly orderDocumentId: string | null;
  readonly deliveryNoteRef: string | null;
  readonly receivedAt: Date;
  readonly notes: string | null;
  readonly branchId: string;
}

export interface ReceiptRecord extends ReceiptHeader {
  readonly id: string;
  readonly receiptNo: string | null;
  readonly status: ReceiptStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly postedAt: Date | null;
  readonly postedBy: string | null;
  readonly lines: readonly ReceiptLineRecord[];
}

/** A stock unit as a receipt creates it: ACTIVE, with no location until its first movement (migration 0044). */
export interface NewStockUnit {
  readonly id: string;
  readonly productId: string;
  readonly tracking: 'SERIAL' | 'LOT';
  readonly branchId: string;
  readonly identifier: string;
  readonly producedOn: string | null;
  readonly expiresOn: string | null;
  readonly storageTempClass: string | null;
  readonly supplierId: string | null;
  readonly sourceDocumentId: string;
  readonly lastWeightKg: string | null;
  readonly lastWeighedAt: Date | null;
  /**
   * The goods receipt's received_at, kept on the unit: what oldest first orders by after expiry (B09e continued); null
   * for a unit no receipt brings in (a processing output, an animal born on the farm).
   */
  readonly receivedAt: Date | null;
}

export interface ReceiptFilters {
  readonly status?: ReceiptStatus | undefined;
  readonly supplierId?: string | undefined;
  readonly purchaseOrderId?: string | undefined;
  /** Calendar dates in Africa/Accra, both inclusive. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** Where a list may look: the branches, and within a branch the locations, the reader's grants reach. */
export interface ReadScope {
  readonly branchId: string;
  readonly locationId: string | null;
}

export interface GoodsReceiptStore {
  insertHeader(tx: Transaction, id: string, header: ReceiptHeader, actorId: string): Promise<void>;
  updateHeader(tx: Transaction, id: string, version: number, set: Record<string, unknown>, actorId: string): Promise<boolean>;
  /** Locks the receipt row and returns its state, or null. */
  lock(tx: Transaction, id: string): Promise<{ readonly status: ReceiptStatus; readonly version: number } | null>;
  clearLines(tx: Transaction, id: string): Promise<void>;
  insertLine(tx: Transaction, receiptId: string, line: Omit<ReceiptLineRecord, 'stockUnitId' | 'animals'>): Promise<void>;
  insertAnimal(tx: Transaction, lineId: string, animal: Omit<AnimalRecord, 'stockUnitId'>): Promise<void>;
  receipt(tx: Transaction, id: string): Promise<ReceiptRecord | null>;
  receipts(tx: Transaction, filters: ReceiptFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<ReceiptRecord[]>;
  /** Whether the product has ever had a balance in the branch, at any of its locations: it has stock history there. */
  hasStockHistory(tx: Transaction, productId: string, branchId: string): Promise<boolean>;
  /** Which of these identifiers an ACTIVE stock unit of the product already carries. */
  activeIdentifiers(tx: Transaction, productId: string, identifiers: readonly string[]): Promise<string[]>;
  insertStockUnit(tx: Transaction, unit: NewStockUnit, actorId: string): Promise<void>;
  setLineUnit(tx: Transaction, lineId: string, unitId: string): Promise<void>;
  setAnimalUnit(tx: Transaction, animalId: string, unitId: string): Promise<void>;
  markPosted(tx: Transaction, id: string, at: Date, actorId: string): Promise<void>;
  markCancelled(tx: Transaction, id: string, reason: string, actorId: string): Promise<void>;
  /** Stock units by id, as the contract's `StockUnitRef`. */
  unitRefs(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' }>>;
}
