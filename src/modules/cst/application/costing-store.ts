import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ElementAmounts } from '../domain/cost-object';

export const COSTING_STORE = Symbol('COSTING_STORE');

export type CostElementRun = 'LABOUR' | 'OVERHEAD';
export type AllocationBasis = 'HEAD_DAYS' | 'WEIGHT_GAIN' | 'EQUAL';

export interface RunRecord {
  readonly id: string;
  readonly branchId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly costElement: CostElementRun;
  readonly basis: AllocationBasis;
  readonly scopeLocationId: string | null;
  readonly totalPesewas: bigint;
  readonly status: 'DRAFT' | 'POSTED';
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly postedAt: Date | null;
  readonly postedBy: string | null;
}

export interface LineRecord {
  readonly runId: string;
  readonly stockUnitId: string;
  readonly weight: bigint;
  readonly amountPesewas: bigint;
  readonly treatment: 'CAPITALISED' | 'EXPENSED';
  readonly movementRef: string | null;
}

/** A livestock unit's whole quantity on hand in a run's scope at the end of one Africa/Accra day. */
export interface DailyHead {
  readonly stockUnitId: string;
  readonly day: string;
  readonly onHandQty: string;
}

export interface SummaryRecord {
  readonly objectType: 'STOCK_UNIT' | 'PROCESSING_ORDER';
  readonly objectId: string;
  readonly branchId: string;
  readonly elements: ElementAmounts;
  readonly refreshedAt: Date;
}

/** A processing order's stock flows: each consumed unit's signed value and the outputs' signed total. */
export interface ProcessingFlow {
  readonly orderId: string;
  readonly branchId: string;
  readonly stockUnitId: string | null;
  readonly kind: 'CONSUME' | 'OUTPUT';
  readonly signedValue: bigint;
}

export type MarginGroupBy = 'PRODUCT' | 'PRODUCT_LINE' | 'CHANNEL' | 'CUSTOMER' | 'SALESPERSON' | 'BRANCH';

export interface MarginRange {
  readonly from: string;
  readonly to: string;
  /** The branches to read; null for every branch (the nightly comparison only). */
  readonly branchIds: readonly string[] | null;
}

/** A group's sums, each of non-negative facts split by whether they reduce. */
export interface MarginSums {
  readonly key: string | null;
  readonly revenueSales: bigint;
  readonly revenueCredits: bigint;
  readonly costSales: bigint;
  readonly costCredits: bigint;
  readonly variance: bigint;
  /** Net quantity and weight billed (credit notes taken back), as decimal strings. */
  readonly qty: string;
  readonly weightKg: string | null;
}

export interface LossFactRecord {
  readonly movementRef: string;
  readonly locationId: string;
  readonly productId: string;
  readonly handlerRef: string | null;
  readonly lossGroup: 'MORTALITY' | 'SHRINKAGE' | 'WASTAGE';
  readonly isReversal: boolean;
  readonly qty: string;
  readonly valuePesewas: bigint;
}

/** CST's tables (docs/data-model/cst.md) and its reads of the published views; nothing else. */
export interface CostingStore {
  insertRun(tx: Transaction, run: Omit<RunRecord, 'status' | 'version' | 'postedAt' | 'postedBy'>, lines: readonly Omit<LineRecord, 'movementRef'>[]): Promise<void>;
  run(tx: Transaction, id: string, forUpdate: boolean): Promise<RunRecord | null>;
  lines(tx: Transaction, runIds: readonly string[]): Promise<LineRecord[]>;
  listRuns(tx: Transaction, branchIds: readonly string[], after: { readonly createdAt: string; readonly id: string } | null, limit: number): Promise<RunRecord[]>;
  postedRunExists(tx: Transaction, run: RunRecord): Promise<boolean>;
  markPosted(tx: Transaction, id: string, postedBy: string, at: Date, movements: ReadonlyMap<string, string>): Promise<void>;
  /** Every livestock unit's whole quantity on hand at the end of each day of the period, in the scope or the branch. */
  dailyHeads(tx: Transaction, scope: { readonly branchId: string; readonly locationId: string | null; readonly from: string; readonly to: string }): Promise<DailyHead[]>;
  /** Where each unit stands now: the one physical location holding it (the most of it), or none. */
  placesNow(tx: Transaction, stockUnitIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  unitsOnHandAt(tx: Transaction, locationId: string): Promise<string[]>;

  refreshUnits(tx: Transaction, stockUnitIds: readonly string[] | null): Promise<number>;
  refreshMarginRevenue(tx: Transaction, documentIds: readonly string[] | null): Promise<number>;
  refreshMarginCost(tx: Transaction, movementIds: readonly string[] | null): Promise<number>;
  refreshLosses(tx: Transaction, movementIds: readonly string[] | null): Promise<number>;
  processingFlows(tx: Transaction, orderIds: readonly string[] | null): Promise<ProcessingFlow[]>;
  putProcessingOrders(tx: Transaction, orderIds: readonly string[] | null, rows: readonly { readonly objectId: string; readonly branchId: string; readonly elements: ElementAmounts }[]): Promise<number>;

  summaries(tx: Transaction, objectType: 'STOCK_UNIT' | 'PROCESSING_ORDER', ids: readonly string[]): Promise<SummaryRecord[]>;
  marginGroups(tx: Transaction, range: MarginRange, groupBy: MarginGroupBy, after: string | null, limit: number): Promise<MarginSums[]>;
  marginTotals(tx: Transaction, range: MarginRange): Promise<MarginSums>;
  lineSums(tx: Transaction, range: MarginRange): Promise<MarginSums[]>;
  lossFacts(tx: Transaction, range: MarginRange): Promise<LossFactRecord[]>;
}
