import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ExpiryAlertKind, LevelAlertKind, StockAlertKind } from '../domain/stock-alert';
import type { ReadScope } from './stock-documents-store';

export const STOCK_ALERT_STORE = Symbol('STOCK_ALERT_STORE');

/** One live row of `inv.reorder_rule` (migration 0064). */
export interface ReorderRuleRecord {
  readonly id: string;
  readonly productId: string;
  readonly branchId: string;
  readonly locationId: string | null;
  readonly minQty: string;
  readonly reorderPointQty: string;
  readonly maxQty: string;
  readonly expiryAlertDays: number | null;
  readonly version: number;
}

/** A rule against what is available now, from the published view `inv.pub_reorder_level`. */
export interface ReorderLevelRecord {
  readonly reorderRuleId: string;
  readonly productId: string;
  readonly branchId: string;
  readonly locationId: string | null;
  readonly minQty: string;
  readonly reorderPointQty: string;
  readonly maxQty: string;
  readonly availableQty: string;
}

/** One row of `inv.stock_alert`. */
export interface StockAlertRecord {
  readonly id: string;
  readonly kind: StockAlertKind;
  readonly branchId: string;
  readonly productId: string;
  readonly locationId: string | null;
  readonly stockUnitId: string | null;
  readonly reorderRuleId: string | null;
  readonly qty: string;
  readonly thresholdQty: string | null;
  readonly suggestedQty: string | null;
  readonly expiresOn: string | null;
  readonly raisedAt: Date;
}

export type NewStockAlert = Omit<StockAlertRecord, 'raisedAt'>;

/** A lot with an expiry date where it stands, with its on hand there. */
export interface ExpiringLotRecord {
  readonly stockUnitId: string;
  readonly productId: string;
  readonly branchId: string;
  readonly locationId: string;
  readonly identifier: string;
  readonly expiresOn: string;
  readonly onHandQty: string;
}

/** One row of `inv.temperature_reading`. */
export interface TemperatureReadingRecord {
  readonly id: string;
  readonly locationId: string;
  readonly branchId: string;
  readonly readingC: string;
  readonly rangeMinC: string;
  readonly rangeMaxC: string;
  readonly measuredAt: Date;
  readonly source: 'MANUAL' | 'SENSOR';
  readonly isExcursion: boolean;
  readonly excursionDocumentId: string | null;
  readonly exceptionId: string | null;
  readonly recordedAt: Date;
  readonly actorId: string;
}

export type NewTemperatureReading = Omit<TemperatureReadingRecord, 'recordedAt' | 'actorId'>;

/** A stock line in a location a reading covers: what an excursion quarantines. */
export interface LocationStockRecord {
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly unitStatus: string | null;
  readonly onHandQty: string;
}

export interface TemperatureReadingFilters {
  readonly locationId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly excursionsOnly?: boolean | undefined;
}

export interface StockAlertFilters {
  readonly branchId?: string | undefined;
  readonly kind?: StockAlertKind | undefined;
}

/** Reorder rules, stock alerts and the cold chain log (migration 0064), in the caller's transaction. */
export interface StockAlertStore {
  // Rules.
  rule(tx: Transaction, id: string): Promise<ReorderRuleRecord | null>;
  lockRule(tx: Transaction, id: string): Promise<ReorderRuleRecord | null>;
  ruleFor(tx: Transaction, productId: string, branchId: string, locationId: string | null): Promise<ReorderRuleRecord | null>;
  rules(tx: Transaction, filters: { readonly productId?: string | undefined; readonly branchId?: string | undefined }, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<ReorderRuleRecord[]>;
  insertRule(tx: Transaction, rule: Omit<ReorderRuleRecord, 'version'>, actorId: string): Promise<void>;
  /** Writes the levels if the rule is still at `version`; false when it has moved on. */
  updateRule(tx: Transaction, id: string, version: number, levels: Pick<ReorderRuleRecord, 'minQty' | 'reorderPointQty' | 'maxQty' | 'expiryAlertDays'>, actorId: string): Promise<boolean>;
  /** The expiry lead times of the live rules of these products, by product, branch and location (null for branch-wide). */
  leadTimes(tx: Transaction, productIds: readonly string[]): Promise<ReorderRuleRecord[]>;
  // Levels and alerts.
  /** Each live rule of the products against available stock now; every live rule when `productIds` is null. */
  levels(tx: Transaction, productIds: readonly string[] | null): Promise<ReorderLevelRecord[]>;
  openLevelAlerts(tx: Transaction, ruleIds: readonly string[]): Promise<ReadonlyArray<{ readonly id: string; readonly reorderRuleId: string; readonly kind: LevelAlertKind }>>;
  openExpiryAlerts(tx: Transaction): Promise<ReadonlyArray<{ readonly id: string; readonly stockUnitId: string; readonly locationId: string; readonly kind: ExpiryAlertKind }>>;
  /** Inserts an open alert unless one of its kind is already open for its rule or lot there; true when inserted. */
  raiseAlert(tx: Transaction, alert: NewStockAlert, at: Date, actorId: string): Promise<boolean>;
  clearAlert(tx: Transaction, id: string, at: Date, actorId: string): Promise<void>;
  /** Open alerts newest first, narrowed to the branch of a scope and, for a location-bound scope, its location. */
  alerts(tx: Transaction, filters: StockAlertFilters, scopes: readonly ReadScope[], after: { readonly raisedAt: string; readonly id: string } | null, limit: number): Promise<StockAlertRecord[]>;
  /** Each active lot with an expiry date and stock at a physical location, with its on hand there. */
  datedLots(tx: Transaction): Promise<ExpiringLotRecord[]>;
  /** On hand at a location of each unit, for an expiry alert's current figure. */
  unitOnHand(tx: Transaction, pairs: ReadonlyArray<{ readonly stockUnitId: string; readonly locationId: string }>): Promise<ReadonlyMap<string, string>>;
  // The cold chain.
  reading(tx: Transaction, id: string): Promise<TemperatureReadingRecord | null>;
  readings(tx: Transaction, filters: TemperatureReadingFilters, scopes: readonly ReadScope[], after: { readonly measuredAt: string; readonly id: string } | null, limit: number): Promise<TemperatureReadingRecord[]>;
  insertReading(tx: Transaction, reading: NewTemperatureReading, actorId: string): Promise<void>;
  /** Every non-zero stock line at a location, in product and unit order. */
  stockAt(tx: Transaction, locationId: string): Promise<LocationStockRecord[]>;
}
