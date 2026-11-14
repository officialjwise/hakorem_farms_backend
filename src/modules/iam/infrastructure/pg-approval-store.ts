import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ApprovalRecord, ApprovalStore } from '../application/approvals';
import type { ApprovalStatus } from '../domain/approval';

interface ApprovalRow {
  id: string;
  kind: string;
  branch_id: string;
  subject_document_id: string;
  payload_hash: Buffer;
  amount_pesewas: string | null;
  summary: string;
  requested_by: string;
  requested_at: Date;
  status: ApprovalStatus;
  decided_by: string | null;
  expires_at: Date | null;
  version: number;
}

/** `iam.approval_request` and `iam.approval_policy` (ADR-0017). */
export class PgApprovalStore implements ApprovalStore {
  async insert(tx: Transaction, record: ApprovalRecord): Promise<void> {
    await tx.query(
      `INSERT INTO iam.approval_request (id, kind, branch_id, subject_document_id, payload_hash, amount_pesewas, summary, requested_by,
                                         requested_at, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', $10)`,
      [
        record.id,
        record.kind,
        record.branchId,
        record.subjectDocumentId,
        Buffer.from(record.payloadHash, 'hex'),
        record.amountPesewas === null ? null : record.amountPesewas.toString(),
        record.summary,
        record.requestedBy,
        record.requestedAt,
        record.expiresAt,
      ],
    );
  }

  async byIdForUpdate(tx: Transaction, id: string): Promise<ApprovalRecord | null> {
    const { rows } = await tx.query<ApprovalRow>(
      `SELECT id, kind, branch_id, subject_document_id, payload_hash, amount_pesewas::text, summary, requested_by, requested_at, status,
              decided_by, expires_at, version
         FROM iam.approval_request WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          kind: row.kind,
          branchId: row.branch_id,
          subjectDocumentId: row.subject_document_id,
          payloadHash: row.payload_hash.toString('hex'),
          amountPesewas: row.amount_pesewas === null ? null : BigInt(row.amount_pesewas),
          summary: row.summary,
          requestedBy: row.requested_by,
          requestedAt: row.requested_at,
          status: row.status,
          decidedBy: row.decided_by,
          expiresAt: row.expires_at,
          version: row.version,
        };
  }

  async decide(tx: Transaction, id: string, status: ApprovalStatus, decidedBy: string | null, reason: string | null, now: Date): Promise<void> {
    await tx.query(
      `UPDATE iam.approval_request
          SET status = $2, decided_by = $3, decided_at = CASE WHEN $3::uuid IS NULL THEN NULL ELSE $5::timestamptz END,
              decision_reason = $4, version = version + 1
        WHERE id = $1 AND status = 'PENDING'`,
      [id, status, decidedBy, reason, now],
    );
  }

  async approverPermission(tx: Transaction, kind: string, branchId: string): Promise<string | null> {
    const { rows } = await tx.query<{ approver_permission: string }>(
      `SELECT approver_permission FROM iam.approval_policy
        WHERE kind = $1 AND (branch_id = $2 OR branch_id IS NULL) AND deleted_at IS NULL
        ORDER BY branch_id NULLS LAST LIMIT 1`,
      [kind, branchId],
    );
    return rows[0]?.approver_permission ?? null;
  }
}
