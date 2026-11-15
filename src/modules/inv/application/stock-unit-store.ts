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
  readonly lastWeighedAt: Date | null;
  readonly gradeId: string | null;
  /** The unit's cost pool at its branch: what an issue of the whole unit would carry now. */
  readonly poolValuePesewas: bigint;
  /** The quantity that pool holds (head of an animal or flock, kilograms of a lot), as a decimal string. */
  readonly poolQty: string;
  /** Whether an ACTIVE reservation sets the unit aside (ADR-0019). */
  readonly reserved: boolean;
  /** Unreleased holds that cover `at`, the time the caller asked about. */
  readonly holds: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly endsAt: Date | null }>;
}

/** A stock unit standing at a physical location, with what is on hand of it there. */
export interface UnitOnHandRecord {
  readonly id: string;
  readonly productId: string;
  readonly tracking: 'SERIAL' | 'LOT';
  readonly identifier: string;
  readonly branchId: string;
  readonly locationId: string;
  readonly onHandQty: string;
}

export const STOCK_UNIT_STORE = Symbol('StockUnitStore');

export interface StockUnitStore {
  facts(tx: Transaction, ids: readonly string[], at: Date): Promise<StockUnitFactsRecord[]>;
  /** The units of a product whose identifiers are already taken among active units. */
  activeIdentifiers(tx: Transaction, productId: string, identifiers: readonly string[]): Promise<string[]>;
  insert(tx: Transaction, unit: NewStockUnit, actorId: string): Promise<void>;
  /** Where each of the units has stock on hand at a physical location, in identifier order. */
  onHandOf(tx: Transaction, unitIds: readonly string[]): Promise<UnitOnHandRecord[]>;
  /** The units with stock on hand at any of the locations, in identifier order. */
  onHandAt(tx: Transaction, locationIds: readonly string[]): Promise<UnitOnHandRecord[]>;
  /** Sets the unit's last weight when `at` is not before the one it holds; true if it changed. */
  recordWeight(tx: Transaction, id: string, weightKg: string, at: Date, actorId: string): Promise<boolean>;
}
