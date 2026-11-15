import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ImportDirection, ImportEntity, ImportStatus, RowError } from '../domain/imports';

/** A row of `mdm.import_job`. */
export interface ImportJobRecord {
  readonly id: string;
  readonly entity: ImportEntity;
  readonly direction: ImportDirection;
  readonly fileId: string;
  readonly status: ImportStatus;
  readonly rowsTotal: number | null;
  readonly rowsValid: number | null;
  readonly rowsApplied: number | null;
  readonly rowsToCreate: number | null;
  readonly rowsToUpdate: number | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export interface NewImportJob {
  readonly id: string;
  readonly entity: ImportEntity;
  readonly direction: ImportDirection;
  readonly fileId: string;
  readonly status: ImportStatus;
  readonly rowsTotal: number | null;
  readonly rowsValid: number | null;
  readonly rowsApplied: number | null;
  readonly rowsToCreate: number | null;
  readonly rowsToUpdate: number | null;
  readonly branchId: string;
  /** Set for a job inserted in a posted status (an export, a failed import). */
  readonly postedAt: Date | null;
}

export interface ImportJobFilters {
  readonly entity?: ImportEntity | undefined;
  readonly direction?: ImportDirection | undefined;
}

export interface StoredRowError extends RowError {
  readonly id: string;
}

/** MDM's import job tables, each call in the caller's transaction. */
export interface ImportStore {
  headOfficeBranchId(tx: Transaction): Promise<string>;
  insertJob(tx: Transaction, job: NewImportJob, actorId: string): Promise<void>;
  job(tx: Transaction, id: string): Promise<ImportJobRecord | null>;
  lockJob(tx: Transaction, id: string): Promise<ImportJobRecord | null>;
  /** Newest first; `beforeId` is the last id of the previous page. */
  jobs(tx: Transaction, filters: ImportJobFilters, beforeId: string | null, limit: number): Promise<ImportJobRecord[]>;
  /** Moves a locked job; false if its version moved meanwhile. */
  updateJob(tx: Transaction, id: string, expectedVersion: number, set: { readonly status: ImportStatus; readonly rowsValid?: number; readonly rowsApplied?: number; readonly posted: boolean }, actorId: string, now: Date): Promise<boolean>;
  insertErrors(tx: Transaction, jobId: string, errors: readonly (RowError & { readonly id: string })[]): Promise<void>;
  errorCount(tx: Transaction, jobId: string): Promise<number>;
  /** In spreadsheet order; `after` is the last error of the previous page. */
  errors(tx: Transaction, jobId: string, after: { readonly rowNo: number; readonly id: string } | null, limit: number): Promise<StoredRowError[]>;
}

export const IMPORT_STORE = Symbol('IMPORT_STORE');
