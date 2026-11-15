import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ApprovalFilter, ApprovalListing, ApprovalRecord, ApprovalStore, ApproverRule } from '../application/approvals';
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
  evidence_file_id: string | null;
  version: number;
}

interface ListingRow extends ApprovalRow {
  requested_by_name: string;
  decided_by_name: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
}

/** A current, branch-wide grant of an active principal ($1) at time $2, as alias g joined to its role r. */
const CURRENT_BRANCH_GRANT = `g.principal_id = $1 AND g.deleted_at IS NULL AND g.valid_from <= $2 AND (g.valid_to IS NULL OR g.valid_to > $2)
  AND g.location_id IS NULL AND r.deleted_at IS NULL AND p.status = 'ACTIVE'`;

/** The branches where the viewer ($1) holds `iam.approval.read` through a branch-wide grant now ($2). */
const BRANCHES_READABLE_BY_VIEWER = `SELECT g.branch_id
    FROM iam.role_grant g JOIN iam.role r ON r.id = g.role_id JOIN iam.principal p ON p.id = g.principal_id
    JOIN iam.role_permission rp ON rp.role_id = r.id AND rp.deleted_at IS NULL AND rp.permission_code = 'iam.approval.read'
   WHERE ${CURRENT_BRANCH_GRANT}`;

/**
 * Request a (alias) is pending, unlapsed at $2, made by someone other than the viewer $1, and a current branch-wide
 * grant of the viewer's holds the permission its kind's policy names at its branch (the branch policy, else the
 * farm-wide one).
 */
const DECIDABLE_BY_VIEWER = `(a.status = 'PENDING' AND (a.expires_at IS NULL OR a.expires_at > $2) AND a.requested_by <> $1
  AND EXISTS (
    SELECT 1
      FROM (SELECT ap.approver_permission FROM iam.approval_policy ap
             WHERE ap.kind = a.kind AND (ap.branch_id = a.branch_id OR ap.branch_id IS NULL) AND ap.deleted_at IS NULL
             ORDER BY ap.branch_id NULLS LAST LIMIT 1) policy
      JOIN iam.role_permission rp ON rp.permission_code = policy.approver_permission AND rp.deleted_at IS NULL
      JOIN iam.role r ON r.id = rp.role_id
      JOIN iam.role_grant g ON g.role_id = r.id AND g.branch_id = a.branch_id
      JOIN iam.principal p ON p.id = g.principal_id
     WHERE ${CURRENT_BRANCH_GRANT}))`;

const LISTING_SELECT = `
  SELECT a.id, a.kind, a.branch_id, a.subject_document_id, a.payload_hash, a.amount_pesewas::text, a.summary, a.requested_by, a.requested_at,
         a.status, a.decided_by, a.expires_at, a.evidence_file_id, a.version, a.decided_at, a.decision_reason,
         rb.display_name AS requested_by_name, db.display_name AS decided_by_name
    FROM iam.approval_request a
    JOIN iam.principal rb ON rb.id = a.requested_by
    LEFT JOIN iam.principal db ON db.id = a.decided_by`;

function record(row: ApprovalRow): ApprovalRecord {
  return {
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
    evidenceFileId: row.evidence_file_id,
    version: row.version,
  };
}

function listing(row: ListingRow): ApprovalListing {
  return { ...record(row), requestedByName: row.requested_by_name, decidedByName: row.decided_by_name, decidedAt: row.decided_at, decisionReason: row.decision_reason };
}

/** `iam.approval_request` and `iam.approval_policy` (ADR-0017). */
export class PgApprovalStore implements ApprovalStore {
  async insert(tx: Transaction, record: ApprovalRecord): Promise<void> {
    await tx.query(
      `INSERT INTO iam.approval_request (id, kind, branch_id, subject_document_id, payload_hash, amount_pesewas, summary, requested_by,
                                         requested_at, status, expires_at, evidence_file_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', $10, $11)`,
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
        record.evidenceFileId,
      ],
    );
  }

  async byIdForUpdate(tx: Transaction, id: string): Promise<ApprovalRecord | null> {
    const { rows } = await tx.query<ApprovalRow>(
      `SELECT id, kind, branch_id, subject_document_id, payload_hash, amount_pesewas::text, summary, requested_by, requested_at, status,
              decided_by, expires_at, evidence_file_id, version
         FROM iam.approval_request WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] === undefined ? null : record(rows[0]);
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

  async approverRule(tx: Transaction, kind: string, branchId: string): Promise<ApproverRule | null> {
    const { rows } = await tx.query<{ approver_permission: string; requires_step_up: boolean }>(
      `SELECT approver_permission, requires_step_up FROM iam.approval_policy
        WHERE kind = $1 AND (branch_id = $2 OR branch_id IS NULL) AND deleted_at IS NULL
        ORDER BY branch_id NULLS LAST LIMIT 1`,
      [kind, branchId],
    );
    const row = rows[0];
    return row === undefined ? null : { permission: row.approver_permission, requiresStepUp: row.requires_step_up };
  }

  async list(tx: Transaction, filter: ApprovalFilter): Promise<ApprovalListing[]> {
    const { rows } = await tx.query<ListingRow>(
      `${LISTING_SELECT}
        WHERE a.branch_id IN (${BRANCHES_READABLE_BY_VIEWER})
          AND ($3::text IS NULL
               OR ($3 = 'PENDING' AND a.status = 'PENDING' AND (a.expires_at IS NULL OR a.expires_at > $2))
               OR ($3 = 'EXPIRED' AND (a.status = 'EXPIRED' OR (a.status = 'PENDING' AND a.expires_at <= $2)))
               OR ($3 NOT IN ('PENDING', 'EXPIRED') AND a.status = $3))
          AND ($4::text IS NULL OR a.kind = $4)
          AND (NOT $5::boolean OR ${DECIDABLE_BY_VIEWER})
          AND (NOT $6::boolean OR a.requested_by = $1)
          AND ($7::uuid IS NULL OR a.id < $7)
        ORDER BY a.id DESC
        LIMIT $8`,
      [filter.viewerId, filter.now, filter.status, filter.kind, filter.decidableByMe, filter.requestedByMe, filter.beforeId, filter.limit],
    );
    return rows.map(listing);
  }

  async listing(tx: Transaction, id: string): Promise<ApprovalListing | null> {
    const { rows } = await tx.query<ListingRow>(`${LISTING_SELECT} WHERE a.id = $1`, [id]);
    return rows[0] === undefined ? null : listing(rows[0]);
  }

  async decidableBy(tx: Transaction, viewerId: string, ids: readonly string[], now: Date): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { rows } = await tx.query<{ id: string }>(`SELECT a.id FROM iam.approval_request a WHERE a.id = ANY($3::uuid[]) AND ${DECIDABLE_BY_VIEWER}`, [viewerId, now, ids]);
    return new Set(rows.map((row) => row.id));
  }
}
