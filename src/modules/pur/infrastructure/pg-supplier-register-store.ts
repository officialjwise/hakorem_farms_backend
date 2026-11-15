import type { Transaction } from '../../../platform/database/unit-of-work';
import type { PayoutMethod } from '../domain/payout-details';
import type { RequisitionStatus } from '../domain/requisition';
import type { ReadScope } from '../application/purchasing-store';
import type {
  NewPayoutChange,
  PayoutChangeRecord,
  PayoutChangeStatus,
  ProfileRecord,
  ProfileTerms,
  RequisitionFilter,
  RequisitionHeader,
  RequisitionLineRecord,
  RequisitionRecord,
  SupplierDocumentKind,
  SupplierDocumentRecord,
  SupplierRegisterStore,
} from '../application/supplier-register-store';

interface ProfileRow {
  supplier_id: string;
  payment_terms_days: number;
  lead_time_days: number | null;
  notes: string | null;
  payout_change_id: string | null;
  version: number;
  updated_at: Date;
}

interface ChangeRow {
  id: string;
  supplier_id: string;
  payout_method: PayoutMethod;
  payout_details_enc: Buffer | null;
  payout_masked: string;
  payment_terms_days: number | null;
  lead_time_days: number | null;
  notes: string | null;
  approval_request_id: string;
  status: PayoutChangeStatus;
  branch_id: string;
  created_at: Date;
  created_by: string;
}

interface DocumentRow {
  id: string;
  supplier_id: string;
  kind: SupplierDocumentKind;
  file_id: string;
  expires_on: string | null;
  created_at: Date;
}

interface RequisitionRow {
  id: string;
  requisition_no: string | null;
  status: RequisitionStatus;
  requested_by: string;
  location_id: string | null;
  needed_by: string | null;
  justification: string | null;
  purchase_order_id: string | null;
  reject_reason: string | null;
  branch_id: string;
  version: number;
  created_at: Date;
  created_by: string;
}

interface RequisitionLineRow {
  id: string;
  requisition_id: string;
  line_no: number;
  product_id: string;
  qty: string;
  note: string | null;
}

const CHANGE_COLUMNS = `id, supplier_id, payout_method, payout_details_enc, payout_masked, payment_terms_days, lead_time_days, notes,
  approval_request_id, status, branch_id, created_at, created_by`;
const DOCUMENT_COLUMNS = 'id, supplier_id, kind, file_id, expires_on::text AS expires_on, created_at';
const REQUISITION_COLUMNS = `r.id, r.requisition_no, r.status, r.requested_by, r.location_id, r.needed_by::text AS needed_by, r.justification,
  r.purchase_order_id, r.reject_reason, r.branch_id, r.version, r.created_at, r.created_by`;

const optional = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

function change(row: ChangeRow): PayoutChangeRecord {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    method: row.payout_method,
    detailsEnc: row.payout_details_enc,
    masked: row.payout_masked,
    terms: { paymentTermsDays: optional(row.payment_terms_days), leadTimeDays: optional(row.lead_time_days), notes: optional(row.notes) },
    approvalRequestId: row.approval_request_id,
    status: row.status,
    branchId: row.branch_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function document(row: DocumentRow): SupplierDocumentRecord {
  return { id: row.id, supplierId: row.supplier_id, kind: row.kind, fileId: row.file_id, expiresOn: row.expires_on, createdAt: row.created_at };
}

/** PostgreSQL implementation of PUR's supplier register and requisitions. Parameterised SQL only. */
export class PgSupplierRegisterStore implements SupplierRegisterStore {
  async profile(tx: Transaction, supplierId: string, lock: boolean): Promise<ProfileRecord | null> {
    const { rows } = await tx.query<ProfileRow>(
      `SELECT supplier_id, payment_terms_days, lead_time_days, notes, payout_change_id, version, updated_at
         FROM pur.supplier_profile WHERE supplier_id = $1 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
      [supplierId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      supplierId: row.supplier_id,
      paymentTermsDays: row.payment_terms_days,
      leadTimeDays: row.lead_time_days,
      notes: row.notes,
      payoutChangeId: row.payout_change_id,
      version: row.version,
      updatedAt: row.updated_at,
    };
  }

  async openProfile(tx: Transaction, supplierId: string, actorId: string): Promise<void> {
    await tx.query('INSERT INTO pur.supplier_profile (supplier_id, created_by, updated_by) VALUES ($1, $2, $2) ON CONFLICT (supplier_id) DO NOTHING', [supplierId, actorId]);
  }

  async updateTerms(tx: Transaction, supplierId: string, terms: ProfileTerms, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE pur.supplier_profile
          SET payment_terms_days = COALESCE($2, payment_terms_days), lead_time_days = COALESCE($3, lead_time_days), notes = COALESCE($4, notes),
              updated_by = $5, updated_at = now(), version = version + 1
        WHERE supplier_id = $1`,
      [supplierId, terms.paymentTermsDays ?? null, terms.leadTimeDays ?? null, terms.notes ?? null, actorId],
    );
  }

  async putPayoutInForce(tx: Transaction, supplierId: string, payoutChangeId: string, actorId: string): Promise<void> {
    await tx.query('UPDATE pur.supplier_profile SET payout_change_id = $2, updated_by = $3, updated_at = now(), version = version + 1 WHERE supplier_id = $1', [supplierId, payoutChangeId, actorId]);
  }

  async payoutChange(tx: Transaction, id: string, lock: boolean): Promise<PayoutChangeRecord | null> {
    const { rows } = await tx.query<ChangeRow>(`SELECT ${CHANGE_COLUMNS} FROM pur.supplier_payout_change WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : change(rows[0]);
  }

  async pendingPayoutChange(tx: Transaction, supplierId: string): Promise<PayoutChangeRecord | null> {
    const { rows } = await tx.query<ChangeRow>(`SELECT ${CHANGE_COLUMNS} FROM pur.supplier_payout_change WHERE supplier_id = $1 AND status = 'PENDING_APPROVAL'`, [supplierId]);
    return rows[0] === undefined ? null : change(rows[0]);
  }

  async insertPayoutChange(tx: Transaction, record: NewPayoutChange): Promise<void> {
    await tx.query(
      `INSERT INTO pur.supplier_payout_change (id, supplier_id, payout_method, payout_details_enc, payout_masked, payment_terms_days, lead_time_days, notes,
         approval_request_id, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_APPROVAL', $10, $11, $11)`,
      [
        record.id,
        record.supplierId,
        record.method,
        record.detailsEnc,
        record.masked,
        record.terms.paymentTermsDays ?? null,
        record.terms.leadTimeDays ?? null,
        record.terms.notes ?? null,
        record.approvalRequestId,
        record.branchId,
        record.createdBy,
      ],
    );
  }

  async decidePayoutChange(tx: Transaction, id: string, status: Exclude<PayoutChangeStatus, 'PENDING_APPROVAL'>, reason: string | null, decidedBy: string): Promise<void> {
    await tx.query(
      `UPDATE pur.supplier_payout_change SET status = $2, decision_reason = $3, posted_at = now(), posted_by = $4, updated_by = $4, updated_at = now(), version = version + 1 WHERE id = $1`,
      [id, status, reason, decidedBy],
    );
  }

  async documents(tx: Transaction, supplierId: string, beforeId: string | null, limit: number): Promise<SupplierDocumentRecord[]> {
    const { rows } = await tx.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM pur.supplier_document
        WHERE supplier_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
      [supplierId, beforeId, limit],
    );
    return rows.map(document);
  }

  async documentOfFile(tx: Transaction, fileId: string): Promise<SupplierDocumentRecord | null> {
    const { rows } = await tx.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM pur.supplier_document WHERE file_id = $1 AND deleted_at IS NULL`, [fileId]);
    return rows[0] === undefined ? null : document(rows[0]);
  }

  async insertDocument(tx: Transaction, record: Omit<SupplierDocumentRecord, 'createdAt'>, actorId: string): Promise<void> {
    await tx.query(
      'INSERT INTO pur.supplier_document (id, supplier_id, kind, file_id, expires_on, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)',
      [record.id, record.supplierId, record.kind, record.fileId, record.expiresOn, actorId],
    );
  }

  async requisition(tx: Transaction, id: string, lock: boolean): Promise<RequisitionRecord | null> {
    return (await this.requisitionsWhere(tx, `r.id = $1${lock ? ' FOR UPDATE' : ''}`, [id]))[0] ?? null;
  }

  listRequisitions(tx: Transaction, filter: RequisitionFilter, scopes: readonly ReadScope[], beforeId: string | null, limit: number): Promise<RequisitionRecord[]> {
    return this.requisitionsWhere(
      tx,
      `EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) AS s(branch_id, location_id)
                WHERE s.branch_id = r.branch_id AND (s.location_id IS NULL OR s.location_id = r.location_id))
         AND ($3::text IS NULL OR r.status = $3) AND ($4::uuid IS NULL OR r.requested_by = $4) AND ($5::uuid IS NULL OR r.id < $5)
       ORDER BY r.id DESC LIMIT $6`,
      [scopes.map((s) => s.branchId), scopes.map((s) => s.locationId), filter.status ?? null, filter.requestedBy ?? null, beforeId, limit],
    );
  }

  async insertRequisition(tx: Transaction, id: string, header: RequisitionHeader, lines: readonly Omit<RequisitionLineRecord, 'lineNo'>[], actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO pur.purchase_requisition (id, requested_by, location_id, needed_by, justification, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $2, $2)`,
      [id, actorId, header.locationId, header.neededBy, header.justification, header.branchId],
    );
    await this.insertLines(tx, id, lines);
  }

  async updateRequisition(
    tx: Transaction,
    id: string,
    header: Omit<RequisitionHeader, 'branchId' | 'locationId'>,
    lines: readonly Omit<RequisitionLineRecord, 'lineNo'>[] | null,
    actorId: string,
  ): Promise<void> {
    if (lines !== null) {
      await tx.query('SELECT pur.clear_purchase_requisition_lines($1)', [id]);
      await this.insertLines(tx, id, lines);
    }
    await tx.query('UPDATE pur.purchase_requisition SET needed_by = $2, justification = $3, updated_by = $4, updated_at = now(), version = version + 1 WHERE id = $1', [
      id,
      header.neededBy,
      header.justification,
      actorId,
    ]);
  }

  async markRequisition(tx: Transaction, id: string, status: RequisitionStatus, change: { readonly purchaseOrderId?: string; readonly rejectReason?: string }, actorId: string): Promise<void> {
    const decided = status !== 'DRAFT' && status !== 'SUBMITTED';
    await tx.query(
      `UPDATE pur.purchase_requisition
          SET status = $2, purchase_order_id = COALESCE($3, purchase_order_id), reject_reason = COALESCE($4, reject_reason),
              posted_at = CASE WHEN $5 THEN now() ELSE posted_at END, posted_by = CASE WHEN $5 THEN $6::uuid ELSE posted_by END,
              updated_by = $6, updated_at = now(), version = version + 1
        WHERE id = $1`,
      [id, status, change.purchaseOrderId ?? null, change.rejectReason ?? null, decided, actorId],
    );
  }

  private async insertLines(tx: Transaction, id: string, lines: readonly Omit<RequisitionLineRecord, 'lineNo'>[]): Promise<void> {
    for (const [index, line] of lines.entries()) {
      await tx.query('INSERT INTO pur.purchase_requisition_line (id, requisition_id, line_no, product_id, qty, note) VALUES ($1, $2, $3, $4, $5, $6)', [
        line.id,
        id,
        index + 1,
        line.productId,
        line.qty,
        line.note,
      ]);
    }
  }

  private async requisitionsWhere(tx: Transaction, where: string, values: unknown[]): Promise<RequisitionRecord[]> {
    const { rows } = await tx.query<RequisitionRow>(`SELECT ${REQUISITION_COLUMNS} FROM pur.purchase_requisition r WHERE ${where}`, values);
    if (rows.length === 0) return [];
    const { rows: lineRows } = await tx.query<RequisitionLineRow>(
      'SELECT id, requisition_id, line_no, product_id, qty::text AS qty, note FROM pur.purchase_requisition_line WHERE requisition_id = ANY($1::uuid[]) ORDER BY line_no',
      [rows.map((r) => r.id)],
    );
    return rows.map((r) => ({
      id: r.id,
      requisitionNo: r.requisition_no,
      status: r.status,
      requestedBy: r.requested_by,
      locationId: r.location_id,
      neededBy: r.needed_by,
      justification: r.justification,
      purchaseOrderId: r.purchase_order_id,
      rejectReason: r.reject_reason,
      branchId: r.branch_id,
      version: r.version,
      createdAt: r.created_at,
      createdBy: r.created_by,
      lines: lineRows
        .filter((l) => l.requisition_id === r.id)
        .map((l) => ({ id: l.id, lineNo: l.line_no, productId: l.product_id, qty: l.qty, note: l.note })),
    }));
  }
}
