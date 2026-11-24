import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  AccrualRecord,
  CapBooksStore,
  FinancingRecord,
  InvestorDocumentRecord,
  InvestorLineRecord,
  InvestorPaymentRecord,
  PayoutChangeRecord,
  RepaymentRecord,
  ScheduleLineRecord,
} from '../application/cap-books-store';
import type { InvestorRecord } from '../application/cap-store';
import { e4, INVESTOR, investorOf, type RawInvestor } from './pg-cap-store';

const CHANGE = 'id, investor_id, method, details_enc, masked, last4, approval_request_id, status, branch_id, created_by, created_at';
type RawChange = {
  id: string;
  investor_id: string;
  method: PayoutChangeRecord['method'];
  details_enc: Buffer;
  masked: string;
  last4: string;
  approval_request_id: string;
  status: PayoutChangeRecord['status'];
  branch_id: string;
  created_by: string;
  created_at: Date;
};
const changeOf = (r: RawChange): PayoutChangeRecord => ({
  id: r.id,
  investorId: r.investor_id,
  method: r.method,
  detailsEnc: r.details_enc,
  masked: r.masked,
  last4: r.last4,
  approvalRequestId: r.approval_request_id,
  status: r.status,
  branchId: r.branch_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

const DOCUMENT = 'id, investor_id, kind, name, file_id, created_at';
type RawDocument = { id: string; investor_id: string; kind: InvestorDocumentRecord['kind']; name: string; file_id: string; created_at: Date };
const documentOf = (r: RawDocument): InvestorDocumentRecord => ({ id: r.id, investorId: r.investor_id, kind: r.kind, name: r.name, fileId: r.file_id, createdAt: r.created_at });

const FINANCING = `id, financing_no, kind, lender_investor_id, lender_name, principal_pesewas::text AS principal, annual_rate_percent::text AS rate, start_date::text AS start_date,
  term_months, bank_account_id, agreement_file_id, approval_request_id, journal_entry_id, status, branch_id, version, created_by, created_at`;
type RawFinancing = {
  id: string;
  financing_no: string;
  kind: FinancingRecord['kind'];
  lender_investor_id: string | null;
  lender_name: string;
  principal: string;
  rate: string;
  start_date: string;
  term_months: number | null;
  bank_account_id: string;
  agreement_file_id: string | null;
  approval_request_id: string;
  journal_entry_id: string | null;
  status: FinancingRecord['status'];
  branch_id: string;
  version: number;
  created_by: string;
  created_at: Date;
};
/** `platform.percent` read back without trailing zeros ("12.0000" is "12"), as `Rate.parsePercent` reads it. */
const percentText = (text: string): string => (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text);
const financingOf = (r: RawFinancing): FinancingRecord => ({
  id: r.id,
  financingNo: r.financing_no,
  kind: r.kind,
  lenderInvestorId: r.lender_investor_id,
  lenderName: r.lender_name,
  principalPesewas: BigInt(r.principal),
  annualRatePercent: percentText(r.rate),
  startDate: r.start_date,
  termMonths: r.term_months,
  bankAccountId: r.bank_account_id,
  agreementFileId: r.agreement_file_id,
  approvalRequestId: r.approval_request_id,
  journalEntryId: r.journal_entry_id,
  status: r.status,
  branchId: r.branch_id,
  version: r.version,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

type RawAccrual = { id: string; financing_id: string; kind: AccrualRecord['kind']; month_start: string; month_end: string; amount: string; journal_entry_id: string | null; recorded_at: Date; actor_id: string };
type RawRepayment = {
  id: string;
  financing_id: string;
  principal: string;
  interest: string;
  bank_account_id: string;
  external_reference: string | null;
  paid_at: Date;
  value_date: string;
  journal_entry_id: string;
  recorded_at: Date;
  actor_id: string;
};
const REPAYMENT = `id, financing_id, principal_pesewas::text AS principal, interest_pesewas::text AS interest, bank_account_id, external_reference, paid_at, value_date::text AS value_date,
  journal_entry_id, recorded_at, actor_id`;
const repaymentOf = (r: RawRepayment): RepaymentRecord => ({
  id: r.id,
  financingId: r.financing_id,
  principalPesewas: BigInt(r.principal),
  interestPesewas: BigInt(r.interest),
  bankAccountId: r.bank_account_id,
  externalReference: r.external_reference,
  paidAt: r.paid_at,
  valueDate: r.value_date,
  journalEntryId: r.journal_entry_id,
  recordedAt: r.recorded_at,
  actorId: r.actor_id,
});

/** CAP's B12 continued tables (migration 0359). Nothing outside schema `cap` is read. */
export class PgCapBooksStore implements CapBooksStore {
  async investorByPrincipal(tx: Transaction, principalId: string): Promise<InvestorRecord | null> {
    const { rows } = await tx.query<RawInvestor>(`SELECT ${INVESTOR} FROM cap.investor WHERE principal_id = $1`, [principalId]);
    return rows[0] === undefined ? null : investorOf(rows[0]);
  }

  async sealIdNumber(tx: Transaction, investorId: string, sealed: Buffer, masked: string, by: string, at: Date): Promise<void> {
    await tx.query('UPDATE cap.investor SET id_number_enc = $2, id_number_masked = $3, version = version + 1, updated_at = $4, updated_by = $5 WHERE id = $1', [investorId, sealed, masked, at, by]);
  }

  async setPortalLogin(tx: Transaction, investorId: string, principalId: string, by: string, at: Date): Promise<void> {
    await tx.query('UPDATE cap.investor SET principal_id = $2, version = version + 1, updated_at = $3, updated_by = $4 WHERE id = $1', [investorId, principalId, at, by]);
  }

  async setAgreement(tx: Transaction, investorId: string, fileId: string, by: string, at: Date): Promise<void> {
    await tx.query('UPDATE cap.investor SET agreement_file_id = $2, version = version + 1, updated_at = $3, updated_by = $4 WHERE id = $1', [investorId, fileId, at, by]);
  }

  async sealedOf(tx: Transaction, investorId: string): Promise<{ payoutEnc: Buffer | null; payoutChangeId: string | null; idNumberEnc: Buffer | null } | null> {
    const { rows } = await tx.query<{ payout_details_enc: Buffer | null; payout_change_id: string | null; id_number_enc: Buffer | null }>(
      'SELECT payout_details_enc, payout_change_id, id_number_enc FROM cap.investor WHERE id = $1',
      [investorId],
    );
    const r = rows[0];
    return r === undefined ? null : { payoutEnc: r.payout_details_enc, payoutChangeId: r.payout_change_id, idNumberEnc: r.id_number_enc };
  }

  async insertPayoutChange(tx: Transaction, c: PayoutChangeRecord): Promise<void> {
    await tx.query(
      `INSERT INTO cap.investor_payout_change (id, investor_id, method, details_enc, masked, last4, approval_request_id, status, branch_id, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, $11)`,
      [c.id, c.investorId, c.method, c.detailsEnc, c.masked, c.last4, c.approvalRequestId, c.status, c.branchId, c.createdAt, c.createdBy],
    );
  }

  async payoutChange(tx: Transaction, id: string): Promise<PayoutChangeRecord | null> {
    const { rows } = await tx.query<RawChange>(`SELECT ${CHANGE} FROM cap.investor_payout_change WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : changeOf(rows[0]);
  }

  async payoutChangeByApproval(tx: Transaction, approvalRequestId: string): Promise<PayoutChangeRecord | null> {
    const { rows } = await tx.query<RawChange>(`SELECT ${CHANGE} FROM cap.investor_payout_change WHERE approval_request_id = $1 FOR UPDATE`, [approvalRequestId]);
    return rows[0] === undefined ? null : changeOf(rows[0]);
  }

  async pendingPayoutChange(tx: Transaction, investorId: string): Promise<PayoutChangeRecord | null> {
    const { rows } = await tx.query<RawChange>(`SELECT ${CHANGE} FROM cap.investor_payout_change WHERE investor_id = $1 AND status = 'PENDING_APPROVAL'`, [investorId]);
    return rows[0] === undefined ? null : changeOf(rows[0]);
  }

  async decidePayoutChange(tx: Transaction, id: string, status: 'APPLIED' | 'REJECTED' | 'CANCELLED', by: string, at: Date): Promise<void> {
    const decided = status === 'CANCELLED' ? [null, null] : [at, by];
    await tx.query('UPDATE cap.investor_payout_change SET status = $2, posted_at = $3, posted_by = $4, version = version + 1, updated_at = $5, updated_by = $6 WHERE id = $1', [id, status, ...decided, at, by]);
  }

  async applyPayout(tx: Transaction, c: PayoutChangeRecord, by: string, at: Date): Promise<void> {
    await tx.query(
      `UPDATE cap.investor SET payout_method = $2, payout_details_enc = $3, payout_last4 = $4, payout_masked = $5, payout_change_id = $6, version = version + 1, updated_at = $7, updated_by = $8
        WHERE id = $1`,
      [c.investorId, c.method, c.detailsEnc, c.last4, c.masked, c.id, at, by],
    );
  }

  async insertDocument(tx: Transaction, d: InvestorDocumentRecord, by: string): Promise<void> {
    await tx.query(
      `INSERT INTO cap.investor_document (id, investor_id, kind, name, file_id, created_at, created_by, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7)`,
      [d.id, d.investorId, d.kind, d.name, d.fileId, d.createdAt, by],
    );
  }

  async documents(tx: Transaction, investorId: string, beforeId: string | null, limit: number): Promise<InvestorDocumentRecord[]> {
    const { rows } = await tx.query<RawDocument>(
      `SELECT ${DOCUMENT} FROM cap.investor_document WHERE investor_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
      [investorId, beforeId, limit],
    );
    return rows.map(documentOf);
  }

  async document(tx: Transaction, investorId: string, id: string): Promise<InvestorDocumentRecord | null> {
    const { rows } = await tx.query<RawDocument>(`SELECT ${DOCUMENT} FROM cap.investor_document WHERE id = $1 AND investor_id = $2 AND deleted_at IS NULL`, [id, investorId]);
    return rows[0] === undefined ? null : documentOf(rows[0]);
  }

  async linesOfInvestor(tx: Transaction, investorId: string | null): Promise<InvestorLineRecord[]> {
    const { rows } = await tx.query<{
      run_id: string;
      run_no: string;
      period_start: string;
      period_end: string;
      unit_days: string;
      allocated: string;
      withheld: string;
      net_payable: string;
      paid: string;
      status: string;
      posted_at: Date;
    }>(
      `SELECT r.id AS run_id, r.run_no, r.period_start::text AS period_start, r.period_end::text AS period_end, l.unit_days::text AS unit_days,
              l.allocated_pesewas::text AS allocated, l.withheld_pesewas::text AS withheld, l.net_payable_pesewas::text AS net_payable,
              l.paid_pesewas::text AS paid, r.status, r.posted_at
         FROM cap.distribution_line l JOIN cap.distribution_run r ON r.id = l.distribution_run_id AND r.computation_no = l.computation_no
        WHERE r.status IN ('POSTED', 'PAID') AND ($1::uuid IS NULL OR l.investor_id = $1)
        ORDER BY r.period_start DESC, r.id`,
      [investorId],
    );
    return rows.map((r) => ({
      runId: r.run_id,
      runNo: r.run_no,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      unitDaysE4: e4(r.unit_days),
      allocatedPesewas: BigInt(r.allocated),
      withheldPesewas: BigInt(r.withheld),
      netPayablePesewas: BigInt(r.net_payable),
      paidPesewas: BigInt(r.paid),
      runStatus: r.status,
      postedAt: r.posted_at,
    }));
  }

  async paymentsOfInvestor(tx: Transaction, investorId: string | null): Promise<InvestorPaymentRecord[]> {
    const { rows } = await tx.query<{ id: string; run_no: string; amount: string; paid_at: Date }>(
      `SELECT p.id, r.run_no, p.amount_pesewas::text AS amount, p.paid_at
         FROM cap.distribution_payment p JOIN cap.distribution_line l ON l.id = p.distribution_line_id JOIN cap.distribution_run r ON r.id = l.distribution_run_id
        WHERE $1::uuid IS NULL OR l.investor_id = $1 ORDER BY p.paid_at, p.id`,
      [investorId],
    );
    return rows.map((r) => ({ id: r.id, runNo: r.run_no, amountPesewas: BigInt(r.amount), paidAt: r.paid_at }));
  }

  async insertFinancing(tx: Transaction, f: FinancingRecord, schedule: readonly ScheduleLineRecord[]): Promise<void> {
    await tx.query(
      `INSERT INTO cap.financing (id, financing_no, kind, lender_investor_id, lender_name, principal_pesewas, annual_rate_percent, start_date, term_months, bank_account_id,
                                  agreement_file_id, approval_request_id, status, branch_id, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $15, $16)`,
      [f.id, f.financingNo, f.kind, f.lenderInvestorId, f.lenderName, f.principalPesewas.toString(), f.annualRatePercent, f.startDate, f.termMonths, f.bankAccountId,
        f.agreementFileId, f.approvalRequestId, f.status, f.branchId, f.createdAt, f.createdBy],
    );
    for (const line of schedule) {
      await tx.query(
        `INSERT INTO cap.financing_schedule_line (financing_id, instalment_no, due_date, principal_due_pesewas, interest_due_pesewas, branch_id, created_at, created_by, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7, $8)`,
        [f.id, line.instalmentNo, line.dueDate, line.principalDuePesewas.toString(), line.interestDuePesewas.toString(), f.branchId, f.createdAt, f.createdBy],
      );
    }
  }

  async financing(tx: Transaction, id: string, forUpdate: boolean): Promise<FinancingRecord | null> {
    const { rows } = await tx.query<RawFinancing>(`SELECT ${FINANCING} FROM cap.financing WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : financingOf(rows[0]);
  }

  async financingByApproval(tx: Transaction, approvalRequestId: string): Promise<FinancingRecord | null> {
    const { rows } = await tx.query<RawFinancing>(`SELECT ${FINANCING} FROM cap.financing WHERE approval_request_id = $1 FOR UPDATE`, [approvalRequestId]);
    return rows[0] === undefined ? null : financingOf(rows[0]);
  }

  async financings(tx: Transaction, filter: { readonly kind: FinancingRecord['kind'] | null; readonly status: FinancingRecord['status'] | null }, beforeId: string | null, limit: number): Promise<FinancingRecord[]> {
    const { rows } = await tx.query<RawFinancing>(
      `SELECT ${FINANCING} FROM cap.financing WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
      [filter.kind, filter.status, beforeId, limit],
    );
    return rows.map(financingOf);
  }

  async activeFinancingIds(tx: Transaction): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM cap.financing WHERE status = 'ACTIVE' ORDER BY id");
    return rows.map((r) => r.id);
  }

  async decideFinancing(tx: Transaction, id: string, d: { readonly status: 'ACTIVE' | 'CANCELLED'; readonly journalEntryId: string | null; readonly by: string; readonly at: Date }): Promise<void> {
    const posted = d.status === 'ACTIVE' ? [d.at, d.by] : [null, null];
    await tx.query('UPDATE cap.financing SET status = $2, journal_entry_id = $3, posted_at = $4, posted_by = $5, version = version + 1, updated_at = $6, updated_by = $7 WHERE id = $1', [
      id,
      d.status,
      d.journalEntryId,
      ...posted,
      d.at,
      d.by,
    ]);
  }

  async settleFinancing(tx: Transaction, id: string, by: string, at: Date): Promise<void> {
    await tx.query("UPDATE cap.financing SET status = 'SETTLED', version = version + 1, updated_at = $2, updated_by = $3 WHERE id = $1", [id, at, by]);
  }

  async scheduleOf(tx: Transaction, financingId: string): Promise<ScheduleLineRecord[]> {
    const { rows } = await tx.query<{ instalment_no: number; due_date: string; principal: string; interest: string }>(
      `SELECT instalment_no, due_date::text AS due_date, principal_due_pesewas::text AS principal, interest_due_pesewas::text AS interest
         FROM cap.financing_schedule_line WHERE financing_id = $1 ORDER BY instalment_no`,
      [financingId],
    );
    return rows.map((r) => ({ financingId, instalmentNo: r.instalment_no, dueDate: r.due_date, principalDuePesewas: BigInt(r.principal), interestDuePesewas: BigInt(r.interest) }));
  }

  async accrualsOf(tx: Transaction, financingId: string): Promise<AccrualRecord[]> {
    const { rows } = await tx.query<RawAccrual>(
      `SELECT id, financing_id, kind, month_start::text AS month_start, month_end::text AS month_end, amount_pesewas::text AS amount, journal_entry_id, recorded_at, actor_id
         FROM cap.financing_accrual WHERE financing_id = $1 ORDER BY month_end`,
      [financingId],
    );
    return rows.map((r) => ({
      id: r.id,
      financingId: r.financing_id,
      kind: r.kind,
      monthStart: r.month_start,
      monthEnd: r.month_end,
      amountPesewas: BigInt(r.amount),
      journalEntryId: r.journal_entry_id,
      recordedAt: r.recorded_at,
      actorId: r.actor_id,
    }));
  }

  async insertAccrual(tx: Transaction, a: AccrualRecord): Promise<void> {
    await tx.query(
      `INSERT INTO cap.financing_accrual (id, financing_id, kind, month_start, month_end, amount_pesewas, journal_entry_id, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [a.id, a.financingId, a.kind, a.monthStart, a.monthEnd, a.amountPesewas.toString(), a.journalEntryId, a.recordedAt, a.actorId],
    );
  }

  async repaymentsOf(tx: Transaction, financingId: string): Promise<RepaymentRecord[]> {
    const { rows } = await tx.query<RawRepayment>(`SELECT ${REPAYMENT} FROM cap.financing_repayment WHERE financing_id = $1 ORDER BY value_date, id`, [financingId]);
    return rows.map(repaymentOf);
  }

  async insertRepayment(tx: Transaction, r: RepaymentRecord): Promise<void> {
    await tx.query(
      `INSERT INTO cap.financing_repayment (id, financing_id, principal_pesewas, interest_pesewas, bank_account_id, external_reference, paid_at, value_date, journal_entry_id, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [r.id, r.financingId, r.principalPesewas.toString(), r.interestPesewas.toString(), r.bankAccountId, r.externalReference, r.paidAt, r.valueDate, r.journalEntryId, r.recordedAt, r.actorId],
    );
  }

  async repaymentByReference(tx: Transaction, externalReference: string): Promise<RepaymentRecord | null> {
    const { rows } = await tx.query<RawRepayment>(`SELECT ${REPAYMENT} FROM cap.financing_repayment WHERE external_reference = $1`, [externalReference]);
    return rows[0] === undefined ? null : repaymentOf(rows[0]);
  }
}
