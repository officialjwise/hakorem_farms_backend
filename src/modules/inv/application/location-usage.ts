import type { Transaction } from '../../../platform/database/unit-of-work';
import type { LocationUsageCheck, PlaceUsage } from '../../mdm';

/** INV's own tables and its published view, asked whether a branch or a location is in use. */
export interface InventoryUsageStore {
  branchUsage(tx: Transaction, branchId: string): Promise<PlaceUsage>;
  locationUsage(tx: Transaction, locationId: string): Promise<PlaceUsage>;
}

export const INVENTORY_USAGE_STORE = Symbol('INVENTORY_USAGE_STORE');

/**
 * INV's answer to MDM's `LocationUsageCheck` (ADR-0051), registered when INV starts: a branch or location holds
 * stock while any balance there is not zero (in transit included, below zero included), and the open INV documents
 * naming it are the draft goods receipts, the transfers not yet received or cancelled, the adjustments, reversals and
 * stock takes not yet decided, and the open stock exceptions. Read in the caller's transaction; nothing is written.
 */
export class InventoryLocationUsage implements LocationUsageCheck {
  constructor(private readonly store: InventoryUsageStore) {}

  branchUsage(tx: Transaction, branchId: string): Promise<PlaceUsage> {
    return this.store.branchUsage(tx, branchId);
  }

  locationUsage(tx: Transaction, locationId: string): Promise<PlaceUsage> {
    return this.store.locationUsage(tx, locationId);
  }
}
