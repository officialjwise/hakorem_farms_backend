import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AccountFilters, AccountRow, ChartStore, PeriodFilters, PeriodRow, ReopenRow } from '../application/chart-store';
import type { PeriodFacts } from '../domain/period';

const ACCOUNT_COLUMNS = `id, code, name, type, normal_side AS "normalSide", parent_id AS "parentId", is_postable AS "isPostable",
  subledger_kind AS "subledgerKind", cash_flow_category AS "cashFlowCategory", status, version`;
const PERIOD_COLUMNS = `id, fiscal_year AS "fiscalYear", period_no AS "periodNo", start_date::text AS "startDate", end_date::text AS "endDate",
  status, locked_at AS "lockedAt", locked_by AS "lockedBy", closed_at AS "closedAt", closed_by AS "closedBy", version`;
const REOPEN_COLUMNS = `id, period_id AS "periodId", branch_id AS "branchId", reason, status, approval_request_id AS "approvalRequestId",
  created_by AS "createdBy", version`;

/** FIN's chart and periods. Every write names its actor; the version moves by one (platform.touch_version). */
export class PgChartStore implements ChartStore {
  async accounts(tx: Transaction, filters: AccountFilters, afterCode: string | null, limit: number): Promise<AccountRow[]> {
    const { rows } = await tx.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM fin.account
        WHERE deleted_at IS NULL AND ($1::text IS NULL OR type = $1) AND (NOT $2 OR is_postable) AND ($3::text IS NULL OR code > $3)
        ORDER BY code LIMIT $4`,
      [filters.type, filters.postableOnly, afterCode, limit],
    );
    return rows;
  }

  async account(tx: Transaction, id: string, forUpdate: boolean): Promise<AccountRow | null> {
    const { rows } = await tx.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM fin.account WHERE id = $1 AND deleted_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] ?? null;
  }

  async codeTaken(tx: Transaction, code: string): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM fin.account WHERE code = $1 AND deleted_at IS NULL', [code]);
    return rows.length > 0;
  }

  async insertAccount(tx: Transaction, row: AccountRow, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO fin.account (id, code, name, type, normal_side, parent_id, is_postable, subledger_kind, cash_flow_category, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [row.id, row.code, row.name, row.type, row.normalSide, row.parentId, row.isPostable, row.subledgerKind, row.cashFlowCategory, row.status, actorId],
    );
  }

  async updateAccount(tx: Transaction, id: string, change: { readonly name: string; readonly status: 'ACTIVE' | 'CLOSED' }, actorId: string): Promise<void> {
    await tx.query('UPDATE fin.account SET name = $2, status = $3, updated_by = $4, version = version + 1 WHERE id = $1', [id, change.name, change.status, actorId]);
  }

  async accountBalance(tx: Transaction, id: string): Promise<bigint> {
    const { rows } = await tx.query<{ balance: string }>(
      "SELECT COALESCE(sum(CASE WHEN side = 'D' THEN amount_pesewas ELSE -amount_pesewas END), 0)::text AS balance FROM fin.journal_line WHERE account_id = $1",
      [id],
    );
    return BigInt(rows[0]!.balance);
  }

  async accountNamedInForce(tx: Transaction, id: string, date: string): Promise<boolean> {
    const { rows } = await tx.query(
      `SELECT 1 FROM fin.posting_rule WHERE account_id = $1 AND deleted_at IS NULL AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)
       UNION ALL
       SELECT 1 FROM fin.account_determination WHERE account_id = $1 AND deleted_at IS NULL AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)
       LIMIT 1`,
      [id, date],
    );
    return rows.length > 0;
  }

  async periods(tx: Transaction, filters: PeriodFilters, beforeStart: string | null, limit: number): Promise<PeriodRow[]> {
    const { rows } = await tx.query<PeriodRow>(
      `SELECT ${PERIOD_COLUMNS} FROM fin.accounting_period
        WHERE ($1::integer IS NULL OR fiscal_year = $1) AND ($2::text IS NULL OR status = $2) AND ($3::date IS NULL OR start_date < $3::date)
        ORDER BY start_date DESC LIMIT $4`,
      [filters.fiscalYear, filters.status, beforeStart, limit],
    );
    return rows;
  }

  async period(tx: Transaction, id: string, forUpdate: boolean): Promise<PeriodRow | null> {
    const { rows } = await tx.query<PeriodRow>(`SELECT ${PERIOD_COLUMNS} FROM fin.accounting_period WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] ?? null;
  }

  async allPeriods(tx: Transaction): Promise<PeriodFacts[]> {
    const { rows } = await tx.query<PeriodFacts>('SELECT id, start_date::text AS "startDate", end_date::text AS "endDate", status FROM fin.accounting_period ORDER BY start_date');
    return rows;
  }

  async lockPeriod(tx: Transaction, id: string, actorId: string, at: Date): Promise<void> {
    await tx.query("UPDATE fin.accounting_period SET status = 'LOCKED', locked_at = $2, locked_by = $3, updated_by = $3, version = version + 1 WHERE id = $1", [id, at, actorId]);
  }

  async closePeriod(tx: Transaction, id: string, actorId: string, at: Date): Promise<void> {
    await tx.query("UPDATE fin.accounting_period SET status = 'CLOSED', closed_at = $2, closed_by = $3, updated_by = $3, version = version + 1 WHERE id = $1", [id, at, actorId]);
  }

  async reopenPeriod(tx: Transaction, id: string, actorId: string): Promise<void> {
    await tx.query("UPDATE fin.accounting_period SET status = 'OPEN', locked_at = NULL, locked_by = NULL, updated_by = $2, version = version + 1 WHERE id = $1", [id, actorId]);
  }

  async pendingReopenOf(tx: Transaction, periodId: string): Promise<ReopenRow | null> {
    const { rows } = await tx.query<ReopenRow>(`SELECT ${REOPEN_COLUMNS} FROM fin.period_reopen WHERE period_id = $1 AND status = 'PENDING_APPROVAL'`, [periodId]);
    return rows[0] ?? null;
  }

  async insertReopen(tx: Transaction, row: ReopenRow): Promise<void> {
    await tx.query(
      `INSERT INTO fin.period_reopen (id, period_id, branch_id, reason, status, approval_request_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [row.id, row.periodId, row.branchId, row.reason, row.status, row.approvalRequestId, row.createdBy],
    );
  }

  async reopenRequest(tx: Transaction, id: string, forUpdate: boolean): Promise<ReopenRow | null> {
    const { rows } = await tx.query<ReopenRow>(`SELECT ${REOPEN_COLUMNS} FROM fin.period_reopen WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] ?? null;
  }

  async decideReopen(tx: Transaction, id: string, status: 'POSTED' | 'REJECTED', decidedBy: string, at: Date): Promise<void> {
    await tx.query('UPDATE fin.period_reopen SET status = $2, decided_by = $3, decided_at = $4, updated_by = $3, version = version + 1 WHERE id = $1', [id, status, decidedBy, at]);
  }
}
