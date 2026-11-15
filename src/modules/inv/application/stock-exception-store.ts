import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ResolutionKind, StockExceptionKind } from '../domain/stock-exception';
import type { ReadScope } from './stock-documents-store';

export const STOCK_EXCEPTION_STORE = Symbol('STOCK_EXCEPTION_STORE');

/** One row of `inv.stock_exception` (migrations 0044 and 0060). */
export interface StockExceptionRecord {
  readonly id: string;
  readonly kind: StockExceptionKind;
  readonly branchId: string;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string | null;
  readonly movementId: string | null;
  readonly sourceDocumentId: string | null;
  readonly qty: string | null;
  readonly details: Record<string, unknown>;
  readonly raisedAt: Date;
  readonly status: 'OPEN' | 'RESOLVED';
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolutionDocumentId: string | null;
  readonly resolutionNote: string | null;
  readonly resolutionKind: ResolutionKind | null;
}

export interface StockExceptionFilters {
  readonly status?: 'OPEN' | 'RESOLVED' | undefined;
  readonly kind?: StockExceptionKind | undefined;
  readonly branchId?: string | undefined;
}

/** Where a page stopped: exceptions are listed newest first. */
export interface ExceptionPosition {
  readonly raisedAt: string;
  readonly id: string;
}

export interface StockExceptionStore {
  exception(tx: Transaction, id: string): Promise<StockExceptionRecord | null>;
  lockException(tx: Transaction, id: string): Promise<StockExceptionRecord | null>;
  /** Newest first, narrowed to the branch of a scope and, for a location-bound scope, its location. */
  exceptions(tx: Transaction, filters: StockExceptionFilters, scopes: readonly ReadScope[], after: ExceptionPosition | null, limit: number): Promise<StockExceptionRecord[]>;
  /** Whether a write-off adjustment of this exception waits for approval. */
  writeOffPending(tx: Transaction, exceptionId: string): Promise<boolean>;
  /** An adjustment's status and the exception it names, to check that it settled this one. */
  adjustmentFor(tx: Transaction, adjustmentId: string): Promise<{ readonly status: string; readonly exceptionId: string | null } | null>;
}
