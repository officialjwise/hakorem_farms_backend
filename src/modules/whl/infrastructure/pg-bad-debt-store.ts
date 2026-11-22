import type { Transaction } from '../../../platform/database/unit-of-work';
import type { BadDebtStore, WriteOffRecord, WriteOffRequestRecord } from '../application/bad-debt-store';

const REQUEST = `id, customer_id, billing_document_id, branch_id, amount_pesewas::text AS amount, reason, approval_request_id, status, created_by, created_at`;
type RawRequest = {
  id: string;
  customer_id: string;
  billing_document_id: string;
  branch_id: string;
  amount: string;
  reason: string;
  approval_request_id: string;
  status: WriteOffRequestRecord['status'];
  created_by: string;
  created_at: Date;
};
const requestOf = (r: RawRequest): WriteOffRequestRecord => ({
  id: r.id,
  customerId: r.customer_id,
  billingDocumentId: r.billing_document_id,
  branchId: r.branch_id,
  amountPesewas: BigInt(r.amount),
  reason: r.reason,
  approvalRequestId: r.approval_request_id,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/** WHL's bad-debt write-offs (migration 0274). Parameterised SQL only. */
export class PgBadDebtStore implements BadDebtStore {
  async insertRequest(tx: Transaction, r: WriteOffRequestRecord): Promise<void> {
    await tx.query(
      `INSERT INTO whl.bad_debt_write_off_request (id, customer_id, billing_document_id, amount_pesewas, reason, approval_request_id, status, branch_id, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9, $10)`,
      [r.id, r.customerId, r.billingDocumentId, r.amountPesewas.toString(), r.reason, r.approvalRequestId, r.status, r.branchId, r.createdAt, r.createdBy],
    );
  }

  async request(tx: Transaction, id: string): Promise<WriteOffRequestRecord | null> {
    const { rows } = await tx.query<RawRequest>(`SELECT ${REQUEST} FROM whl.bad_debt_write_off_request WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : requestOf(rows[0]);
  }

  async requestByApproval(tx: Transaction, approvalRequestId: string): Promise<WriteOffRequestRecord | null> {
    const { rows } = await tx.query<RawRequest>(`SELECT ${REQUEST} FROM whl.bad_debt_write_off_request WHERE approval_request_id = $1 FOR UPDATE`, [approvalRequestId]);
    return rows[0] === undefined ? null : requestOf(rows[0]);
  }

  async pendingFor(tx: Transaction, billingDocumentId: string): Promise<WriteOffRequestRecord | null> {
    const { rows } = await tx.query<RawRequest>(`SELECT ${REQUEST} FROM whl.bad_debt_write_off_request WHERE billing_document_id = $1 AND status = 'PENDING_APPROVAL'`, [billingDocumentId]);
    return rows[0] === undefined ? null : requestOf(rows[0]);
  }

  async decide(tx: Transaction, id: string, d: { readonly status: 'APPLIED' | 'REJECTED' | 'CANCELLED'; readonly by: string; readonly at: Date }): Promise<void> {
    const decided = d.status !== 'CANCELLED';
    await tx.query(
      `UPDATE whl.bad_debt_write_off_request
          SET status = $2, posted_at = CASE WHEN $3 THEN $4::timestamptz END, posted_by = CASE WHEN $3 THEN $5::uuid END, version = version + 1, updated_by = $5
        WHERE id = $1`,
      [id, d.status, decided, d.at, d.by],
    );
  }

  async insertWriteOff(tx: Transaction, w: WriteOffRecord, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO whl.bad_debt_write_off (id, customer_id, billing_document_id, branch_id, amount_pesewas, written_off_on, journal_entry_id, requested_by, approved_by, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11)`,
      [w.id, w.customerId, w.billingDocumentId, w.branchId, w.amountPesewas.toString(), w.writtenOffOn, w.journalEntryId, w.requestedBy, w.approvedBy, w.recordedAt, actorId],
    );
  }

  async writtenOffAsAt(tx: Transaction, billingDocumentIds: readonly string[], asOf: string): Promise<ReadonlyMap<string, bigint>> {
    if (billingDocumentIds.length === 0) return new Map();
    const { rows } = await tx.query<{ billing_document_id: string; amount: string }>(
      'SELECT billing_document_id, sum(amount_pesewas)::text AS amount FROM whl.bad_debt_write_off WHERE billing_document_id = ANY($1::uuid[]) AND written_off_on <= $2::date GROUP BY billing_document_id',
      [billingDocumentIds, asOf],
    );
    return new Map(rows.map((r) => [r.billing_document_id, BigInt(r.amount)]));
  }

  async writtenOffFor(tx: Transaction, customerId: string): Promise<bigint> {
    const { rows } = await tx.query<{ amount: string }>('SELECT COALESCE(sum(amount_pesewas), 0)::text AS amount FROM whl.bad_debt_write_off WHERE customer_id = $1', [customerId]);
    return BigInt(rows[0]!.amount);
  }
}
