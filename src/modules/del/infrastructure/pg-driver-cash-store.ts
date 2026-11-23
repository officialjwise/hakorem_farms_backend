import type { Transaction } from '../../../platform/database/unit-of-work';
import type { CollectionRecord, DriverCashStore, ReconciliationFilter, ReconciliationRecord } from '../application/driver-cash-store';
import type { VarianceDirection } from '../domain/driver-cash';

interface CollectionRow {
  proof_id: string;
  payment_id: string;
  delivery_id: string;
  delivery_no: string;
  recipient_name: string;
  amount: string;
  captured_at: Date;
  branch_id: string;
}

interface ReconciliationRow {
  id: string;
  driver_id: string;
  reconciliation_date: string;
  shift_document_id: string;
  till_payment_id: string | null;
  expected: string;
  declared: string;
  variance: string;
  variance_direction: VarianceDirection;
  received_by: string;
  note: string | null;
  branch_id: string;
  version: number;
  created_at: Date;
}

const COLLECTION_COLUMNS = `p.id AS proof_id, p.payment_id, d.id AS delivery_id, d.delivery_no, d.recipient_name, p.cod_collected_pesewas::text AS amount, p.captured_at, d.branch_id`;
const RECONCILIATION_COLUMNS = `id, driver_id, reconciliation_date::text, shift_document_id, till_payment_id, expected_pesewas::text AS expected, declared_pesewas::text AS declared,
  variance_pesewas::text AS variance, variance_direction, received_by, note, branch_id, version, created_at`;

const toCollection = (r: CollectionRow): CollectionRecord => ({
  proofId: r.proof_id,
  paymentId: r.payment_id,
  deliveryId: r.delivery_id,
  deliveryNo: r.delivery_no,
  recipientName: r.recipient_name,
  amountPesewas: BigInt(r.amount),
  capturedAt: r.captured_at,
  branchId: r.branch_id,
});

const toReconciliation = (r: ReconciliationRow): ReconciliationRecord => ({
  id: r.id,
  driverId: r.driver_id,
  reconciliationDate: r.reconciliation_date,
  shiftDocumentId: r.shift_document_id,
  tillPaymentId: r.till_payment_id,
  expectedPesewas: BigInt(r.expected),
  declaredPesewas: BigInt(r.declared),
  variancePesewas: BigInt(r.variance),
  varianceDirection: r.variance_direction,
  receivedBy: r.received_by,
  note: r.note,
  branchId: r.branch_id,
  version: r.version,
  createdAt: r.created_at,
});

export class PgDriverCashStore implements DriverCashStore {
  async held(tx: Transaction, driverId: string, branchId: string | null, upTo: Date | null): Promise<CollectionRecord[]> {
    const { rows } = await tx.query<CollectionRow>(
      `SELECT ${COLLECTION_COLUMNS}
         FROM del.delivery d JOIN del.proof_of_delivery p ON p.delivery_id = d.id
        WHERE d.driver_id = $1 AND d.status = 'DELIVERED' AND p.payment_id IS NOT NULL
          AND ($2::uuid IS NULL OR d.branch_id = $2) AND ($3::timestamptz IS NULL OR p.captured_at <= $3)
          AND NOT EXISTS (SELECT 1 FROM del.driver_cash_handed_in h WHERE h.proof_id = p.id)
        ORDER BY p.captured_at, p.id`,
      [driverId, branchId, upTo],
    );
    return rows.map(toCollection);
  }

  async holders(tx: Transaction, branchId: string): Promise<{ readonly driverId: string; readonly collections: number }[]> {
    const { rows } = await tx.query<{ driver_id: string; n: string }>(
      `SELECT d.driver_id, count(*)::text AS n
         FROM del.delivery d JOIN del.proof_of_delivery p ON p.delivery_id = d.id
        WHERE d.branch_id = $1 AND d.status = 'DELIVERED' AND p.payment_id IS NOT NULL AND d.driver_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM del.driver_cash_handed_in h WHERE h.proof_id = p.id)
        GROUP BY d.driver_id
        ORDER BY d.driver_id`,
      [branchId],
    );
    return rows.map((r) => ({ driverId: r.driver_id, collections: Number(r.n) }));
  }

  async insert(tx: Transaction, r: ReconciliationRecord & { readonly actorId: string; readonly postedAt: Date }): Promise<void> {
    await tx.query(
      `INSERT INTO del.driver_cash_reconciliation (id, driver_id, reconciliation_date, shift_document_id, till_payment_id, expected_pesewas, declared_pesewas, variance_pesewas,
                                                   variance_direction, received_by, note, status, branch_id, created_at, created_by, updated_at, updated_by, posted_at, posted_by)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, 'POSTED', $12, $14, $13, $14, $13, $14, $13)`,
      [
        r.id,
        r.driverId,
        r.reconciliationDate,
        r.shiftDocumentId,
        r.tillPaymentId,
        r.expectedPesewas.toString(),
        r.declaredPesewas.toString(),
        r.variancePesewas.toString(),
        r.varianceDirection,
        r.receivedBy,
        r.note,
        r.branchId,
        r.actorId,
        r.postedAt,
      ],
    );
  }

  async insertHandedIn(tx: Transaction, reconciliationId: string, collections: readonly CollectionRecord[], actorId: string): Promise<void> {
    if (collections.length === 0) return;
    await tx.query(
      `INSERT INTO del.driver_cash_handed_in (reconciliation_id, proof_id, amount_pesewas, actor_id)
       SELECT $1, c.proof_id, c.amount, $4 FROM unnest($2::uuid[], $3::bigint[]) AS c (proof_id, amount)`,
      [reconciliationId, collections.map((c) => c.proofId), collections.map((c) => c.amountPesewas.toString()), actorId],
    );
  }

  async reconciliations(tx: Transaction, ids: readonly string[]): Promise<ReconciliationRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<ReconciliationRow>(`SELECT ${RECONCILIATION_COLUMNS} FROM del.driver_cash_reconciliation WHERE id = ANY($1::uuid[]) ORDER BY id DESC`, [[...ids]]);
    return rows.map(toReconciliation);
  }

  async collectionsOf(tx: Transaction, reconciliationIds: readonly string[]): Promise<Map<string, CollectionRecord[]>> {
    const found = new Map<string, CollectionRecord[]>(reconciliationIds.map((id) => [id, []]));
    if (reconciliationIds.length === 0) return found;
    const { rows } = await tx.query<CollectionRow & { reconciliation_id: string }>(
      `SELECT h.reconciliation_id, ${COLLECTION_COLUMNS}
         FROM del.driver_cash_handed_in h JOIN del.proof_of_delivery p ON p.id = h.proof_id JOIN del.delivery d ON d.id = p.delivery_id
        WHERE h.reconciliation_id = ANY($1::uuid[])
        ORDER BY p.captured_at, p.id`,
      [[...reconciliationIds]],
    );
    for (const row of rows) found.get(row.reconciliation_id)!.push(toCollection(row));
    return found;
  }

  async list(tx: Transaction, f: ReconciliationFilter, beforeId: string | null, limit: number): Promise<string[]> {
    if (f.branchIds.length === 0) return [];
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM del.driver_cash_reconciliation
        WHERE branch_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR driver_id = $2) AND ($3::date IS NULL OR reconciliation_date >= $3)
          AND ($4::date IS NULL OR reconciliation_date <= $4) AND (NOT $5::boolean OR variance_direction <> 'EXACT') AND ($6::uuid IS NULL OR id < $6)
        ORDER BY id DESC LIMIT $7`,
      [[...f.branchIds], f.driverId, f.from, f.to, f.varianceOnly, beforeId, limit],
    );
    return rows.map((r) => r.id);
  }
}
