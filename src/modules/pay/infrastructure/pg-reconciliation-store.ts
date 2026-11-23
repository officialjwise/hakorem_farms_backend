import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  BreakFilter,
  BreakRecord,
  OverdueUnverifiedRecord,
  PayoutRecord,
  PendingTransferRecord,
  ProviderPaymentRecord,
  ReconciliationStore,
  ResolutionRecord,
  SettlementLineRecord,
  SettlementLineStatus,
  SettlementReportRecord,
  SettlementStatus,
  StatementLineRecord,
  StatementRecord,
  StatementStatus,
  UnverifiedTenderRecord,
} from '../application/reconciliation-store';
import type { ResolutionPosting } from '../domain/reconciliation';

const REPORT = `id, provider, settlement_ref, settled_on::text AS settled_on, bank_account_id, gross_pesewas::text AS gross, fee_pesewas::text AS fee, net_pesewas::text AS net, status, branch_id`;
const STATEMENT = `id, bank_account_id, period_start::text AS period_start, period_end::text AS period_end, opening_pesewas::text AS opening, closing_pesewas::text AS closing, status, branch_id`;
const BREAK = `b.id, b.kind, b.branch_id, b.payment_id, p.payment_no, b.refund_id, b.provider, b.reference, b.source_document_id, b.settlement_line_id, b.bank_statement_line_id,
  b.amount_pesewas::text AS amount, b.details, b.raised_at, b.status, b.resolved_by, b.resolved_at, b.resolution_note`;

interface ReportRow {
  id: string;
  provider: string;
  settlement_ref: string;
  settled_on: string;
  bank_account_id: string;
  gross: string;
  fee: string;
  net: string;
  status: SettlementStatus;
  branch_id: string;
}

interface StatementRow {
  id: string;
  bank_account_id: string;
  period_start: string;
  period_end: string;
  opening: string;
  closing: string;
  status: StatementStatus;
  branch_id: string;
}

interface BreakRow {
  id: string;
  kind: string;
  branch_id: string | null;
  payment_id: string | null;
  payment_no: string | null;
  refund_id: string | null;
  provider: string | null;
  reference: string | null;
  source_document_id: string | null;
  settlement_line_id: string | null;
  bank_statement_line_id: string | null;
  amount: string | null;
  details: Record<string, unknown>;
  raised_at: Date;
  status: 'OPEN' | 'RESOLVED';
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
}

interface ResolutionRow {
  id: string;
  break_id: string;
  posting: ResolutionPosting;
  note: string;
  status: ResolutionRecord['status'];
  approval_request_id: string | null;
  branch_id: string;
  created_by: string;
}

const report = (r: ReportRow): SettlementReportRecord => ({
  id: r.id,
  provider: r.provider,
  settlementRef: r.settlement_ref,
  settledOn: r.settled_on,
  bankAccountId: r.bank_account_id,
  grossPesewas: BigInt(r.gross),
  feePesewas: BigInt(r.fee),
  netPesewas: BigInt(r.net),
  status: r.status,
  branchId: r.branch_id,
});

const statement = (r: StatementRow): StatementRecord => ({
  id: r.id,
  bankAccountId: r.bank_account_id,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  openingPesewas: BigInt(r.opening),
  closingPesewas: BigInt(r.closing),
  status: r.status,
  branchId: r.branch_id,
});

const breakOf = (r: BreakRow): BreakRecord => ({
  id: r.id,
  kind: r.kind,
  branchId: r.branch_id,
  paymentId: r.payment_id,
  paymentNo: r.payment_no,
  refundId: r.refund_id,
  provider: r.provider,
  reference: r.reference,
  sourceDocumentId: r.source_document_id,
  settlementLineId: r.settlement_line_id,
  bankStatementLineId: r.bank_statement_line_id,
  amountPesewas: r.amount === null ? null : BigInt(r.amount),
  details: r.details,
  raisedAt: r.raised_at,
  status: r.status,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at,
  resolutionNote: r.resolution_note,
});

const resolution = (r: ResolutionRow): ResolutionRecord => ({
  id: r.id,
  breakId: r.break_id,
  posting: r.posting,
  note: r.note,
  status: r.status,
  approvalRequestId: r.approval_request_id,
  branchId: r.branch_id,
  createdBy: r.created_by,
});

/** PAY's reconciliation tables in PostgreSQL (migration 0178): point reads and keyed writes in the caller's transaction. */
export class PgReconciliationStore implements ReconciliationStore {
  async settlementByFileOrRef(tx: Transaction, provider: string, sha256: Buffer, settlementRef: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM pay.settlement_report WHERE provider = $1 AND (file_sha256 = $2 OR settlement_ref = $3) LIMIT 1', [provider, sha256, settlementRef]);
    return rows[0]?.id ?? null;
  }

  async insertSettlement(
    tx: Transaction,
    r: SettlementReportRecord & { readonly fileId: string; readonly sha256: Buffer },
    lines: readonly Omit<SettlementLineRecord, 'matchedPaymentId' | 'matchedPaymentNo' | 'matchStatus' | 'matchReason'>[],
    actorId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO pay.settlement_report (id, provider, settlement_ref, settled_on, bank_account_id, gross_pesewas, fee_pesewas, net_pesewas, file_id, file_sha256, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
      [r.id, r.provider, r.settlementRef, r.settledOn, r.bankAccountId, r.grossPesewas.toString(), r.feePesewas.toString(), r.netPesewas.toString(), r.fileId, r.sha256, r.branchId, actorId],
    );
    for (const l of lines) {
      await tx.query(
        `INSERT INTO pay.settlement_line (id, settlement_report_id, line_no, provider, provider_reference, amount_pesewas, fee_pesewas, branch_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [l.id, r.id, l.lineNo, l.provider, l.providerReference, l.amountPesewas.toString(), l.feePesewas.toString(), r.branchId, actorId],
      );
    }
  }

  async settlement(tx: Transaction, id: string, forUpdate: boolean): Promise<SettlementReportRecord | null> {
    const { rows } = await tx.query<ReportRow>(`SELECT ${REPORT} FROM pay.settlement_report WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : report(rows[0]);
  }

  async settlements(
    tx: Transaction,
    f: { readonly status: string | null; readonly from: string | null; readonly to: string | null; readonly branchIds: readonly string[] },
    after: { readonly settledOn: string; readonly id: string } | null,
    limit: number,
  ): Promise<SettlementReportRecord[]> {
    const { rows } = await tx.query<ReportRow>(
      `SELECT ${REPORT} FROM pay.settlement_report
        WHERE branch_id = ANY($1::uuid[]) AND ($2::text IS NULL OR status = $2) AND ($3::date IS NULL OR settled_on >= $3) AND ($4::date IS NULL OR settled_on <= $4)
          AND ($5::date IS NULL OR (settled_on, id) < ($5::date, $6::uuid))
        ORDER BY settled_on DESC, id DESC LIMIT $7`,
      [f.branchIds, f.status, f.from, f.to, after?.settledOn ?? null, after?.id ?? null, limit],
    );
    return rows.map(report);
  }

  async settlementLines(tx: Transaction, reportIds: readonly string[]): Promise<SettlementLineRecord[]> {
    if (reportIds.length === 0) return [];
    const { rows } = await tx.query<LineRow>(`${LINE_SELECT} WHERE l.settlement_report_id = ANY($1::uuid[]) ORDER BY l.settlement_report_id, l.line_no`, [reportIds]);
    return rows.map(line);
  }

  async settlementLine(tx: Transaction, id: string): Promise<SettlementLineRecord | null> {
    const { rows } = await tx.query<LineRow>(`${LINE_SELECT} WHERE l.id = $1`, [id]);
    return rows[0] === undefined ? null : line(rows[0]);
  }

  async settledReferences(tx: Transaction, provider: string, references: readonly string[]): Promise<ReadonlySet<string>> {
    const { rows } = await tx.query<{ provider_reference: string }>('SELECT provider_reference FROM pay.settlement_line WHERE provider = $1 AND provider_reference = ANY($2::text[])', [provider, references]);
    return new Set(rows.map((r) => r.provider_reference));
  }

  async providerPayments(tx: Transaction, provider: string, references: readonly string[]): Promise<ReadonlyMap<string, ProviderPaymentRecord>> {
    if (references.length === 0) return new Map();
    const { rows } = await tx.query<{ id: string; status: string; provider: string | null; amount: string; provider_reference: string; settled: boolean }>(
      `SELECT p.id, p.status, p.provider, p.amount_pesewas::text AS amount, p.provider_reference,
              EXISTS (SELECT 1 FROM pay.settlement_line l WHERE l.matched_payment_id = p.id) AS settled
         FROM pay.payment p WHERE p.provider_reference = ANY($1::text[]) AND p.reverses_payment_id IS NULL AND p.provider = $2`,
      [references, provider],
    );
    return new Map(rows.map((r) => [r.provider_reference, { id: r.id, status: r.status, provider: r.provider, amountPesewas: BigInt(r.amount), alreadySettled: r.settled }] as const));
  }

  async markSettlementLine(tx: Transaction, id: string, c: { readonly status: SettlementLineStatus; readonly reason: string | null; readonly paymentId: string | null }, actorId: string): Promise<void> {
    await tx.query('UPDATE pay.settlement_line SET match_status = $2, match_reason = $3, matched_payment_id = $4, updated_by = $5, updated_at = now(), version = version + 1 WHERE id = $1', [id, c.status, c.reason, c.paymentId, actorId]);
  }

  async markSettlement(tx: Transaction, id: string, status: SettlementStatus, at: Date, actorId: string): Promise<void> {
    await tx.query('UPDATE pay.settlement_report SET status = $2, matched_at = $3, matched_by = $4, updated_by = $4, updated_at = now(), version = version + 1 WHERE id = $1', [id, status, at, actorId]);
  }

  async statementByFileOrPeriod(tx: Transaction, bankAccountId: string, sha256: Buffer, period: { readonly start: string; readonly end: string }): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM pay.bank_statement WHERE bank_account_id = $1 AND (file_sha256 = $2 OR daterange(period_start, period_end, '[]') && daterange($3::date, $4::date, '[]')) LIMIT 1`,
      [bankAccountId, sha256, period.start, period.end],
    );
    return rows[0]?.id ?? null;
  }

  async insertStatement(
    tx: Transaction,
    r: StatementRecord & { readonly fileId: string; readonly sha256: Buffer },
    lines: readonly Omit<StatementLineRecord, 'matchedPaymentId' | 'matchedJournalEntryRef' | 'matchStatus'>[],
    actorId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO pay.bank_statement (id, bank_account_id, period_start, period_end, opening_pesewas, closing_pesewas, file_id, file_sha256, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [r.id, r.bankAccountId, r.periodStart, r.periodEnd, r.openingPesewas.toString(), r.closingPesewas.toString(), r.fileId, r.sha256, r.branchId, actorId],
    );
    for (const l of lines) {
      await tx.query(
        `INSERT INTO pay.bank_statement_line (id, bank_statement_id, line_no, bank_account_id, value_date, direction, amount_pesewas, balance_pesewas, narration, bank_reference, branch_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
        [l.id, r.id, l.lineNo, r.bankAccountId, l.valueDate, l.direction, l.amountPesewas.toString(), l.balancePesewas.toString(), l.narration, l.bankReference, r.branchId, actorId],
      );
    }
  }

  async statement(tx: Transaction, id: string, forUpdate: boolean): Promise<StatementRecord | null> {
    const { rows } = await tx.query<StatementRow>(`SELECT ${STATEMENT} FROM pay.bank_statement WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : statement(rows[0]);
  }

  async statements(
    tx: Transaction,
    f: { readonly bankAccountId: string | null; readonly status: string | null; readonly branchIds: readonly string[] },
    after: { readonly periodEnd: string; readonly id: string } | null,
    limit: number,
  ): Promise<StatementRecord[]> {
    const { rows } = await tx.query<StatementRow>(
      `SELECT ${STATEMENT} FROM pay.bank_statement
        WHERE branch_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR bank_account_id = $2) AND ($3::text IS NULL OR status = $3)
          AND ($4::date IS NULL OR (period_end, id) < ($4::date, $5::uuid))
        ORDER BY period_end DESC, id DESC LIMIT $6`,
      [f.branchIds, f.bankAccountId, f.status, after?.periodEnd ?? null, after?.id ?? null, limit],
    );
    return rows.map(statement);
  }

  async statementLines(tx: Transaction, statementIds: readonly string[]): Promise<StatementLineRecord[]> {
    if (statementIds.length === 0) return [];
    const { rows } = await tx.query<StatementLineRow>(`SELECT ${STATEMENT_LINE} FROM pay.bank_statement_line WHERE bank_statement_id = ANY($1::uuid[]) ORDER BY bank_statement_id, line_no`, [statementIds]);
    return rows.map(statementLine);
  }

  async statementLine(tx: Transaction, id: string, forUpdate: boolean): Promise<StatementLineRecord | null> {
    const { rows } = await tx.query<StatementLineRow>(`SELECT ${STATEMENT_LINE} FROM pay.bank_statement_line WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : statementLine(rows[0]);
  }

  async pendingTransfers(tx: Transaction, bankAccountId: string): Promise<PendingTransferRecord[]> {
    const { rows } = await tx.query<{ id: string; external_reference: string | null; amount: string }>(
      `SELECT id, external_reference, amount_pesewas::text AS amount FROM pay.payment
        WHERE bank_account_id = $1 AND method_kind = 'BANK_TRANSFER' AND status = 'PENDING' AND reverses_payment_id IS NULL ORDER BY id`,
      [bankAccountId],
    );
    return rows.map((r) => ({ id: r.id, externalReference: r.external_reference, amountPesewas: BigInt(r.amount) }));
  }

  async pendingTransfer(tx: Transaction, paymentId: string): ReturnType<ReconciliationStore['pendingTransfer']> {
    const { rows } = await tx.query<{
      id: string;
      external_reference: string | null;
      amount: string;
      method_kind: string;
      status: string;
      bank_account_id: string | null;
      branch_id: string;
      customer_id: string | null;
      order_document_id: string | null;
      received_at: Date;
    }>(
      `SELECT p.id, p.external_reference, p.amount_pesewas::text AS amount, p.method_kind, p.status, p.bank_account_id, p.branch_id, p.customer_id, p.order_document_id, p.received_at
         FROM pay.payment p WHERE p.id = $1 FOR UPDATE`,
      [paymentId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      id: r.id,
      externalReference: r.external_reference,
      amountPesewas: BigInt(r.amount),
      methodKind: r.method_kind,
      status: r.status,
      bankAccountId: r.bank_account_id,
      branchId: r.branch_id,
      customerId: r.customer_id,
      orderDocumentId: r.order_document_id,
      receivedAt: r.received_at,
    };
  }

  async payouts(tx: Transaction, bankAccountId: string): Promise<PayoutRecord[]> {
    const { rows } = await tx.query<{ id: string; settlement_ref: string; net: string }>(
      `SELECT s.id, s.settlement_ref, s.net_pesewas::text AS net FROM pay.settlement_report s
        WHERE s.bank_account_id = $1 AND s.status IN ('POSTED', 'HAS_BREAKS') ORDER BY s.id`,
      [bankAccountId],
    );
    return rows.map((r) => ({ settlementReportId: r.id, settlementRef: r.settlement_ref, netPesewas: BigInt(r.net) }));
  }

  async lineMatching(tx: Transaction, target: { readonly paymentId: string } | { readonly journalEntryId: string }): Promise<boolean> {
    const { rows } =
      'paymentId' in target
        ? await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM pay.bank_statement_line WHERE matched_payment_id = $1', [target.paymentId])
        : await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM pay.bank_statement_line WHERE matched_journal_entry_ref = $1', [target.journalEntryId]);
    return rows[0]!.n > 0;
  }

  async markLineMatched(tx: Transaction, id: string, match: { readonly paymentId: string } | { readonly journalEntryId: string }, at: Date, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE pay.bank_statement_line SET match_status = 'MATCHED', matched_payment_id = $2, matched_journal_entry_ref = $3, matched_at = $4, matched_by = $5, updated_by = $5, updated_at = now(), version = version + 1 WHERE id = $1`,
      [id, 'paymentId' in match ? match.paymentId : null, 'journalEntryId' in match ? match.journalEntryId : null, at, actorId],
    );
  }

  async markStatement(tx: Transaction, id: string, status: StatementStatus, actorId: string): Promise<void> {
    await tx.query('UPDATE pay.bank_statement SET status = $2, updated_by = $3, updated_at = now(), version = version + 1 WHERE id = $1 AND status <> $2', [id, status, actorId]);
  }

  async clearTransfer(tx: Transaction, paymentId: string, at: Date, actorId: string): Promise<void> {
    await tx.query(`UPDATE pay.payment SET status = 'CLEARED', cleared_at = $2, posted_at = $2, posted_by = $3, updated_by = $3, version = version + 1 WHERE id = $1`, [paymentId, at, actorId]);
  }

  async breaks(tx: Transaction, f: BreakFilter, after: { readonly raisedAt: Date; readonly id: string } | null, limit: number): Promise<BreakRecord[]> {
    const { rows } = await tx.query<BreakRow>(
      `SELECT ${BREAK} FROM pay.reconciliation_break b LEFT JOIN pay.payment p ON p.id = b.payment_id
        WHERE (b.branch_id = ANY($1::uuid[]) OR (b.branch_id IS NULL AND $2::uuid = ANY($1::uuid[])))
          AND ($3::text IS NULL OR b.status = $3) AND ($4::text IS NULL OR b.kind = $4)
          AND ($5::timestamptz IS NULL OR (b.raised_at, b.id) < ($5::timestamptz, $6::uuid))
        ORDER BY b.raised_at DESC, b.id DESC LIMIT $7`,
      [f.branchIds, f.headOfficeBranchId, f.status, f.kind, after?.raisedAt ?? null, after?.id ?? null, limit],
    );
    return rows.map(breakOf);
  }

  async break(tx: Transaction, id: string, forUpdate: boolean): Promise<BreakRecord | null> {
    const { rows } = await tx.query<BreakRow>(`SELECT ${BREAK} FROM pay.reconciliation_break b LEFT JOIN pay.payment p ON p.id = b.payment_id WHERE b.id = $1${forUpdate ? ' FOR UPDATE OF b' : ''}`, [id]);
    return rows[0] === undefined ? null : breakOf(rows[0]);
  }

  async openResolutionOf(tx: Transaction, breakId: string): Promise<ResolutionRecord | null> {
    const { rows } = await tx.query<ResolutionRow>(`SELECT ${RESOLUTION} FROM pay.break_resolution WHERE break_id = $1 AND status = 'PENDING_APPROVAL'`, [breakId]);
    return rows[0] === undefined ? null : resolution(rows[0]);
  }

  async resolution(tx: Transaction, id: string): Promise<ResolutionRecord | null> {
    const { rows } = await tx.query<ResolutionRow>(`SELECT ${RESOLUTION} FROM pay.break_resolution WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : resolution(rows[0]);
  }

  async resolutionByApproval(tx: Transaction, approvalRequestId: string): Promise<ResolutionRecord | null> {
    const { rows } = await tx.query<ResolutionRow>(`SELECT ${RESOLUTION} FROM pay.break_resolution WHERE approval_request_id = $1 FOR UPDATE`, [approvalRequestId]);
    return rows[0] === undefined ? null : resolution(rows[0]);
  }

  async insertResolution(tx: Transaction, r: { readonly id: string; readonly breakId: string; readonly posting: ResolutionPosting; readonly note: string; readonly branchId: string; readonly createdBy: string }): Promise<void> {
    await tx.query(
      `INSERT INTO pay.break_resolution (id, break_id, posting, note, status, branch_id, created_by, updated_by) VALUES ($1, $2, $3, $4, 'PENDING_APPROVAL', $5, $6, $6)`,
      [r.id, r.breakId, r.posting, r.note, r.branchId, r.createdBy],
    );
  }

  async updateResolution(tx: Transaction, id: string, c: { readonly approvalRequestId?: string; readonly status?: 'APPROVED' | 'REJECTED' }, actorId: string): Promise<void> {
    await tx.query(
      'UPDATE pay.break_resolution SET approval_request_id = COALESCE($2, approval_request_id), status = COALESCE($3, status), updated_by = $4, updated_at = now(), version = version + 1 WHERE id = $1',
      [id, c.approvalRequestId ?? null, c.status ?? null, actorId],
    );
  }

  async resolveBreak(tx: Transaction, id: string, note: string, at: Date, actorId: string): Promise<void> {
    await tx.query(`UPDATE pay.reconciliation_break SET status = 'RESOLVED', resolved_by = $4, resolved_at = $3, resolution_note = $2, updated_by = $4, updated_at = now(), version = version + 1 WHERE id = $1 AND status = 'OPEN'`, [
      id,
      note,
      at,
      actorId,
    ]);
  }

  async unverifiedTender(tx: Transaction, paymentId: string, forUpdate: boolean): Promise<UnverifiedTenderRecord | null> {
    const { rows } = await tx.query<{ id: string; status: UnverifiedTenderRecord['status']; amount: string; bank_account_id: string | null; branch_id: string; customer_id: string | null; verified: boolean }>(
      `SELECT p.id, p.status, p.amount_pesewas::text AS amount, p.bank_account_id, p.branch_id, p.customer_id,
              EXISTS (SELECT 1 FROM pay.unverified_verification v WHERE v.payment_id = p.id) AS verified
         FROM pay.payment p
        WHERE p.id = $1 AND p.method_kind = 'MOBILE_MONEY' AND p.verification = 'UNVERIFIED' AND p.reverses_payment_id IS NULL${forUpdate ? ' FOR UPDATE OF p' : ''}`,
      [paymentId],
    );
    const r = rows[0];
    return r === undefined ? null : { paymentId: r.id, status: r.status, amountPesewas: BigInt(r.amount), bankAccountId: r.bank_account_id, branchId: r.branch_id, customerId: r.customer_id, verified: r.verified };
  }

  async insertVerification(tx: Transaction, r: Parameters<ReconciliationStore['insertVerification']>[1]): Promise<void> {
    await tx.query(
      `INSERT INTO pay.unverified_verification (id, payment_id, break_id, resolution_id, branch_id, amount_pesewas, verified_on, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [r.id, r.paymentId, r.breakId, r.resolutionId, r.branchId, r.amountPesewas.toString(), r.verifiedOn, r.recordedAt, r.actorId],
    );
  }

  async overdueUnverified(tx: Transaction, at: Date, limit: number): Promise<OverdueUnverifiedRecord[]> {
    const { rows } = await tx.query<{ id: string; payment_id: string; branch_id: string; amount: string; urgent_from: Date; reference: string | null; details: Record<string, unknown> }>(
      `SELECT b.id, b.payment_id, p.branch_id, p.amount_pesewas::text AS amount, (b.details->>'urgentFrom')::timestamptz AS urgent_from, b.reference, b.details
         FROM pay.reconciliation_break b
         JOIN pay.payment p ON p.id = b.payment_id
        WHERE b.kind = 'UNVERIFIED_PAYMENT' AND b.status = 'OPEN' AND p.status = 'PENDING'
          AND (b.details->>'urgentFrom')::timestamptz <= $1
          AND NOT EXISTS (SELECT 1 FROM pay.unverified_overdue o WHERE o.break_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM pay.unverified_verification v WHERE v.payment_id = b.payment_id)
        ORDER BY b.raised_at, b.id
        LIMIT $2`,
      [at, limit],
    );
    return rows.map((r) => ({ breakId: r.id, paymentId: r.payment_id, branchId: r.branch_id, amountPesewas: BigInt(r.amount), urgentFrom: r.urgent_from, reference: r.reference, details: r.details }));
  }

  async insertOverdue(tx: Transaction, r: Parameters<ReconciliationStore['insertOverdue']>[1]): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO pay.unverified_overdue (id, break_id, payment_id, branch_id, amount_pesewas, urgent_from, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT ON CONSTRAINT uq_unverified_overdue_break DO NOTHING`,
      [r.id, r.breakId, r.paymentId, r.branchId, r.amountPesewas.toString(), r.urgentFrom, r.recordedAt, r.actorId],
    );
    return rowCount === 1;
  }
}

const RESOLUTION = 'id, break_id, posting, note, status, approval_request_id, branch_id, created_by';

const LINE_SELECT = `SELECT l.id, l.settlement_report_id, l.line_no, l.provider, l.provider_reference, l.amount_pesewas::text AS amount, l.fee_pesewas::text AS fee,
  l.matched_payment_id, p.payment_no, l.match_status, l.match_reason FROM pay.settlement_line l LEFT JOIN pay.payment p ON p.id = l.matched_payment_id`;

interface LineRow {
  id: string;
  settlement_report_id: string;
  line_no: number;
  provider: string;
  provider_reference: string;
  amount: string;
  fee: string;
  matched_payment_id: string | null;
  payment_no: string | null;
  match_status: SettlementLineStatus;
  match_reason: string | null;
}

const line = (r: LineRow): SettlementLineRecord => ({
  id: r.id,
  settlementReportId: r.settlement_report_id,
  lineNo: r.line_no,
  provider: r.provider,
  providerReference: r.provider_reference,
  amountPesewas: BigInt(r.amount),
  feePesewas: BigInt(r.fee),
  matchedPaymentId: r.matched_payment_id,
  matchedPaymentNo: r.payment_no,
  matchStatus: r.match_status,
  matchReason: r.match_reason,
});

const STATEMENT_LINE = `id, bank_statement_id, line_no, bank_account_id, value_date::text AS value_date, direction, amount_pesewas::text AS amount, balance_pesewas::text AS balance,
  narration, bank_reference, matched_payment_id, matched_journal_entry_ref, match_status, branch_id`;

interface StatementLineRow {
  id: string;
  bank_statement_id: string;
  line_no: number;
  bank_account_id: string;
  value_date: string;
  direction: 'IN' | 'OUT';
  amount: string;
  balance: string;
  narration: string | null;
  bank_reference: string | null;
  matched_payment_id: string | null;
  matched_journal_entry_ref: string | null;
  match_status: 'MATCHED' | 'UNMATCHED';
  branch_id: string;
}

const statementLine = (r: StatementLineRow): StatementLineRecord => ({
  id: r.id,
  bankStatementId: r.bank_statement_id,
  lineNo: r.line_no,
  bankAccountId: r.bank_account_id,
  valueDate: r.value_date,
  direction: r.direction,
  amountPesewas: BigInt(r.amount),
  balancePesewas: BigInt(r.balance),
  narration: r.narration,
  bankReference: r.bank_reference,
  matchedPaymentId: r.matched_payment_id,
  matchedJournalEntryRef: r.matched_journal_entry_ref,
  matchStatus: r.match_status,
  branchId: r.branch_id,
});
