import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { CreditReason } from '../domain/credit';
import type { AccountChangeRecord, AccountFilter, AccountRecord, AccountStore, NewAccount, OverrideFilter, OverrideRecord, OverrideRequestRecord } from '../application/account-store';

const ACCOUNT_COLUMNS = `customer_id, branch_id, credit_limit_pesewas::text AS credit_limit, payment_terms_days, account_manager_id, overdue_hold_days, status,
  hold_reason, held_at, held_by, hold_document_id, version`;

function account(r: Record<string, unknown>): AccountRecord {
  return {
    customerId: r['customer_id'] as string,
    branchId: r['branch_id'] as string,
    creditLimitPesewas: BigInt(r['credit_limit'] as string),
    paymentTermsDays: r['payment_terms_days'] as number,
    accountManagerId: r['account_manager_id'] as string | null,
    overdueHoldDays: r['overdue_hold_days'] as number,
    status: r['status'] as AccountRecord['status'],
    holdReason: r['hold_reason'] as string | null,
    heldAt: r['held_at'] as Date | null,
    heldBy: r['held_by'] as string | null,
    holdDocumentId: r['hold_document_id'] as string | null,
    version: r['version'] as number,
  };
}

const CHANGE_COLUMNS = `id, customer_id, branch_id, kind, credit_limit_pesewas::text AS credit_limit, previous_limit_pesewas::text AS previous_limit, reason,
  approval_request_id, status, created_by, created_at`;

function change(r: Record<string, unknown>): AccountChangeRecord {
  const limit = r['credit_limit'] as string | null;
  const previous = r['previous_limit'] as string | null;
  return {
    id: r['id'] as string,
    customerId: r['customer_id'] as string,
    branchId: r['branch_id'] as string,
    kind: r['kind'] as AccountChangeRecord['kind'],
    creditLimitPesewas: limit === null ? null : BigInt(limit),
    previousLimitPesewas: previous === null ? null : BigInt(previous),
    reason: r['reason'] as string,
    approvalRequestId: r['approval_request_id'] as string,
    status: r['status'] as AccountChangeRecord['status'],
    createdBy: r['created_by'] as string,
    createdAt: r['created_at'] as Date,
  };
}

const FIGURE_COLUMNS = `id, order_id, customer_id, branch_id, approval_request_id, reason, reasons, limit_pesewas::text AS limit_p, exposure_pesewas::text AS exposure,
  order_pesewas::text AS order_p, over_limit_pesewas::text AS over, requested_by, recorded_at`;

function figures(r: Record<string, unknown>) {
  return {
    id: r['id'] as string,
    orderId: r['order_id'] as string,
    customerId: r['customer_id'] as string,
    branchId: r['branch_id'] as string,
    approvalRequestId: r['approval_request_id'] as string,
    reason: r['reason'] as string,
    reasons: r['reasons'] as CreditReason[],
    limitPesewas: BigInt(r['limit_p'] as string),
    exposurePesewas: BigInt(r['exposure'] as string),
    orderPesewas: BigInt(r['order_p'] as string),
    overLimitPesewas: BigInt(r['over'] as string),
    requestedBy: r['requested_by'] as string,
    recordedAt: r['recorded_at'] as Date,
  };
}

const override = (r: Record<string, unknown>): OverrideRecord => ({ ...figures(r), requestId: r['request_id'] as string, approvedBy: r['approved_by'] as string });

/** WHL's business account and credit control tables (migration 0259). Parameterised SQL only. */
@Injectable()
export class PgAccountStore implements AccountStore {
  async insertAccount(tx: Transaction, a: NewAccount, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `INSERT INTO whl.business_account (customer_id, branch_id, payment_terms_days, account_manager_id, overdue_hold_days, status, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $6, $7)`,
      [a.customerId, a.branchId, a.paymentTermsDays, a.accountManagerId, a.overdueHoldDays, at, actorId],
    );
  }

  async account(tx: Transaction, customerId: string, lock: boolean): Promise<AccountRecord | null> {
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${ACCOUNT_COLUMNS} FROM whl.business_account WHERE customer_id = $1 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [customerId]);
    return rows[0] === undefined ? null : account(rows[0]);
  }

  async accounts(tx: Transaction, f: AccountFilter, afterId: string | null, limit: number): Promise<AccountRecord[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_COLUMNS} FROM whl.business_account
        WHERE deleted_at IS NULL AND branch_id = ANY($1::uuid[]) AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR account_manager_id = $3)
          AND ($4::uuid IS NULL OR customer_id > $4) ORDER BY customer_id LIMIT $5`,
      [f.branchIds, f.status, f.accountManagerId, afterId, limit],
    );
    return rows.map(account);
  }

  async activeAccounts(tx: Transaction, afterId: string | null, limit: number): Promise<AccountRecord[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_COLUMNS} FROM whl.business_account WHERE deleted_at IS NULL AND status = 'ACTIVE' AND ($1::uuid IS NULL OR customer_id > $1) ORDER BY customer_id LIMIT $2`,
      [afterId, limit],
    );
    return rows.map(account);
  }

  async updateTerms(tx: Transaction, customerId: string, t: { readonly paymentTermsDays: number; readonly accountManagerId: string | null; readonly overdueHoldDays: number; readonly status: AccountRecord['status'] }, actorId: string, at: Date): Promise<void> {
    await tx.query(
      'UPDATE whl.business_account SET payment_terms_days = $2, account_manager_id = $3, overdue_hold_days = $4, status = $5, updated_at = $6, updated_by = $7, version = version + 1 WHERE customer_id = $1',
      [customerId, t.paymentTermsDays, t.accountManagerId, t.overdueHoldDays, t.status, at, actorId],
    );
  }

  async setLimit(tx: Transaction, customerId: string, limitPesewas: bigint, changeId: string, actorId: string, at: Date): Promise<void> {
    await tx.query('UPDATE whl.business_account SET credit_limit_pesewas = $2, limit_change_id = $3, updated_at = $4, updated_by = $5, version = version + 1 WHERE customer_id = $1', [customerId, limitPesewas.toString(), changeId, at, actorId]);
  }

  async hold(tx: Transaction, customerId: string, h: { readonly reason: string; readonly documentId: string | null; readonly by: string; readonly at: Date }): Promise<void> {
    await tx.query(
      "UPDATE whl.business_account SET status = 'ON_HOLD', hold_reason = $2, hold_document_id = $3, held_at = $4, held_by = $5, updated_at = $4, updated_by = $5, version = version + 1 WHERE customer_id = $1",
      [customerId, h.reason, h.documentId, h.at, h.by],
    );
  }

  async release(tx: Transaction, customerId: string, changeId: string, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `UPDATE whl.business_account SET status = 'ACTIVE', hold_reason = NULL, hold_document_id = NULL, held_at = NULL, held_by = NULL, release_change_id = $2,
              updated_at = $3, updated_by = $4, version = version + 1 WHERE customer_id = $1`,
      [customerId, changeId, at, actorId],
    );
  }

  async insertChange(tx: Transaction, c: AccountChangeRecord): Promise<void> {
    await tx.query(
      `INSERT INTO whl.account_change (id, customer_id, kind, credit_limit_pesewas, previous_limit_pesewas, reason, approval_request_id, status, branch_id, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING_APPROVAL', $8, $9, $10, $9, $10)`,
      [c.id, c.customerId, c.kind, c.creditLimitPesewas?.toString() ?? null, c.previousLimitPesewas?.toString() ?? null, c.reason, c.approvalRequestId, c.branchId, c.createdAt, c.createdBy],
    );
  }

  async change(tx: Transaction, id: string): Promise<AccountChangeRecord | null> {
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${CHANGE_COLUMNS} FROM whl.account_change WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : change(rows[0]);
  }

  async changeByApproval(tx: Transaction, approvalRequestId: string): Promise<AccountChangeRecord | null> {
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${CHANGE_COLUMNS} FROM whl.account_change WHERE approval_request_id = $1 FOR UPDATE`, [approvalRequestId]);
    return rows[0] === undefined ? null : change(rows[0]);
  }

  async pendingChange(tx: Transaction, customerId: string, kind: 'CREDIT_LIMIT' | 'RELEASE'): Promise<AccountChangeRecord | null> {
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${CHANGE_COLUMNS} FROM whl.account_change WHERE customer_id = $1 AND kind = $2 AND status = 'PENDING_APPROVAL'`, [customerId, kind]);
    return rows[0] === undefined ? null : change(rows[0]);
  }

  async decideChange(tx: Transaction, id: string, d: { readonly status: 'APPLIED' | 'REJECTED' | 'CANCELLED'; readonly by: string; readonly reason: string | null; readonly at: Date }): Promise<void> {
    const decided = d.status !== 'CANCELLED';
    await tx.query('UPDATE whl.account_change SET status = $2, decision_reason = $3, posted_at = $4, posted_by = $5, updated_at = $6, updated_by = $7, version = version + 1 WHERE id = $1', [
      id,
      d.status,
      d.reason,
      decided ? d.at : null,
      decided ? d.by : null,
      d.at,
      d.by,
    ]);
  }

  async insertOverrideRequest(tx: Transaction, r: OverrideRequestRecord, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO whl.credit_override_request (id, order_id, customer_id, branch_id, approval_request_id, reason, reasons, limit_pesewas, exposure_pesewas, order_pesewas, over_limit_pesewas, requested_by, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, $12, $13, $14)`,
      [r.id, r.orderId, r.customerId, r.branchId, r.approvalRequestId, r.reason, [...r.reasons], r.limitPesewas.toString(), r.exposurePesewas.toString(), r.orderPesewas.toString(), r.overLimitPesewas.toString(), r.requestedBy, r.recordedAt, actorId],
    );
  }

  async overrideRequestByApproval(tx: Transaction, approvalRequestId: string): Promise<OverrideRequestRecord | null> {
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${FIGURE_COLUMNS} FROM whl.credit_override_request WHERE approval_request_id = $1`, [approvalRequestId]);
    return rows[0] === undefined ? null : figures(rows[0]);
  }

  async insertOverride(tx: Transaction, o: OverrideRecord, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO whl.credit_override (id, request_id, customer_id, order_id, branch_id, approval_request_id, reason, reasons, limit_pesewas, exposure_pesewas, order_pesewas, over_limit_pesewas,
                                        requested_by, approved_by, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12, $13, $14, $15, $16)`,
      [o.id, o.requestId, o.customerId, o.orderId, o.branchId, o.approvalRequestId, o.reason, [...o.reasons], o.limitPesewas.toString(), o.exposurePesewas.toString(), o.orderPesewas.toString(), o.overLimitPesewas.toString(), o.requestedBy, o.approvedBy, o.recordedAt, actorId],
    );
  }

  async overridesOfOrder(tx: Transaction, orderId: string): Promise<OverrideRecord[]> {
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${FIGURE_COLUMNS}, request_id, approved_by FROM whl.credit_override WHERE order_id = $1 ORDER BY id`, [orderId]);
    return rows.map(override);
  }

  async overrides(tx: Transaction, f: OverrideFilter, beforeId: string | null, limit: number): Promise<OverrideRecord[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT ${FIGURE_COLUMNS}, request_id, approved_by FROM whl.credit_override
        WHERE branch_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR customer_id = $2) AND ($3::timestamptz IS NULL OR recorded_at >= $3) AND ($4::timestamptz IS NULL OR recorded_at <= $4)
          AND ($5::uuid IS NULL OR id < $5) ORDER BY id DESC LIMIT $6`,
      [f.branchIds, f.customerId, f.from, f.to, beforeId, limit],
    );
    return rows.map(override);
  }
}
