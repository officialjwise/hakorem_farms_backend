import type { Transaction } from '../../../platform/database/unit-of-work';
import type { LocationKind, TempClass } from '../domain/locations';
import type { RowState } from './admin-kit';

export type BranchStatus = 'ACTIVE' | 'CLOSED';

/** The contract's `Branch`. */
export interface BranchView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly address: string | null;
  readonly phone: string | null;
  readonly isTest: boolean;
  readonly status: BranchStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The contract's `Location`. Temperatures are Celsius strings to one place. */
export interface LocationView {
  readonly id: string;
  readonly branch: { readonly id: string; readonly code: string; readonly name: string };
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly kind: LocationKind;
  readonly isVirtual: boolean;
  readonly isSellable: boolean;
  readonly allowsNegative: boolean;
  readonly tempClass: TempClass | null;
  readonly tempMinC: string | null;
  readonly tempMaxC: string | null;
  readonly capacityHead: number | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BranchWrite {
  readonly code: string;
  readonly name: string;
  readonly address: string | null;
  readonly phone: string | null;
  readonly isTest: boolean;
}

export interface LocationWrite {
  readonly branchId: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly kind: LocationKind;
  readonly isVirtual: boolean;
  readonly isSellable: boolean;
  readonly allowsNegative: boolean;
  readonly tempClass: TempClass | null;
  readonly tempMinC: string | null;
  readonly tempMaxC: string | null;
  readonly capacityHead: number | null;
}

export interface LocationFilters {
  readonly branchId?: string | undefined;
  readonly kind?: LocationKind | undefined;
  readonly parentId?: string | undefined;
  readonly includeVirtual: boolean;
}

/** Where one grant reaches: a branch, and optionally one location of it. */
export interface LocationScope {
  readonly branchId: string;
  readonly locationId: string | null;
}

/** MDM's branch and location tables, each call in the caller's transaction. Lists are live rows in creation order. */
export interface LocationsStore {
  branchCount(tx: Transaction): Promise<number>;
  lockBranch(tx: Transaction, id: string): Promise<RowState | null>;
  branch(tx: Transaction, id: string): Promise<BranchView | null>;
  /** Live branches among `within`, in id order. */
  branches(tx: Transaction, within: readonly string[], afterId: string | null, limit: number): Promise<BranchView[]>;
  /** The farm's own branch: the first ever created, which the bootstrap writes (ADR-0042); null on an empty table. */
  farmBranchId(tx: Transaction): Promise<string | null>;
  /** Live ACTIVE branches other than this one, the smoke-test branch left out. */
  otherActiveTradingBranches(tx: Transaction, id: string): Promise<number>;
  branchCodeTaken(tx: Transaction, code: string): Promise<boolean>;
  insertBranch(tx: Transaction, id: string, write: BranchWrite, actorId: string): Promise<void>;
  updateBranch(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean>;

  lockLocation(tx: Transaction, id: string): Promise<RowState | null>;
  location(tx: Transaction, id: string): Promise<LocationView | null>;
  /**
   * Live locations the grants reach (a grant with no location reaches its whole branch), in id order; `null` for an
   * in-process caller that authorised the whole set already (an export).
   */
  locations(tx: Transaction, filters: LocationFilters, scopes: readonly LocationScope[] | null, afterId: string | null, limit: number): Promise<LocationView[]>;
  locationCodeTaken(tx: Transaction, branchId: string, code: string): Promise<boolean>;
  insertLocation(tx: Transaction, id: string, write: LocationWrite, actorId: string): Promise<void>;
  updateLocation(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean>;
  archiveLocation(tx: Transaction, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean>;
  liveChildren(tx: Transaction, id: string): Promise<number>;
  /** Whether `candidateId` is `id` or a live location anywhere below it. */
  isSelfOrBelow(tx: Transaction, id: string, candidateId: string): Promise<boolean>;
}

export const LOCATIONS_STORE = Symbol('LOCATIONS_STORE');
