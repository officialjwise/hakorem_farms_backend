import type { Transaction } from '../../../platform/database/unit-of-work';
import type { HoldKind } from '../domain/stock-hold';
import type { ReadScope } from './stock-documents-store';

export const STOCK_HOLD_STORE = Symbol('STOCK_HOLD_STORE');

export interface StockHoldRecord {
  readonly id: string;
  readonly stockUnitId: string;
  readonly kind: HoldKind;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly sourceDocumentId: string;
  readonly note: string | null;
  readonly releasedAt: Date | null;
  readonly releasedBy: string | null;
  readonly releaseReasonCode: string | null;
  readonly releaseNote: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export interface StockHoldFilters {
  /** True: in force now; false: released, ended or not yet begun. */
  readonly active?: boolean | undefined;
  readonly kind?: HoldKind | undefined;
  readonly stockUnitId?: string | undefined;
}

export interface NewStockHold {
  readonly id: string;
  readonly stockUnitId: string;
  readonly kind: HoldKind;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly sourceDocumentId: string;
  readonly note: string | null;
}

/** INV's hold table (migrations 0044 and 0057), in the caller's transaction. */
export interface StockHoldStore {
  insertHold(tx: Transaction, hold: NewStockHold, actorId: string): Promise<void>;
  hold(tx: Transaction, id: string): Promise<StockHoldRecord | null>;
  lockHold(tx: Transaction, id: string): Promise<StockHoldRecord | null>;
  /**
   * Oldest first; `afterId` continues a page. Narrowed to holds on units of a branch a scope reaches and, for a scope
   * with a location, units that are there now (an animal where it stands, a lot with stock there).
   */
  holds(tx: Transaction, filters: StockHoldFilters, at: Date, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<StockHoldRecord[]>;
  release(tx: Transaction, id: string, release: { readonly at: Date; readonly reasonCode: string; readonly note: string }, actorId: string): Promise<void>;
}
