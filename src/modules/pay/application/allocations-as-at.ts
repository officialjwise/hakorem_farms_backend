import type { Transaction } from '../../../platform/database/unit-of-work';

/** What a set of billing documents had applied to them, net of allocations taken off, by the end of a business day. */
export interface AllocationsAsAtStore {
  netAppliedAsAt(tx: Transaction, billingDocumentIds: readonly string[], asOf: string): Promise<ReadonlyMap<string, bigint>>;
}

export const ALLOCATIONS_AS_AT_STORE = Symbol('ALLOCATIONS_AS_AT_STORE');

/**
 * PAY's allocations as at a date (FR-WHL-010, ADR-0089): for each billing document, what payments applied to it less
 * what was taken off again, counting only allocations whose business day (`allocated_on`, migration 0264) is on or
 * before `asOf`. A reversed or bounced payment has taken its allocations off, so it reopens the document from the day
 * of the reversal. Read in the caller's transaction; it authorises nothing (WHL's ageing has). A document with no
 * allocation is absent.
 */
export class AllocationsAsAt {
  constructor(private readonly store: AllocationsAsAtStore) {}

  netAppliedIn(tx: Transaction, billingDocumentIds: readonly string[], asOf: string): Promise<ReadonlyMap<string, bigint>> {
    if (billingDocumentIds.length === 0) return Promise.resolve(new Map());
    return this.store.netAppliedAsAt(tx, billingDocumentIds, asOf);
  }
}
