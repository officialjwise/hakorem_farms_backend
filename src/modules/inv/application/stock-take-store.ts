import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ScopeClaim, StockTakeScope, StockTakeStatus } from '../domain/stock-take';
import type { ReadScope } from './stock-documents-store';
import type { WeightSource } from './stock-store';

export const STOCK_TAKE_STORE = Symbol('STOCK_TAKE_STORE');

export interface StockTakeRecord {
  readonly id: string;
  readonly stockTakeNo: string | null;
  readonly status: StockTakeStatus;
  readonly locationId: string;
  readonly scope: StockTakeScope;
  readonly productIds: readonly string[];
  readonly snapshotAt: Date | null;
  readonly countedBy: string | null;
  readonly gainValuePesewas: bigint | null;
  readonly lossValuePesewas: bigint | null;
  readonly varianceValuePesewas: bigint | null;
  readonly approvalRequestId: string | null;
  readonly cancelReason: string | null;
  readonly lineCount: number;
  readonly countedLineCount: number;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly postedAt: Date | null;
  readonly postedBy: string | null;
}

export interface StockTakeLineRecord {
  readonly id: string;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly expectedQty: string;
  readonly countedQty: string | null;
  readonly recountQty: string | null;
  readonly countedWeightKg: string | null;
  readonly countedWeightSource: WeightSource | null;
  readonly varianceQty: string | null;
  readonly varianceValuePesewas: bigint | null;
  readonly movementId: string | null;
}

/** A balance a take freezes as its expected figure: a product, its lot or none, and the quantity on hand. */
export interface BalanceInScope {
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly onHandQty: string;
}

export interface StockTakeFilters {
  readonly status?: StockTakeStatus | undefined;
  readonly locationId?: string | undefined;
}

export interface VarianceTotalsRecord {
  readonly gainPesewas: bigint;
  readonly lossPesewas: bigint;
  readonly totalPesewas: bigint;
}

/** INV's stock take tables (migration 0054), in the caller's transaction. */
export interface StockTakeStore {
  insertTake(tx: Transaction, take: { readonly id: string; readonly locationId: string; readonly scope: StockTakeScope; readonly branchId: string }, actorId: string): Promise<void>;
  insertTakeProducts(tx: Transaction, takeId: string, productIds: readonly string[]): Promise<void>;
  lockTake(tx: Transaction, id: string): Promise<{ readonly status: StockTakeStatus } | null>;
  take(tx: Transaction, id: string): Promise<StockTakeRecord | null>;
  takes(tx: Transaction, filters: StockTakeFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<StockTakeRecord[]>;
  /** The claims of the takes at a location in one of `statuses`, other than `exceptId`. */
  claimsAt(tx: Transaction, locationId: string, statuses: readonly StockTakeStatus[], exceptId: string | null): Promise<Array<ScopeClaim & { readonly id: string }>>;
  /** Non-zero balances at a location, of the listed products or of all, leaving out animals (A-141). */
  balancesInScope(tx: Transaction, locationId: string, productIds: readonly string[] | null): Promise<BalanceInScope[]>;
  insertLine(tx: Transaction, takeId: string, line: { readonly id: string; readonly productId: string; readonly stockUnitId: string | null; readonly expectedQty: string }): Promise<void>;
  markStarted(tx: Transaction, id: string, at: Date, actorId: string): Promise<void>;
  lines(tx: Transaction, takeId: string): Promise<StockTakeLineRecord[]>;
  linesPage(tx: Transaction, takeId: string, afterId: string | null, limit: number): Promise<StockTakeLineRecord[]>;
  setCount(tx: Transaction, lineId: string, count: { readonly qty: string; readonly weightKg: string | null; readonly weightSource: WeightSource | null }): Promise<void>;
  setRecount(tx: Transaction, lineId: string, recount: string, variance: { readonly qty: string; readonly valuePesewas: bigint }): Promise<void>;
  setVariance(tx: Transaction, lineId: string, variance: { readonly qty: string; readonly valuePesewas: bigint }): Promise<void>;
  setLineMovement(tx: Transaction, lineId: string, movementId: string): Promise<void>;
  /** Records who is counting (the first to record a count) and the change; nothing else of the take moves. */
  touchCounting(tx: Transaction, id: string, actorId: string): Promise<void>;
  markReview(tx: Transaction, id: string, totals: VarianceTotalsRecord, actorId: string): Promise<void>;
  setTotals(tx: Transaction, id: string, totals: VarianceTotalsRecord, actorId: string): Promise<void>;
  markJudged(
    tx: Transaction,
    id: string,
    outcome: { readonly status: 'PENDING_APPROVAL' | 'POSTED'; readonly totals: VarianceTotalsRecord; readonly thresholdPesewas: bigint; readonly approvalRequestId: string | null; readonly at: Date },
    actorId: string,
  ): Promise<void>;
  markPosted(tx: Transaction, id: string, at: Date, actorId: string): Promise<void>;
  markCancelled(tx: Transaction, id: string, reason: string, actorId: string): Promise<void>;
}
