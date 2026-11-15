import type { Transaction } from '../../../platform/database/unit-of-work';
import type { NewStockUnit } from './goods-receipt-store';

/** A stock unit as a higher module's command sees it, read in its transaction (the `StockUnits` interface). */
export interface StockUnitFactsRecord {
  readonly id: string;
  readonly productId: string;
  readonly tracking: 'SERIAL' | 'LOT';
  readonly branchId: string;
  readonly identifier: string;
  readonly status: 'ACTIVE' | 'SOLD' | 'CONSUMED' | 'WRITTEN_OFF' | 'DEPLETED';
  readonly currentLocationId: string | null;
  readonly lastWeightKg: string | null;
  /** The unit's cost pool at its branch: what an issue of the whole unit would carry now. */
  readonly poolValuePesewas: bigint;
  /** Unreleased holds that cover `at`, the time the caller asked about. */
  readonly holds: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly endsAt: Date | null }>;
}

export const STOCK_UNIT_STORE = Symbol('StockUnitStore');

export interface StockUnitStore {
  facts(tx: Transaction, ids: readonly string[], at: Date): Promise<StockUnitFactsRecord[]>;
  /** The units of a product whose identifiers are already taken among active units. */
  activeIdentifiers(tx: Transaction, productId: string, identifiers: readonly string[]): Promise<string[]>;
  insert(tx: Transaction, unit: NewStockUnit, actorId: string): Promise<void>;
}
