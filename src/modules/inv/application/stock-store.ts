import type { Transaction } from '../../../platform/database/unit-of-work';

export const STOCK_STORE = Symbol('STOCK_STORE');

export type WeightSource = 'SCALE' | 'MANUAL' | 'ESTIMATE';
export type CostElement = 'PURCHASE' | 'FEED' | 'VETERINARY' | 'LABOUR' | 'OVERHEAD' | 'PROCESSING';
export type LinkType = 'PROCESSING' | 'SPLIT' | 'REPACK' | 'BIRTH';

/** One movement as the ledger stores it; quantities and weights as exact decimal strings, money as bigint pesewas. */
export interface MovementRow {
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
  readonly sourceLineRef: string | null;
  readonly reservationId: string | null;
  readonly reversesMovementId: string | null;
  readonly occurredAt: Date;
  readonly actorId: string;
}

/** What the database decided: the value it carried, and the event its type posts to the ledger. */
export interface PostedRow {
  readonly valuePesewas: bigint;
  readonly postingEvent: string | null;
}

export interface UnitLink {
  readonly unitId: string;
  readonly branchId: string;
  readonly identifier: string;
  readonly productId: string;
  readonly tracking: 'SERIAL' | 'LOT';
  readonly status: string;
  readonly supplierId: string | null;
  readonly sourceDocumentId: string;
  /** The unit this one was reached from, and how; null for the unit traced. */
  readonly via: { readonly unitId: string; readonly linkType: LinkType; readonly sourceDocumentId: string } | null;
  readonly depth: number;
}

export interface UnitMovement {
  readonly id: string;
  readonly stockUnitId: string;
  readonly movementType: string;
  readonly qtyBase: string;
  readonly valuePesewas: bigint;
  readonly costElement: CostElement | null;
  readonly sourceDocumentId: string;
  readonly reversesMovementId: string | null;
  readonly occurredAt: Date;
}

/** One balance or cost pool whose projection disagrees with a fresh sum of the ledger. */
export interface DriftRow {
  readonly kind: 'BALANCE' | 'COST_POOL';
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string | null;
  readonly branchId: string;
  readonly projectedQty: string;
  readonly ledgerQty: string;
  readonly projectedValuePesewas: bigint | null;
  readonly ledgerValuePesewas: bigint | null;
}

export interface StockStore {
  insertMovement(tx: Transaction, row: MovementRow): Promise<PostedRow>;
  insertLineage(tx: Transaction, childUnitId: string, parentUnitId: string, linkType: LinkType, sourceDocumentId: string, actorId: string): Promise<void>;
  unitExists(tx: Transaction, unitId: string): Promise<boolean>;
  /** The unit and every unit it came from (backward) or that came from it (forward), nearest first. */
  lineage(tx: Transaction, unitId: string, direction: 'BACKWARD' | 'FORWARD'): Promise<UnitLink[]>;
  movementsOf(tx: Transaction, unitIds: readonly string[]): Promise<UnitMovement[]>;
  /** Every balance and pool that differs from the ledger: a full recompute, run by the nightly job only. */
  drift(tx: Transaction): Promise<DriftRow[]>;
  raiseDrift(tx: Transaction, row: DriftRow): Promise<string>;
}
