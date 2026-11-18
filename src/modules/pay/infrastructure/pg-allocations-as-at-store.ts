import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AllocationsAsAtStore } from '../application/allocations-as-at';

/** `pay.payment_allocation` summed by document as at a business day (migration 0262: `allocated_on`, else the Accra day of `recorded_at`). */
export class PgAllocationsAsAtStore implements AllocationsAsAtStore {
  async netAppliedAsAt(tx: Transaction, billingDocumentIds: readonly string[], asOf: string): Promise<ReadonlyMap<string, bigint>> {
    const { rows } = await tx.query<{ billing_document_id: string; net: string }>(
      `SELECT a.billing_document_id, sum(CASE a.direction WHEN 'APPLY' THEN a.amount_pesewas ELSE -a.amount_pesewas END)::text AS net
         FROM pay.payment_allocation a
        WHERE a.billing_document_id = ANY($1::uuid[])
          AND COALESCE(a.allocated_on, (a.recorded_at AT TIME ZONE 'Africa/Accra')::date) <= $2::date
        GROUP BY a.billing_document_id`,
      [billingDocumentIds, asOf],
    );
    return new Map(rows.map((r) => [r.billing_document_id, BigInt(r.net)]));
  }
}
