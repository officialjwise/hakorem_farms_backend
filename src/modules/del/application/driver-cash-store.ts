import type { Transaction } from '../../../platform/database/unit-of-work';
import type { VarianceDirection } from '../domain/driver-cash';

/** A collection a driver took on delivery (a proof with its cash), handed in or still held. */
export interface CollectionRecord {
  readonly proofId: string;
  readonly paymentId: string;
  readonly deliveryId: string;
  readonly deliveryNo: string;
  readonly recipientName: string;
  readonly amountPesewas: bigint;
  readonly capturedAt: Date;
  readonly branchId: string;
}

export interface ReconciliationRecord {
  readonly id: string;
  readonly driverId: string;
  readonly reconciliationDate: string;
  readonly shiftDocumentId: string;
  readonly tillPaymentId: string | null;
  readonly expectedPesewas: bigint;
  readonly declaredPesewas: bigint;
  readonly variancePesewas: bigint;
  readonly varianceDirection: VarianceDirection;
  readonly receivedBy: string;
  readonly note: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
}

export interface ReconciliationFilter {
  readonly branchIds: readonly string[];
  readonly driverId: string | null;
  /** Africa/Accra calendar dates, inclusive. */
  readonly from: string | null;
  readonly to: string | null;
  readonly varianceOnly: boolean;
}

export const DRIVER_CASH_STORE = Symbol('DRIVER_CASH_STORE');

/** DEL's driver cash tables (`del.driver_cash_reconciliation`, `del.driver_cash_handed_in`, migration 0314). */
export interface DriverCashStore {
  /**
   * The collections of deliveries assigned to the driver that hold cash and were never handed in, oldest first: at one
   * branch, or at every branch when `branchId` is null; up to an instant when `upTo` is set.
   */
  held(tx: Transaction, driverId: string, branchId: string | null, upTo: Date | null): Promise<CollectionRecord[]>;
  /** Each driver holding at least one collection at the branch that was never handed in, with how many (CR-063). */
  holders(tx: Transaction, branchId: string): Promise<{ readonly driverId: string; readonly collections: number }[]>;
  insert(tx: Transaction, r: ReconciliationRecord & { readonly actorId: string; readonly postedAt: Date }): Promise<void>;
  insertHandedIn(tx: Transaction, reconciliationId: string, collections: readonly CollectionRecord[], actorId: string): Promise<void>;
  reconciliations(tx: Transaction, ids: readonly string[]): Promise<ReconciliationRecord[]>;
  /** The collections each reconciliation counted, by reconciliation, oldest first. */
  collectionsOf(tx: Transaction, reconciliationIds: readonly string[]): Promise<Map<string, CollectionRecord[]>>;
  /** Reconciliation ids at the branches, newest first. */
  list(tx: Transaction, f: ReconciliationFilter, beforeId: string | null, limit: number): Promise<string[]>;
}
