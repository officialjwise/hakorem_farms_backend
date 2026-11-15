import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AdjustmentDirection } from '../domain/stock-documents';
import type { ResolutionKind } from '../domain/stock-exception';
import type { CostElement, WeightSource } from './stock-store';

export const STOCK_DOCUMENTS_STORE = Symbol('STOCK_DOCUMENTS_STORE');

/** A branch, and a location within it or none: what one of a reader's grants reaches (`Authoriser.scopes`). */
export interface ReadScope {
  readonly branchId: string;
  readonly locationId: string | null;
}

/** One movement as the ledger holds it. */
export interface MovementRecord {
  readonly id: string;
  readonly movementType: string;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly branchId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly qtyBase: string;
  readonly weightKg: string | null;
  readonly weightSource: WeightSource | null;
  readonly packCount: number | null;
  readonly valuePesewas: bigint;
  readonly costElement: CostElement | null;
  readonly reasonCode: string | null;
  readonly sourceDocumentId: string;
  readonly reservationId: string | null;
  readonly reversesMovementId: string | null;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly actorId: string;
}

export interface MovementFilters {
  readonly productId?: string | undefined;
  readonly stockUnitId?: string | undefined;
  readonly locationId?: string | undefined;
  readonly movementType?: string | undefined;
  readonly sourceDocumentId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export interface MovementTypeRecord {
  readonly code: string;
  readonly name: string;
  readonly isValueOnly: boolean;
  readonly allowsNegative: boolean;
  readonly blockedByHold: boolean;
  readonly requiresReason: boolean;
  readonly requiresStockUnit: boolean;
}

export interface UnitRecord {
  readonly id: string;
  readonly productId: string;
  readonly tracking: 'SERIAL' | 'LOT';
  readonly identifier: string;
  readonly status: string;
  readonly branchId: string;
  readonly currentLocationId: string | null;
}

export interface PoolRecord {
  readonly qty: string;
  readonly valuePesewas: bigint;
}

export type TransferStatus = 'DRAFT' | 'DISPATCHED' | 'RECEIVED' | 'CANCELLED';

export interface TransferLineRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly qtyDispatched: string;
  readonly qtyReceived: string | null;
  readonly varianceQty: string | null;
  readonly varianceReasonCode: string | null;
}

export interface TransferRecord {
  readonly id: string;
  readonly transferNo: string | null;
  readonly status: TransferStatus;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly toBranchId: string;
  readonly inTransitLocationId: string | null;
  readonly dispatchedAt: Date | null;
  readonly dispatchedBy: string | null;
  readonly receivedAt: Date | null;
  readonly receivedBy: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly lines: readonly TransferLineRecord[];
}

export interface TransferFilters {
  readonly status?: TransferStatus | undefined;
  readonly fromLocationId?: string | undefined;
  readonly toLocationId?: string | undefined;
}

export type AdjustmentStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED';

export interface AdjustmentLineRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly direction: AdjustmentDirection;
  readonly qty: string;
  readonly weightKg: string | null;
  readonly weightSource: WeightSource | null;
  readonly valuePesewas: bigint;
  readonly movementId: string | null;
}

export interface AdjustmentRecord {
  readonly id: string;
  readonly adjustmentNo: string | null;
  readonly status: AdjustmentStatus;
  readonly locationId: string;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly totalValuePesewas: bigint;
  readonly approvalRequestId: string | null;
  readonly exceptionId: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly postedAt: Date | null;
  readonly postedBy: string | null;
  readonly lines: readonly AdjustmentLineRecord[];
}

export interface AdjustmentFilters {
  readonly status?: AdjustmentStatus | undefined;
  readonly locationId?: string | undefined;
  readonly reasonCode?: string | undefined;
  readonly createdBy?: string | undefined;
}

export type ReversalStatus = 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED';

export interface ReversalRecord {
  readonly id: string;
  readonly movementId: string;
  readonly reasonCode: string;
  readonly note: string;
  readonly valuePesewas: bigint;
  readonly approvalRequestId: string | null;
  readonly reversalMovementId: string | null;
  readonly status: ReversalStatus;
  readonly branchId: string;
  readonly createdBy: string;
}

export interface NewStockException {
  readonly kind: 'TRANSFER_VARIANCE';
  readonly branchId: string;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string;
  /** Null for a shortfall held in transit (ADR-0048): the exception itself holds it until it is resolved. */
  readonly movementId: string | null;
  readonly sourceDocumentId: string;
  readonly qty: string;
  readonly details: Record<string, unknown>;
}

/** INV's transfer, adjustment and reversal tables (migration 0051) and the movement reads, in the caller's transaction. */
export interface StockDocumentsStore {
  // Movements and the facts a document is checked against.
  movementTypes(tx: Transaction): Promise<MovementTypeRecord[]>;
  movement(tx: Transaction, id: string): Promise<MovementRecord | null>;
  /** Newest first; `beforeId` continues a page. Narrowed to movements whose branch and a location a scope reaches. */
  movements(tx: Transaction, filters: MovementFilters, scopes: readonly ReadScope[], beforeId: string | null, limit: number): Promise<MovementRecord[]>;
  /** For each id, the movement that reversed it, if any. */
  reversedBy(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  units(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, UnitRecord>>;
  pool(tx: Transaction, productId: string, stockUnitId: string | null, branchId: string): Promise<PoolRecord | null>;
  exceptionState(tx: Transaction, id: string): Promise<{ readonly status: string; readonly branchId: string; readonly kind: string; readonly movementId: string | null } | null>;
  insertException(tx: Transaction, exception: NewStockException): Promise<string>;
  /** Resolves an OPEN exception once (the database's guard refuses a second resolution). */
  resolveException(tx: Transaction, id: string, resolution: { readonly kind: ResolutionKind; readonly note: string; readonly documentId: string | null; readonly at: Date }, actorId: string): Promise<void>;

  // Transfers.
  insertTransfer(tx: Transaction, transfer: { readonly id: string; readonly fromLocationId: string; readonly toLocationId: string; readonly toBranchId: string; readonly branchId: string }, actorId: string): Promise<void>;
  insertTransferLine(tx: Transaction, transferId: string, line: Omit<TransferLineRecord, 'qtyReceived' | 'varianceQty' | 'varianceReasonCode'>): Promise<void>;
  lockTransfer(tx: Transaction, id: string): Promise<{ readonly status: TransferStatus; readonly version: number } | null>;
  transfer(tx: Transaction, id: string): Promise<TransferRecord | null>;
  /** Visible to a scope that reaches the source (in the transfer's branch) or the destination (in the receiving branch). */
  transfers(tx: Transaction, filters: TransferFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<TransferRecord[]>;
  setDispatchMovement(tx: Transaction, lineId: string, movementId: string): Promise<void>;
  markDispatched(tx: Transaction, id: string, inTransitLocationId: string, at: Date, actorId: string): Promise<void>;
  setLineReceipt(
    tx: Transaction,
    lineId: string,
    receipt: { readonly received: string; readonly variance: string; readonly reasonCode: string | null; readonly receiptMovementId: string | null; readonly varianceMovementId: string | null },
  ): Promise<void>;
  markReceived(tx: Transaction, id: string, at: Date, actorId: string): Promise<void>;
  markTransferCancelled(tx: Transaction, id: string, reason: string, actorId: string): Promise<void>;

  // Adjustments.
  insertAdjustment(
    tx: Transaction,
    adjustment: { readonly id: string; readonly locationId: string; readonly reasonCode: string; readonly note: string | null; readonly exceptionId: string | null; readonly branchId: string },
    actorId: string,
  ): Promise<void>;
  insertAdjustmentLine(tx: Transaction, adjustmentId: string, line: AdjustmentLineRecord): Promise<void>;
  lockAdjustment(tx: Transaction, id: string): Promise<{ readonly status: AdjustmentStatus; readonly version: number } | null>;
  adjustment(tx: Transaction, id: string): Promise<AdjustmentRecord | null>;
  adjustments(tx: Transaction, filters: AdjustmentFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<AdjustmentRecord[]>;
  setAdjustmentLineValue(tx: Transaction, lineId: string, valuePesewas: bigint): Promise<void>;
  setAdjustmentLineMovement(tx: Transaction, lineId: string, movementId: string): Promise<void>;
  markAdjustmentJudged(
    tx: Transaction,
    id: string,
    outcome: { readonly status: 'PENDING_APPROVAL' | 'POSTED'; readonly totalValuePesewas: bigint; readonly thresholdPesewas: bigint; readonly approvalRequestId: string | null; readonly at: Date },
    actorId: string,
  ): Promise<void>;
  markAdjustmentDecided(tx: Transaction, id: string, status: 'POSTED' | 'REJECTED', at: Date, actorId: string): Promise<void>;

  // Reversals.
  hasOpenReversal(tx: Transaction, movementId: string): Promise<boolean>;
  insertReversal(
    tx: Transaction,
    reversal: Omit<ReversalRecord, 'createdBy'> & { readonly thresholdPesewas: bigint; readonly postedAt: Date | null },
    actorId: string,
  ): Promise<void>;
  lockReversal(tx: Transaction, id: string): Promise<ReversalRecord | null>;
  markReversalDecided(tx: Transaction, id: string, outcome: { readonly status: 'POSTED' | 'REJECTED'; readonly reversalMovementId: string | null; readonly at: Date }, actorId: string): Promise<void>;
}
