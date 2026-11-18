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
  /** The sale issue a customer return takes back (migration 0199). */
  readonly returnsMovementId: string | null;
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
  readonly weightKg: string | null;
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
  /** The value of every cost pool summed per product, for the ledger's nightly reconciliation (ADR-0056). */
  poolValueByProduct(tx: Transaction): Promise<{ readonly productId: string; readonly valuePesewas: bigint }[]>;
  raiseDrift(tx: Transaction, row: DriftRow): Promise<string>;
  /** An offline sale's stock that could not move, or could only move with a conflict (ADR-0027 point 3, B09b continued 2b). */
  raiseConflict(tx: Transaction, row: ConflictRow): Promise<string>;
  /** The exceptions the movement trigger raised for one movement (negative stock, a reservation run over). */
  exceptionsOfMovement(tx: Transaction, movementId: string): Promise<{ readonly id: string; readonly kind: string; readonly qty: string | null }[]>;
  /** Where a unit stands now and what it is, for an exception's facts. */
  unitStanding(tx: Transaction, unitId: string, at: Date): Promise<UnitStanding | null>;
}

/** Where a unit stands, what it is, and the holds covering an instant: an offline exception's fact. */
export interface UnitStanding {
  readonly identifier: string;
  readonly status: string;
  readonly currentLocationId: string | null;
  readonly holds: readonly { readonly kind: string; readonly startsAt: string; readonly endsAt: string | null; readonly sourceDocumentId: string }[];
}

/** A stock exception raised in a movement's place (`inv.stock_exception`, no movement). */
export interface ConflictRow {
  readonly kind: 'NEGATIVE_STOCK' | 'SERIAL_CONFLICT' | 'HOLD_CONFLICT' | 'RESERVATION_CONFLICT';
  readonly branchId: string;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string;
  readonly sourceDocumentId: string;
  readonly qty: string;
  readonly details: { readonly claim: unknown; readonly fact: unknown };
  readonly raisedAt: Date;
}
