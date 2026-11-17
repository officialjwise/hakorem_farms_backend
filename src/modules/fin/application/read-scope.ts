import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { Authoriser } from '../../iam';

/**
 * The branches whose ledger records a reader may see (ADR-0017 rule 2, the owner's decision 5 of 2026-11-17): every
 * branch where a whole-branch grant holds the read permission. A journal entry, a manual journal, a fixed asset and a
 * depreciation run each belong to one branch, so a holder at another branch reads none of them by its id or in a list.
 * Called after `authorise`, which has already refused a reader holding the permission nowhere.
 */
export async function readableBranches(authoriser: Authoriser, tx: Transaction, actor: Actor, permission: string): Promise<readonly string[]> {
  return [...new Set((await authoriser.scopes(tx, actor, permission)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
}
