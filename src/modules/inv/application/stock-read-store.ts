import type { Transaction } from '../../../platform/database/unit-of-work';
import type { SortOrder } from '../../../platform/http/keyset-sort';
import type { ReadScope } from './goods-receipt-store';

export const STOCK_READ_STORE = Symbol('STOCK_READ_STORE');

export type HoldKind = 'WITHDRAWAL' | 'QUARANTINE' | 'INVESTIGATION';

/** One balance at a physical location, as `inv.pub_stock_on_hand` publishes it, with its unit's dates and holds. */
export interface OnHandRow {
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string;
  readonly branchId: string;
  readonly onHandQty: string;
  readonly onHandWeightKg: string;
  readonly reservedQty: string;
  readonly availableQty: string;
  readonly packCount: number;
  readonly unit: {
    readonly identifier: string;
    readonly tracking: 'SERIAL' | 'LOT';
    readonly branchId: string;
    readonly producedOn: string | null;
    readonly expiresOn: string | null;
  } | null;
  /** Kinds of the holds that cover the unit now. */
  readonly holds: readonly HoldKind[];
}

export interface PoolRow {
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly branchId: string;
  readonly qty: string;
  readonly valuePesewas: bigint;
}

export interface OnHandFilters {
  readonly branchId?: string | undefined;
  readonly locationId?: string | undefined;
  readonly productId?: string | undefined;
  readonly stockUnitId?: string | undefined;
}

export interface StockUnitRow {
  readonly id: string;
  readonly productId: string;
  readonly tracking: 'SERIAL' | 'LOT';
  readonly branchId: string;
  readonly identifier: string;
  readonly currentLocationId: string | null;
  readonly status: 'ACTIVE' | 'SOLD' | 'CONSUMED' | 'WRITTEN_OFF' | 'DEPLETED';
  readonly producedOn: string | null;
  readonly expiresOn: string | null;
  readonly storageTempClass: 'AMBIENT' | 'CHILLED' | 'FROZEN' | null;
  readonly supplierId: string | null;
  readonly gradeId: string | null;
  readonly lastWeightKg: string | null;
  readonly lastWeighedAt: Date | null;
  readonly sourceDocumentId: string;
  readonly createdAt: Date;
  /** On hand at physical locations, and the unit's pool value. */
  readonly onHandQty: string;
  readonly valuePesewas: bigint;
  readonly activeHolds: ReadonlyArray<{ readonly id: string; readonly kind: HoldKind; readonly startsAt: Date; readonly endsAt: Date | null }>;
  readonly activeReservation: { readonly id: string; readonly holderDocumentId: string; readonly expiresAt: Date | null } | null;
}

export interface StockUnitFilters {
  /** Part of the tag or batch number, without regard to case. */
  readonly q?: string | undefined;
  readonly productId?: string | undefined;
  /** Where an animal stands, or where a lot has stock. */
  readonly locationId?: string | undefined;
  readonly status?: StockUnitRow['status'] | undefined;
  readonly tracking?: 'SERIAL' | 'LOT' | undefined;
  /** Expiring on or before this business date. */
  readonly expiresBy?: string | undefined;
  /** Under a hold in force now, or not. */
  readonly onHold?: boolean | undefined;
}

/** The narrowing a sorted stock on hand page applies in SQL that the unsorted list applies to its rows (CR-019). */
export interface OnHandNarrowing {
  /** The products of the asked category (MDM's), or null for any. */
  readonly productIds: readonly string[] | null;
  /** Units expiring on or before this business date, or null for any. */
  readonly expiresBy: string | null;
}

export interface StockReadStore {
  /**
   * Balances at physical locations within the scopes, in a stable order (location, product, unit). Holds, and so what
   * is available, are read at `at`, the application clock's now (ADR-0067); so are a unit's holds below.
   */
  onHand(tx: Transaction, filters: OnHandFilters, scopes: readonly ReadScope[], includeZero: boolean, at: Date): Promise<OnHandRow[]>;
  /** The same balances in the asked order (CR-019, ADR-0054), strictly after `position`, each with its own position. */
  onHandSorted(
    tx: Transaction,
    filters: OnHandFilters,
    scopes: readonly ReadScope[],
    includeZero: boolean,
    narrow: OnHandNarrowing,
    order: SortOrder,
    position: readonly string[] | null,
    limit: number,
    at: Date,
  ): Promise<Array<OnHandRow & { readonly position: string[] }>>;
  /** Every physical balance of the pools of these products, whatever the filter: a line's value is its share of its pool. */
  poolBalances(tx: Transaction, productIds: readonly string[]): Promise<Array<{ readonly productId: string; readonly stockUnitId: string | null; readonly locationId: string; readonly branchId: string; readonly onHandQty: string }>>;
  pools(tx: Transaction, productIds: readonly string[]): Promise<PoolRow[]>;
  stockUnit(tx: Transaction, id: string, at: Date): Promise<StockUnitRow | null>;
  /**
   * Ids of the stock units matching the filters, in id order after `afterId`, narrowed to the branch of a scope and,
   * for a grant at one location, to the animals standing there and the lots with stock there (as holds, A-142).
   */
  stockUnitIds(tx: Transaction, filters: StockUnitFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number, at: Date): Promise<string[]>;
  /** The same units in the asked order (CR-019, ADR-0054), strictly after `position`, each with its own position. */
  stockUnitIdsSorted(tx: Transaction, filters: StockUnitFilters, scopes: readonly ReadScope[], order: SortOrder, position: readonly string[] | null, limit: number, at: Date): Promise<Array<{ readonly id: string; readonly position: string[] }>>;
}
