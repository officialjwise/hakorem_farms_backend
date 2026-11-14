import type { Transaction } from '../../../platform/database/unit-of-work';
import type { PrincipalNames, PrincipalRef } from '../application/principal-names';

export class PgPrincipalNames implements PrincipalNames {
  async refs(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, PrincipalRef>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return new Map();
    }
    const { rows } = await tx.query<{ id: string; display_name: string }>('SELECT id, display_name FROM iam.principal WHERE id = ANY($1::uuid[])', [unique]);
    return new Map(rows.map((row) => [row.id, { id: row.id, displayName: row.display_name }]));
  }
}
