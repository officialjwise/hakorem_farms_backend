import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AssetCategory, AssetStatus } from '../domain/fixed-asset';

export const FIXED_ASSET_STORE = Symbol('FIXED_ASSET_STORE');

/** `fin.fixed_asset` as the register reads it. Amounts are exact bigints. */
export interface FixedAssetRow {
  readonly id: string;
  readonly assetNo: string;
  readonly name: string;
  readonly category: AssetCategory;
  readonly branchId: string;
  readonly acquiredOn: string;
  readonly costPesewas: bigint;
  readonly residualPesewas: bigint;
  readonly usefulLifeMonths: number;
  readonly accumulatedPesewas: bigint;
  readonly depreciatedMonths: number;
  readonly status: AssetStatus;
  readonly disposedOn: string | null;
  readonly version: number;
}

export interface NewFixedAsset {
  readonly id: string;
  readonly name: string;
  readonly category: AssetCategory;
  readonly branchId: string;
  readonly acquiredOn: string;
  readonly costPesewas: bigint;
  readonly residualPesewas: bigint;
  readonly usefulLifeMonths: number;
}

export interface DisposalRecord {
  readonly disposedOn: string;
  readonly documentId: string;
  readonly proceedsPesewas: bigint;
  readonly note: string;
  readonly journalEntryId: string;
}

export interface DepreciationRunRow {
  readonly id: string;
  readonly periodId: string;
  readonly fiscalYear: number;
  readonly periodNo: number;
  readonly branchId: string;
  readonly status: 'DRAFT' | 'POSTED';
  readonly totalPesewas: bigint;
  readonly journalEntryId: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export interface DepreciationLineRow {
  readonly runId: string;
  readonly fixedAssetId: string;
  readonly assetNo: string;
  readonly name: string;
  readonly category: AssetCategory;
  readonly branchId: string;
  readonly fromMonth: number;
  readonly months: number;
  readonly amountPesewas: bigint;
}

/** FIN's fixed asset register and depreciation runs (`fin.fixed_asset`, `fin.depreciation_run`, `fin.depreciation_line`). */
export interface FixedAssetStore {
  /** Assets at the given branches only (the reader's, ADR-0017). */
  assets(tx: Transaction, filters: { readonly category: AssetCategory | null; readonly status: AssetStatus | null }, after: { readonly assetNo: string; readonly id: string } | null, limit: number, branchIds: readonly string[]): Promise<FixedAssetRow[]>;
  asset(tx: Transaction, id: string, forUpdate: boolean): Promise<FixedAssetRow | null>;
  /** Every asset not disposed of that was acquired on or before the day, in asset number order: what a run considers. */
  assetsInServiceOn(tx: Transaction, day: string): Promise<FixedAssetRow[]>;
  insertAsset(tx: Transaction, row: NewFixedAsset, actorId: string): Promise<void>;
  updateAsset(tx: Transaction, id: string, change: { readonly name: string; readonly usefulLifeMonths: number; readonly residualPesewas: bigint }, actorId: string): Promise<void>;
  disposeAsset(tx: Transaction, id: string, disposal: DisposalRecord, actorId: string): Promise<void>;
  /** Whether a draft run of a period still open carries the asset: its depreciation may not change under it. */
  onPendingRun(tx: Transaction, assetId: string): Promise<boolean>;
  /** Runs at the given branches only (the reader's, ADR-0017). */
  runs(tx: Transaction, beforeId: string | null, limit: number, branchIds: readonly string[]): Promise<DepreciationRunRow[]>;
  run(tx: Transaction, id: string, forUpdate: boolean): Promise<DepreciationRunRow | null>;
  runOfPeriod(tx: Transaction, periodId: string): Promise<DepreciationRunRow | null>;
  insertRun(tx: Transaction, row: { readonly id: string; readonly periodId: string; readonly branchId: string; readonly totalPesewas: bigint }, actorId: string): Promise<void>;
  insertLines(tx: Transaction, runId: string, lines: readonly { readonly fixedAssetId: string; readonly fromMonth: number; readonly months: number; readonly amountPesewas: bigint }[], actorId: string): Promise<void>;
  linesOf(tx: Transaction, runIds: readonly string[]): Promise<Map<string, DepreciationLineRow[]>>;
  markRunPosted(tx: Transaction, id: string, journalEntryId: string, actorId: string, at: Date): Promise<void>;
  /** The entries the ledger posted with this document as their source, one per branch, in branch order. */
  entriesOf(tx: Transaction, sourceDocumentId: string): Promise<{ readonly entryId: string; readonly branchId: string }[]>;
  /** The register's side of the nightly reconciliation (ADR-0059): per category, over every asset not disposed of. */
  costByCategory(tx: Transaction): Promise<{ readonly key: string; readonly pesewas: bigint }[]>;
  accumulatedByCategory(tx: Transaction): Promise<{ readonly key: string; readonly pesewas: bigint }[]>;
}
