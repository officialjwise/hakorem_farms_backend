import type { Transaction } from '../../../platform/database/unit-of-work';
import type { TaxBaseKind, TaxTreatment } from '../domain/tax/tax-calculator';
import type { ActiveTaxWindow, TaxWindow } from '../domain/tax/tax-scheme';

/** Persistence of the tax sub-domain (migration 0014). Dates are business dates written `YYYY-MM-DD`. */
export const TAX_STORE = Symbol('TAX_STORE');

export type TaxVersionStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'ACTIVE' | 'SUPERSEDED' | 'REJECTED';

export interface TaxLevyRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly version: number;
}

export interface TaxCategoryRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly productCount: number;
  readonly version: number;
}

export interface TaxVersionRow {
  readonly id: string;
  readonly versionNo: number;
  readonly status: TaxVersionStatus;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly sourceNote: string;
  readonly approvalRequestId: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
}

/** One stored cell, with the references the contract prints and the levies of its base. */
export interface TaxCellRow {
  readonly category: { readonly id: string; readonly code: string; readonly name: string };
  readonly levy: { readonly id: string; readonly code: string; readonly name: string };
  readonly treatment: TaxTreatment;
  /** `NUMERIC(7,4)` as PostgreSQL writes it, such as `15.0000`. */
  readonly ratePercent: string;
  readonly baseKind: TaxBaseKind;
  readonly baseLevies: readonly { readonly id: string; readonly code: string }[];
  readonly isReclaimable: boolean;
  readonly calcOrder: number;
}

/** A cell to write, already validated by the domain. */
export interface NewTaxCell {
  readonly categoryId: string;
  readonly levyId: string;
  readonly treatment: TaxTreatment;
  readonly ratePercent: string;
  readonly baseKind: TaxBaseKind;
  readonly baseLevyIds: readonly string[];
  readonly isReclaimable: boolean;
  readonly calcOrder: number;
}

export interface TaxStore {
  levies(tx: Transaction): Promise<TaxLevyRow[]>;
  insertLevy(tx: Transaction, id: string, levy: { readonly code: string; readonly name: string; readonly sortOrder: number }, actorId: string): Promise<void>;
  categories(tx: Transaction): Promise<TaxCategoryRow[]>;
  insertCategory(tx: Transaction, id: string, category: { readonly code: string; readonly name: string }, actorId: string): Promise<void>;

  /** Newest first, `limit + 1` rows from after the given version number, so the caller can tell there is more. */
  versionPage(tx: Transaction, beforeVersionNo: number | null, limit: number): Promise<TaxVersionRow[]>;
  version(tx: Transaction, id: string, forUpdate: boolean): Promise<TaxVersionRow | null>;
  cells(tx: Transaction, versionId: string): Promise<TaxCellRow[]>;
  openVersionId(tx: Transaction): Promise<string | null>;
  nextVersionNo(tx: Transaction): Promise<number>;
  firstBranchId(tx: Transaction): Promise<string>;
  insertVersion(tx: Transaction, version: { readonly id: string; readonly versionNo: number; readonly window: TaxWindow; readonly sourceNote: string; readonly branchId: string }, actorId: string): Promise<void>;
  /** Empties the draft's matrix and writes the new one; the database refuses this outside DRAFT. */
  replaceCells(tx: Transaction, versionId: string, cells: readonly NewTaxCell[], actorId: string, nextId: () => string): Promise<void>;
  /** Moves the version's optimistic lock on; false when it is not at `expected`. */
  touchVersion(tx: Transaction, id: string, expected: number, actorId: string): Promise<boolean>;
  markPending(tx: Transaction, id: string, approvalRequestId: string, actorId: string): Promise<void>;
  /** The ACTIVE versions; `lock` takes their rows FOR UPDATE, for activation only. */
  activeWindows(tx: Transaction, lock: boolean): Promise<ActiveTaxWindow[]>;
  endVersion(tx: Transaction, id: string, validTo: string, actorId: string): Promise<void>;
  supersede(tx: Transaction, id: string, actorId: string): Promise<void>;
  activate(tx: Transaction, id: string, validFrom: string, actorId: string, at: Date): Promise<void>;
  reject(tx: Transaction, id: string, actorId: string): Promise<void>;
  /** The live categories among `ids`. */
  existingCategoryIds(tx: Transaction, ids: readonly string[]): Promise<Set<string>>;
}
