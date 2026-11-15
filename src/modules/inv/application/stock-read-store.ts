import type { Transaction } from '../../../platform/database/unit-of-work';
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

export interface StockReadStore {
  /** Balances at physical locations within the scopes, in a stable order (location, product, unit). */
  onHand(tx: Transaction, filters: OnHandFilters, scopes: readonly ReadScope[], includeZero: boolean): Promise<OnHandRow[]>;
  /** Every physical balance of the pools of these products, whatever the filter: a line's value is its share of its pool. */
  poolBalances(tx: Transaction, productIds: readonly string[]): Promise<Array<{ readonly productId: string; readonly stockUnitId: string | null; readonly locationId: string; readonly branchId: string; readonly onHandQty: string }>>;
  pools(tx: Transaction, productIds: readonly string[]): Promise<PoolRow[]>;
  stockUnit(tx: Transaction, id: string): Promise<StockUnitRow | null>;
}
