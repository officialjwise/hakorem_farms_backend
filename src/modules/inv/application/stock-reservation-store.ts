import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ReadScope } from './stock-documents-store';

export const STOCK_RESERVATION_STORE = Symbol('STOCK_RESERVATION_STORE');

export type ReservationStatus = 'ACTIVE' | 'CONSUMED' | 'RELEASED' | 'EXPIRED';

/** One row of `inv.stock_reservation` (migration 0044). */
export interface StockReservationRecord {
  readonly id: string;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string;
  readonly qty: string;
  readonly isExclusive: boolean;
  readonly holderDocumentId: string;
  readonly status: ReservationStatus;
  readonly expiresAt: Date | null;
  readonly releasedReason: string | null;
  readonly branchId: string;
  readonly createdAt: Date;
}

export interface StockReservationFilters {
  readonly status?: ReservationStatus | undefined;
  readonly productId?: string | undefined;
  readonly holderDocumentId?: string | undefined;
}

export interface StockReservationStore {
  /** Inserts an ACTIVE reservation; the database refuses one above what is available, or of stock not promised. */
  insert(tx: Transaction, r: Omit<StockReservationRecord, 'status' | 'releasedReason' | 'createdAt'>, actorId: string): Promise<void>;
  reservation(tx: Transaction, id: string): Promise<StockReservationRecord | null>;
  lock(tx: Transaction, id: string): Promise<StockReservationRecord | null>;
  /** Oldest first, narrowed to the branch of a scope and, for a location-bound scope, its location. */
  reservations(tx: Transaction, filters: StockReservationFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<StockReservationRecord[]>;
  /** Ends an ACTIVE reservation once, with its reason; the trigger gives its quantity back to available. */
  end(tx: Transaction, id: string, status: 'RELEASED' | 'EXPIRED', reason: string, actorId: string): Promise<void>;
  /**
   * Active reservations whose expiry is at or before `at`, earliest first, locked for this transaction; rows another
   * run has locked are skipped, so two runs never end the same reservation.
   */
  lockDue(tx: Transaction, at: Date, limit: number): Promise<StockReservationRecord[]>;
}
