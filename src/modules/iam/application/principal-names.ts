import type { Transaction } from '../../../platform/database/unit-of-work';

/** A principal as another module shows it: the contract's `PrincipalRef`. */
export interface PrincipalRef {
  readonly id: string;
  readonly displayName: string;
}

/**
 * The display names of principals, for modules that show who made or approved something (a price list version's
 * `createdBy`, `activatedBy`). Higher modules ask here rather than joining `iam.principal` (MODULE_BOUNDARIES 7).
 */
export interface PrincipalNames {
  /** Every id asked for that exists, by id. */
  refs(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, PrincipalRef>>;
}

export const PRINCIPAL_NAMES = Symbol('PRINCIPAL_NAMES');
