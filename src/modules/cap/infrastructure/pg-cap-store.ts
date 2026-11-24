import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  CapitalTransactionRecord,
  CapStore,
  HoldingRecord,
  InvestorRecord,
  LineRecord,
  PaymentRecord,
  Position,
  RunFigures,
  RunRecord,
  WithdrawalRequestRecord,
} from '../application/cap-store';
import { formatUnits } from '../domain/distribution';

/** A `numeric(…,4)` read back as text ("500.0000") in ten-thousandths. */
const e4 = (text: string): bigint => {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole! + fraction.padEnd(4, '0').slice(0, 4));
};

const INVESTOR = `id, investor_no, kind, legal_name, phone_e164, email, principal_id, payout_method, payout_last4, id_number_enc IS NOT NULL AS has_id, joined_on::text AS joined_on, status, version`;
type RawInvestor = {
  id: string;
  investor_no: string;
  kind: InvestorRecord['kind'];
  legal_name: string;
  phone_e164: string | null;
  email: string | null;
  principal_id: string | null;
  payout_method: InvestorRecord['payoutMethod'];
  payout_last4: string | null;
  has_id: boolean;
  joined_on: string;
  status: InvestorRecord['status'];
  version: number;
};
const investorOf = (r: RawInvestor): InvestorRecord => ({
  id: r.id,
  investorNo: r.investor_no,
  kind: r.kind,
  legalName: r.legal_name,
  phone: r.phone_e164,
  email: r.email,
  principalId: r.principal_id,
  payoutMethod: r.payout_method,
  payoutLast4: r.payout_last4,
  hasIdNumber: r.has_id,
  joinedOn: r.joined_on,
  status: r.status,
  version: r.version,
});

const TRANSACTION = `id, transaction_no, investor_id, branch_id, kind, amount_pesewas::text AS amount, value_date::text AS value_date, posting_date::text AS posting_date,
  unit_price_pesewas::text AS unit_price, units::text AS units, bank_account_id, external_reference, approval_request_id, withdrawal_request_id, journal_entry_id, recorded_at, actor_id`;
type RawTransaction = {
  id: string;
  transaction_no: string;
  investor_id: string;
  branch_id: string;
  kind: CapitalTransactionRecord['kind'];
  amount: string;
  value_date: string;
  posting_date: string;
  unit_price: string;
  units: string;
  bank_account_id: string;
  external_reference: string | null;
  approval_request_id: string | null;
  withdrawal_request_id: string | null;
  journal_entry_id: string;
  recorded_at: Date;
  actor_id: string;
};
const transactionOf = (r: RawTransaction): CapitalTransactionRecord => ({
  id: r.id,
  transactionNo: r.transaction_no,
  investorId: r.investor_id,
  branchId: r.branch_id,
  kind: r.kind,
  amountPesewas: BigInt(r.amount),
  valueDate: r.value_date,
  postingDate: r.posting_date,
  unitPricePesewas: BigInt(r.unit_price),
  unitsE4: e4(r.units),
  bankAccountId: r.bank_account_id,
  externalReference: r.external_reference,
  approvalRequestId: r.approval_request_id,
  withdrawalRequestId: r.withdrawal_request_id,
  journalEntryId: r.journal_entry_id,
  recordedAt: r.recorded_at,
  actorId: r.actor_id,
});

const WITHDRAWAL = `id, investor_id, branch_id, amount_pesewas::text AS amount, value_date::text AS value_date, unit_price_pesewas::text AS unit_price, units::text AS units,
  bank_account_id, external_reference, approval_request_id, status, created_by, created_at`;
type RawWithdrawal = {
  id: string;
  investor_id: string;
  branch_id: string;
  amount: string;
  value_date: string;
  unit_price: string;
  units: string;
  bank_account_id: string;
  external_reference: string | null;
  approval_request_id: string;
  status: WithdrawalRequestRecord['status'];
  created_by: string;
  created_at: Date;
};
const withdrawalOf = (r: RawWithdrawal): WithdrawalRequestRecord => ({
  id: r.id,
  investorId: r.investor_id,
  branchId: r.branch_id,
  amountPesewas: BigInt(r.amount),
  valueDate: r.value_date,
  unitPricePesewas: BigInt(r.unit_price),
  unitsE4: e4(r.units),
  bankAccountId: r.bank_account_id,
  externalReference: r.external_reference,
  approvalRequestId: r.approval_request_id,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

const RUN = `id, run_no, period_start::text AS period_start, period_end::text AS period_end, days_in_period, net_profit_pesewas::text AS net_profit, is_loss,
  retention_rate_percent::text AS retention, retained_pesewas::text AS retained, distributable_pesewas::text AS distributable, day_count_convention,
  total_unit_days::text AS total_unit_days, withholding_rate_percent::text AS withholding, computation_no, computed_at, approval_request_id, approved_by, approved_at,
  schedule_document_id, journal_entry_id, paid_pesewas::text AS paid, status, branch_id, version, created_at, created_by, posted_by`;
type RawRun = {
  id: string;
  run_no: string;
  period_start: string;
  period_end: string;
  days_in_period: number;
  net_profit: string;
  is_loss: boolean;
  retention: string;
  retained: string;
  distributable: string;
  day_count_convention: string;
  total_unit_days: string;
  withholding: string;
  computation_no: number;
  computed_at: Date;
  approval_request_id: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  schedule_document_id: string | null;
  journal_entry_id: string | null;
  paid: string;
  status: RunRecord['status'];
  branch_id: string;
  version: number;
  created_at: Date;
  created_by: string;
  posted_by: string | null;
};
/** `numeric(7,4)` as an exact percentage with at least two places ("40.00", "2.50", "12.345"). */
const percent = (text: string): string => {
  const [whole, fraction = ''] = text.split('.');
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
};
const runOf = (r: RawRun): RunRecord => ({
  id: r.id,
  runNo: r.run_no,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  daysInPeriod: r.days_in_period,
  netProfitPesewas: BigInt(r.net_profit),
  isLoss: r.is_loss,
  retentionRatePercent: percent(r.retention),
  retainedPesewas: BigInt(r.retained),
  distributablePesewas: BigInt(r.distributable),
  dayCountConvention: r.day_count_convention,
  totalUnitDaysE4: e4(r.total_unit_days),
  withholdingRatePercent: percent(r.withholding),
  computationNo: r.computation_no,
  computedAt: r.computed_at,
  approvalRequestId: r.approval_request_id,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  scheduleDocumentId: r.schedule_document_id,
  journalEntryId: r.journal_entry_id,
  paidPesewas: BigInt(r.paid),
  status: r.status,
  branchId: r.branch_id,
  version: r.version,
  createdAt: r.created_at,
  createdBy: r.created_by,
  postedBy: r.posted_by,
});

const LINE = `l.id, l.distribution_run_id, l.computation_no, l.investor_id, l.unit_days::text AS unit_days, l.allocated_pesewas::text AS allocated, l.received_extra_pesewa,
  l.withheld_pesewas::text AS withheld, l.net_payable_pesewas::text AS net_payable, l.paid_pesewas::text AS paid`;
type RawLine = {
  id: string;
  distribution_run_id: string;
  computation_no: number;
  investor_id: string;
  unit_days: string;
  allocated: string;
  received_extra_pesewa: boolean;
  withheld: string;
  net_payable: string;
  paid: string;
};
const lineOf = (r: RawLine): LineRecord => ({
  id: r.id,
  runId: r.distribution_run_id,
  computationNo: r.computation_no,
  investorId: r.investor_id,
  unitDaysE4: e4(r.unit_days),
  allocatedPesewas: BigInt(r.allocated),
  receivedExtraPesewa: r.received_extra_pesewa,
  withheldPesewas: BigInt(r.withheld),
  netPayablePesewas: BigInt(r.net_payable),
  paidPesewas: BigInt(r.paid),
});

/** CAP's tables (migration 0353). Parameterised SQL only; nothing outside schema `cap` is read or written. */
export class PgCapStore implements CapStore {
  async nextInvestorNo(tx: Transaction): Promise<string> {
    const { rows } = await tx.query<{ n: string }>("SELECT (COALESCE(max(substr(investor_no, 5)::integer), 0) + 1)::text AS n FROM cap.investor");
    return `INV-${rows[0]!.n.padStart(3, '0')}`;
  }

  async insertInvestor(tx: Transaction, i: InvestorRecord, by: string, at: Date): Promise<void> {
    await tx.query(
      `INSERT INTO cap.investor (id, investor_no, kind, legal_name, phone_e164, email, joined_on, status, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9, $10)`,
      [i.id, i.investorNo, i.kind, i.legalName, i.phone, i.email, i.joinedOn, i.status, at, by],
    );
  }

  async updateInvestor(tx: Transaction, id: string, c: { readonly phone: string | null; readonly email: string | null; readonly status: InvestorRecord['status'] }, by: string, at: Date): Promise<void> {
    await tx.query('UPDATE cap.investor SET phone_e164 = $2, email = $3, status = $4, version = version + 1, updated_at = $5, updated_by = $6 WHERE id = $1', [id, c.phone, c.email, c.status, at, by]);
  }

  async investor(tx: Transaction, id: string, forUpdate: boolean): Promise<InvestorRecord | null> {
    const { rows } = await tx.query<RawInvestor>(`SELECT ${INVESTOR} FROM cap.investor WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : investorOf(rows[0]);
  }

  async investorsIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, InvestorRecord>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<RawInvestor>(`SELECT ${INVESTOR} FROM cap.investor WHERE id = ANY($1::uuid[])`, [[...new Set(ids)]]);
    return new Map(rows.map((r) => [r.id, investorOf(r)] as const));
  }

  async investors(tx: Transaction, filter: { readonly status: InvestorRecord['status'] | null }, after: string | null, limit: number): Promise<InvestorRecord[]> {
    const { rows } = await tx.query<RawInvestor>(
      `SELECT ${INVESTOR} FROM cap.investor
        WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR (length(investor_no), investor_no) > (length($2), $2))
        ORDER BY length(investor_no), investor_no LIMIT $3`,
      [filter.status, after, limit],
    );
    return rows.map(investorOf);
  }

  async holdingsIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, HoldingRecord>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<{ investor_id: string; units: string; contributed: string; withdrawn: string }>(
      'SELECT investor_id, units::text AS units, contributed_pesewas::text AS contributed, withdrawn_pesewas::text AS withdrawn FROM cap.unit_holding WHERE investor_id = ANY($1::uuid[])',
      [[...new Set(ids)]],
    );
    return new Map(rows.map((r) => [r.investor_id, { investorId: r.investor_id, unitsE4: e4(r.units), contributedPesewas: BigInt(r.contributed), withdrawnPesewas: BigInt(r.withdrawn) }] as const));
  }

  async unitsInIssue(tx: Transaction): Promise<bigint> {
    const { rows } = await tx.query<{ units: string }>('SELECT COALESCE(sum(units), 0)::numeric(18,4)::text AS units FROM cap.unit_holding');
    return e4(rows[0]!.units);
  }

  async insertTransaction(tx: Transaction, t: CapitalTransactionRecord): Promise<void> {
    await tx.query(
      `INSERT INTO cap.capital_transaction (id, transaction_no, investor_id, branch_id, kind, amount_pesewas, value_date, posting_date, unit_price_pesewas, units, bank_account_id,
         external_reference, approval_request_id, withdrawal_request_id, journal_entry_id, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11, $12, $13, $14, $15, $16, $17)`,
      [
        t.id,
        t.transactionNo,
        t.investorId,
        t.branchId,
        t.kind,
        t.amountPesewas.toString(),
        t.valueDate,
        t.postingDate,
        t.unitPricePesewas.toString(),
        formatUnits(t.unitsE4),
        t.bankAccountId,
        t.externalReference,
        t.approvalRequestId,
        t.withdrawalRequestId,
        t.journalEntryId,
        t.recordedAt,
        t.actorId,
      ],
    );
  }

  async transaction(tx: Transaction, id: string): Promise<CapitalTransactionRecord | null> {
    const { rows } = await tx.query<RawTransaction>(`SELECT ${TRANSACTION} FROM cap.capital_transaction WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : transactionOf(rows[0]);
  }

  async transactions(
    tx: Transaction,
    f: { readonly investorId: string | null; readonly kind: CapitalTransactionRecord['kind'] | null; readonly from: string | null; readonly to: string | null },
    after: Position | null,
    limit: number,
  ): Promise<CapitalTransactionRecord[]> {
    const { rows } = await tx.query<RawTransaction>(
      `SELECT ${TRANSACTION} FROM cap.capital_transaction
        WHERE ($1::uuid IS NULL OR investor_id = $1) AND ($2::text IS NULL OR kind = $2) AND ($3::date IS NULL OR value_date >= $3) AND ($4::date IS NULL OR value_date <= $4)
          AND ($5::date IS NULL OR (value_date, id) < ($5::date, $6::uuid))
        ORDER BY value_date DESC, id DESC LIMIT $7`,
      [f.investorId, f.kind, f.from, f.to, after?.key ?? null, after?.id ?? null, limit],
    );
    return rows.map(transactionOf);
  }

  async transactionsUpTo(tx: Transaction, upTo: string): Promise<CapitalTransactionRecord[]> {
    const { rows } = await tx.query<RawTransaction>(`SELECT ${TRANSACTION} FROM cap.capital_transaction WHERE value_date <= $1 ORDER BY value_date, id`, [upTo]);
    return rows.map(transactionOf);
  }

  async transactionsOfLocked(tx: Transaction, investorId: string): Promise<CapitalTransactionRecord[]> {
    await tx.query('SELECT 1 FROM cap.investor WHERE id = $1 FOR UPDATE', [investorId]);
    const { rows } = await tx.query<RawTransaction>(`SELECT ${TRANSACTION} FROM cap.capital_transaction WHERE investor_id = $1 ORDER BY value_date, id`, [investorId]);
    return rows.map(transactionOf);
  }

  async insertWithdrawalRequest(tx: Transaction, w: WithdrawalRequestRecord): Promise<void> {
    await tx.query(
      `INSERT INTO cap.capital_withdrawal_request (id, investor_id, amount_pesewas, value_date, unit_price_pesewas, units, bank_account_id, external_reference, approval_request_id, status,
         branch_id, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11, $12, $13, $12, $13)`,
      [w.id, w.investorId, w.amountPesewas.toString(), w.valueDate, w.unitPricePesewas.toString(), formatUnits(w.unitsE4), w.bankAccountId, w.externalReference, w.approvalRequestId, w.status, w.branchId, w.createdAt, w.createdBy],
    );
  }

  async withdrawalRequest(tx: Transaction, id: string): Promise<WithdrawalRequestRecord | null> {
    const { rows } = await tx.query<RawWithdrawal>(`SELECT ${WITHDRAWAL} FROM cap.capital_withdrawal_request WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : withdrawalOf(rows[0]);
  }

  async withdrawalByApproval(tx: Transaction, approvalRequestId: string): Promise<WithdrawalRequestRecord | null> {
    const { rows } = await tx.query<RawWithdrawal>(`SELECT ${WITHDRAWAL} FROM cap.capital_withdrawal_request WHERE approval_request_id = $1 FOR UPDATE`, [approvalRequestId]);
    return rows[0] === undefined ? null : withdrawalOf(rows[0]);
  }

  async decideWithdrawal(tx: Transaction, id: string, d: { readonly status: 'APPLIED' | 'REJECTED' | 'CANCELLED'; readonly by: string; readonly at: Date }): Promise<void> {
    const decided = d.status !== 'CANCELLED';
    await tx.query(
      `UPDATE cap.capital_withdrawal_request
          SET status = $2, posted_at = CASE WHEN $3 THEN $4::timestamptz END, posted_by = CASE WHEN $3 THEN $5::uuid END, version = version + 1, updated_by = $5
        WHERE id = $1`,
      [id, d.status, decided, d.at, d.by],
    );
  }

  async insertRun(tx: Transaction, r: RunRecord): Promise<void> {
    await tx.query(
      `INSERT INTO cap.distribution_run (id, run_no, period_start, period_end, days_in_period, net_profit_pesewas, is_loss, retention_rate_percent, retained_pesewas,
         distributable_pesewas, day_count_convention, total_unit_days, withholding_rate_percent, computation_no, computed_at, status, branch_id, created_at, created_by,
         updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12::numeric, $13::numeric, $14, $15, 'DRAFT', $16, $17, $18, $17, $18)`,
      [
        r.id,
        r.runNo,
        r.periodStart,
        r.periodEnd,
        r.daysInPeriod,
        r.netProfitPesewas.toString(),
        r.isLoss,
        r.retentionRatePercent,
        r.retainedPesewas.toString(),
        r.distributablePesewas.toString(),
        r.dayCountConvention,
        formatUnits(r.totalUnitDaysE4),
        r.withholdingRatePercent,
        r.computationNo,
        r.computedAt,
        r.branchId,
        r.createdAt,
        r.createdBy,
      ],
    );
  }

  async recomputeRun(tx: Transaction, id: string, f: RunFigures, by: string): Promise<void> {
    await tx.query(
      `UPDATE cap.distribution_run SET net_profit_pesewas = $2, is_loss = $3, retention_rate_percent = $4::numeric, retained_pesewas = $5, distributable_pesewas = $6,
         total_unit_days = $7::numeric, withholding_rate_percent = $8::numeric, computation_no = $9, computed_at = $10, version = version + 1, updated_by = $11
        WHERE id = $1`,
      [
        id,
        f.netProfitPesewas.toString(),
        f.isLoss,
        f.retentionRatePercent,
        f.retainedPesewas.toString(),
        f.distributablePesewas.toString(),
        formatUnits(f.totalUnitDaysE4),
        f.withholdingRatePercent,
        f.computationNo,
        f.computedAt,
        by,
      ],
    );
  }

  async submitRun(tx: Transaction, id: string, approvalRequestId: string, by: string): Promise<void> {
    await tx.query("UPDATE cap.distribution_run SET status = 'PENDING_APPROVAL', approval_request_id = $2, version = version + 1, updated_by = $3 WHERE id = $1", [id, approvalRequestId, by]);
  }

  async decideRun(tx: Transaction, id: string, d: { readonly status: 'APPROVED' | 'REJECTED'; readonly by: string; readonly at: Date }): Promise<void> {
    await tx.query(
      `UPDATE cap.distribution_run SET status = $2, approved_by = CASE WHEN $2 = 'APPROVED' THEN $3::uuid END, approved_at = CASE WHEN $2 = 'APPROVED' THEN $4::timestamptz END,
         version = version + 1, updated_by = $3 WHERE id = $1`,
      [id, d.status, d.by, d.at],
    );
  }

  async postRun(tx: Transaction, id: string, journalEntryId: string, by: string, at: Date): Promise<void> {
    await tx.query(
      "UPDATE cap.distribution_run SET status = 'POSTED', journal_entry_id = $2, posted_at = $4, posted_by = $3, version = version + 1, updated_by = $3 WHERE id = $1",
      [id, journalEntryId, by, at],
    );
  }

  async markRunPaid(tx: Transaction, id: string, by: string): Promise<void> {
    await tx.query("UPDATE cap.distribution_run SET status = 'PAID', version = version + 1, updated_by = $2 WHERE id = $1 AND status = 'POSTED'", [id, by]);
  }

  async linkSchedule(tx: Transaction, id: string, archivedDocumentId: string, by: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      "UPDATE cap.distribution_run SET schedule_document_id = $2, version = version + 1, updated_by = $3 WHERE id = $1 AND schedule_document_id IS NULL AND status <> 'DRAFT'",
      [id, archivedDocumentId, by],
    );
    return (rowCount ?? 0) > 0;
  }

  async run(tx: Transaction, id: string, forUpdate: boolean): Promise<RunRecord | null> {
    const { rows } = await tx.query<RawRun>(`SELECT ${RUN} FROM cap.distribution_run WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : runOf(rows[0]);
  }

  async runByApproval(tx: Transaction, approvalRequestId: string): Promise<RunRecord | null> {
    const { rows } = await tx.query<RawRun>(`SELECT ${RUN} FROM cap.distribution_run WHERE approval_request_id = $1 FOR UPDATE`, [approvalRequestId]);
    return rows[0] === undefined ? null : runOf(rows[0]);
  }

  async runs(tx: Transaction, filter: { readonly status: RunRecord['status'] | null; readonly branchIds: readonly string[] }, after: Position | null, limit: number): Promise<RunRecord[]> {
    const { rows } = await tx.query<RawRun>(
      `SELECT ${RUN} FROM cap.distribution_run
        WHERE ($1::text IS NULL OR status = $1) AND branch_id = ANY($2::uuid[]) AND ($3::date IS NULL OR (period_start, id) < ($3::date, $4::uuid))
        ORDER BY period_start DESC, id DESC LIMIT $5`,
      [filter.status, [...filter.branchIds], after?.key ?? null, after?.id ?? null, limit],
    );
    return rows.map(runOf);
  }

  async linesOf(tx: Transaction, runIds: readonly string[]): Promise<ReadonlyMap<string, LineRecord[]>> {
    const result = new Map<string, LineRecord[]>(runIds.map((id) => [id, []] as const));
    if (runIds.length === 0) return result;
    const { rows } = await tx.query<RawLine>(
      `SELECT ${LINE} FROM cap.distribution_line l JOIN cap.distribution_run r ON r.id = l.distribution_run_id AND r.computation_no = l.computation_no
         JOIN cap.investor i ON i.id = l.investor_id
        WHERE l.distribution_run_id = ANY($1::uuid[]) ORDER BY length(i.investor_no), i.investor_no`,
      [[...new Set(runIds)]],
    );
    for (const r of rows) result.get(r.distribution_run_id)!.push(lineOf(r));
    return result;
  }

  async insertLines(tx: Transaction, lines: readonly LineRecord[], at: Date): Promise<void> {
    for (const l of lines) {
      await tx.query(
        `INSERT INTO cap.distribution_line (id, distribution_run_id, computation_no, investor_id, unit_days, allocated_pesewas, received_extra_pesewa, withheld_pesewas, net_payable_pesewas, created_at)
         VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10)`,
        [l.id, l.runId, l.computationNo, l.investorId, formatUnits(l.unitDaysE4), l.allocatedPesewas.toString(), l.receivedExtraPesewa, l.withheldPesewas.toString(), l.netPayablePesewas.toString(), at],
      );
    }
  }

  async line(tx: Transaction, id: string, forUpdate: boolean): Promise<LineRecord | null> {
    const { rows } = await tx.query<RawLine>(`SELECT ${LINE} FROM cap.distribution_line l WHERE l.id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : lineOf(rows[0]);
  }

  async insertPayment(tx: Transaction, p: PaymentRecord): Promise<void> {
    await tx.query(
      `INSERT INTO cap.distribution_payment (id, distribution_line_id, amount_pesewas, bank_account_id, external_reference, paid_at, journal_entry_id, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [p.id, p.lineId, p.amountPesewas.toString(), p.bankAccountId, p.externalReference, p.paidAt, p.journalEntryId, p.recordedAt, p.actorId],
    );
  }

  async paymentByReference(tx: Transaction, externalReference: string): Promise<PaymentRecord | null> {
    const { rows } = await tx.query<{ id: string; distribution_line_id: string; amount: string; bank_account_id: string; external_reference: string | null; paid_at: Date; journal_entry_id: string; recorded_at: Date; actor_id: string }>(
      'SELECT id, distribution_line_id, amount_pesewas::text AS amount, bank_account_id, external_reference, paid_at, journal_entry_id, recorded_at, actor_id FROM cap.distribution_payment WHERE external_reference = $1',
      [externalReference],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : { id: r.id, lineId: r.distribution_line_id, amountPesewas: BigInt(r.amount), bankAccountId: r.bank_account_id, externalReference: r.external_reference, paidAt: r.paid_at, journalEntryId: r.journal_entry_id, recordedAt: r.recorded_at, actorId: r.actor_id };
  }
}

