import { and, inArray, isNull } from 'drizzle-orm';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ScopeNames } from '../../iam';
import { branch, location } from './tables';

/** MDM's answer to IAM's ScopeNames port: the codes of branches and locations a session's grants name (ADR-0033). */
export class MdmScopeNames implements ScopeNames {
  async codes(
    tx: Transaction,
    branchIds: readonly string[],
    locationIds: readonly string[],
  ): Promise<{ branches: ReadonlyMap<string, string>; locations: ReadonlyMap<string, string> }> {
    const branches =
      branchIds.length === 0
        ? []
        : await tx.db.select({ id: branch.id, code: branch.code }).from(branch).where(and(inArray(branch.id, [...branchIds]), isNull(branch.deletedAt)));
    const locations =
      locationIds.length === 0
        ? []
        : await tx.db
            .select({ id: location.id, code: location.code })
            .from(location)
            .where(and(inArray(location.id, [...locationIds]), isNull(location.deletedAt)));
    return { branches: new Map(branches.map((row) => [row.id, row.code])), locations: new Map(locations.map((row) => [row.id, row.code])) };
  }
}
