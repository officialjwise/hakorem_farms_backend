import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  AccountFactsRow,
  ActivityFilters,
  ActivityLine,
  ActivityPosition,
  EntryFilters,
  EntryHeader,
  EntryLine,
  EntryPosition,
  JournalStore,
  ManualJournalRow,
  ManualLineRow,
  NewManualLine,
  PartyRow,
  PostingRuleRow,
  DeterminationRow,
  ReceivableFilters,
  ReceivableLineRow,
  RuleChangeRow,
} from '../application/journal-store';
import type { DeterminantType, RuleDeterminant, Side } from '../domain/posting';
import type { DatedDetermination, DatedRule } from '../domain/rule-change';

const ENTRY_COLUMNS = `e.id, e.entry_no AS "entryNo", e.posting_date::text AS "postingDate", e.period_id AS "periodId", p.fiscal_year AS "fiscalYear",
  p.period_no AS "periodNo", e.branch_id AS "branchId", e.kind, e.event_code AS "eventCode", e.source_document_id AS "sourceDocumentId",
  e.posting_group_id AS "postingGroupId", e.description, e.reverses_entry_id AS "reversesEntryId", e.occurred_at AS "occurredAt",
  e.recorded_at AS "recordedAt", e.actor_id AS "actorId",
  (SELECT COALESCE(sum(l.amount_pesewas), 0) FROM fin.journal_line l WHERE l.journal_entry_id = e.id AND l.side = 'D')::text AS "totalPesewas"`;
const MANUAL_COLUMNS = `id, kind, posting_date::text AS "postingDate", description, branch_id AS "branchId", status, revision,
  approval_request_id AS "approvalRequestId", journal_entry_id AS "journalEntryId", version, created_at AS "createdAt", created_by AS "createdBy"`;
const FACT_COLUMNS = `id, code, name, (is_postable AND status = 'ACTIVE' AND deleted_at IS NULL) AS postable, subledger_kind AS "subledgerKind", normal_side AS "normalSide"`;
const CHANGE_COLUMNS = `id, branch_id AS "branchId", target, event_code AS "eventCode", amount_key AS "amountKey", side, account_id AS "accountId",
  determinant_type AS "determinantType", determinant_role AS "determinantRole", determinant_key AS "determinantKey", subledger_from AS "subledgerFrom",
  valid_from::text AS "validFrom", status, approval_request_id AS "approvalRequestId", created_by AS "createdBy", version`;

type Raw<T, K extends keyof T> = Omit<T, K> & { [P in K]: string };

function party(row: { party_id: string | null; party_kind: PartyRow['kind'] | null; party_ref: string | null; party_name: string | null }): PartyRow | null {
  return row.party_id === null ? null : { id: row.party_id, kind: row.party_kind!, refId: row.party_ref!, displayName: row.party_name! };
}

/** Trade receivables (ADR-0003): the control account a customer's statement reads (B08 continued 2d, ADR-0085). */
const TRADE_RECEIVABLES = '1200';

/** The customer's 1200 lines at a branch: point reads on `ix_journal_line_subledger`, so a serializable reader locks only them. */
const RECEIVABLE_WHERE = `l.subledger_party_id = (SELECT p.id FROM fin.subledger_party p WHERE p.kind = 'CUSTOMER' AND p.ref_id = $1)
  AND l.account_id = (SELECT a.id FROM fin.account a WHERE a.code = '${TRADE_RECEIVABLES}') AND l.branch_id = $2`;

function activityWhere(first: number): string {
  return `l.account_id = $${first} AND ($${first + 1}::uuid IS NULL OR l.subledger_party_id = $${first + 1}) AND ($${first + 2}::uuid IS NULL OR l.branch_id = $${first + 2})`;
}

/** FIN's journal reads and its manual journal and rule change writes (migrations 0123, 0130). */
export class PgJournalStore implements JournalStore {
  async entries(tx: Transaction, filters: EntryFilters, before: EntryPosition | null, limit: number, branchIds: readonly string[]): Promise<EntryHeader[]> {
    const { rows } = await tx.query<Raw<EntryHeader, 'totalPesewas'>>(
      `SELECT ${ENTRY_COLUMNS} FROM fin.journal_entry e JOIN fin.accounting_period p ON p.id = e.period_id
        WHERE ($1::date IS NULL OR e.posting_date >= $1::date) AND ($2::date IS NULL OR e.posting_date <= $2::date)
          AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM fin.journal_line l WHERE l.journal_entry_id = e.id AND l.account_id = $3))
          AND ($4::uuid IS NULL OR e.source_document_id = $4) AND ($5::uuid IS NULL OR e.posting_group_id = $5)
          AND ($6::text IS NULL OR e.event_code = $6) AND ($7::text IS NULL OR e.kind = $7)
          AND ($8::date IS NULL OR (e.posting_date, e.id) < ($8::date, $9::uuid)) AND e.branch_id = ANY($11::uuid[])
        ORDER BY e.posting_date DESC, e.id DESC LIMIT $10`,
      [filters.from, filters.to, filters.accountId, filters.sourceDocumentId, filters.postingGroupId, filters.eventCode, filters.kind, before?.postingDate ?? null, before?.id ?? null, limit, branchIds],
    );
    return rows.map((r) => ({ ...r, totalPesewas: BigInt(r.totalPesewas) }));
  }

  async entry(tx: Transaction, id: string): Promise<EntryHeader | null> {
    const { rows } = await tx.query<Raw<EntryHeader, 'totalPesewas'>>(`SELECT ${ENTRY_COLUMNS} FROM fin.journal_entry e JOIN fin.accounting_period p ON p.id = e.period_id WHERE e.id = $1`, [id]);
    const row = rows[0];
    return row === undefined ? null : { ...row, totalPesewas: BigInt(row.totalPesewas) };
  }

  async entryOfSubject(tx: Transaction, subjectId: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM fin.journal_entry WHERE event_subject_id = $1 ORDER BY id DESC LIMIT 1', [subjectId]);
    return rows[0]?.id ?? null;
  }

  async linesOf(tx: Transaction, entryIds: readonly string[]): Promise<EntryLine[]> {
    if (entryIds.length === 0) return [];
    const { rows } = await tx.query<{
      entry_id: string;
      line_no: number;
      account_id: string;
      code: string;
      name: string;
      side: Side;
      amount: string;
      branch_id: string;
      product_line: string | null;
      memo: string | null;
      party_id: string | null;
      party_kind: PartyRow['kind'] | null;
      party_ref: string | null;
      party_name: string | null;
    }>(
      `SELECT l.journal_entry_id AS entry_id, l.line_no, l.account_id, a.code, a.name, l.side, l.amount_pesewas::text AS amount, l.branch_id, l.product_line, l.memo,
              s.id AS party_id, s.kind AS party_kind, s.ref_id AS party_ref, s.display_name AS party_name
         FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id LEFT JOIN fin.subledger_party s ON s.id = l.subledger_party_id
        WHERE l.journal_entry_id = ANY($1::uuid[]) ORDER BY l.journal_entry_id, l.line_no`,
      [entryIds],
    );
    return rows.map((r) => ({
      entryId: r.entry_id,
      lineNo: r.line_no,
      account: { id: r.account_id, code: r.code, name: r.name },
      side: r.side,
      amountPesewas: BigInt(r.amount),
      branchId: r.branch_id,
      party: party(r),
      productLine: r.product_line,
      memo: r.memo,
    }));
  }

  async activityBefore(tx: Transaction, filters: ActivityFilters): Promise<bigint> {
    const { rows } = await tx.query<{ total: string }>(
      `SELECT COALESCE(sum(CASE WHEN l.side = 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS total
         FROM fin.journal_line l WHERE ${activityWhere(1)} AND l.posting_date < $4::date`,
      [filters.accountId, filters.partyId, filters.branchId, filters.from],
    );
    return BigInt(rows[0]!.total);
  }

  async activityTotal(tx: Transaction, filters: ActivityFilters, upTo: ActivityPosition | null): Promise<bigint> {
    const { rows } = await tx.query<{ total: string }>(
      `SELECT COALESCE(sum(CASE WHEN l.side = 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS total
         FROM fin.journal_line l WHERE ${activityWhere(1)} AND l.posting_date BETWEEN $4::date AND $5::date
          AND ($6::date IS NULL OR (l.posting_date, l.journal_entry_id, l.line_no) <= ($6::date, $7::uuid, $8::integer))`,
      [filters.accountId, filters.partyId, filters.branchId, filters.from, filters.to, upTo?.postingDate ?? null, upTo?.entryId ?? null, upTo?.lineNo ?? null],
    );
    return BigInt(rows[0]!.total);
  }

  async activityLines(tx: Transaction, filters: ActivityFilters, after: ActivityPosition | null, limit: number): Promise<ActivityLine[]> {
    const { rows } = await tx.query<Raw<ActivityLine, 'amountPesewas'>>(
      `SELECT l.journal_entry_id AS "entryId", e.entry_no AS "entryNo", l.posting_date::text AS "postingDate", e.description, l.line_no AS "lineNo",
              l.side, l.amount_pesewas::text AS "amountPesewas", e.source_document_id AS "sourceDocumentId"
         FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id
        WHERE ${activityWhere(1)} AND l.posting_date BETWEEN $4::date AND $5::date
          AND ($6::date IS NULL OR (l.posting_date, l.journal_entry_id, l.line_no) > ($6::date, $7::uuid, $8::integer))
        ORDER BY l.posting_date, l.journal_entry_id, l.line_no LIMIT $9`,
      [filters.accountId, filters.partyId, filters.branchId, filters.from, filters.to, after?.postingDate ?? null, after?.entryId ?? null, after?.lineNo ?? null, limit],
    );
    return rows.map((r) => ({ ...r, amountPesewas: BigInt(r.amountPesewas) }));
  }

  async receivableBefore(tx: Transaction, filters: ReceivableFilters): Promise<bigint> {
    const { rows } = await tx.query<{ total: string }>(
      `SELECT COALESCE(sum(CASE WHEN l.side = 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS total
         FROM fin.journal_line l WHERE ${RECEIVABLE_WHERE} AND l.posting_date < $3::date`,
      [filters.customerId, filters.branchId, filters.from],
    );
    return BigInt(rows[0]!.total);
  }

  async receivableLines(tx: Transaction, filters: ReceivableFilters): Promise<ReceivableLineRow[]> {
    const { rows } = await tx.query<Raw<ReceivableLineRow, 'amountPesewas'>>(
      `SELECT l.posting_date::text AS "postingDate", l.journal_entry_id AS "entryId", e.entry_no AS "entryNo", l.line_no AS "lineNo", l.side,
              l.amount_pesewas::text AS "amountPesewas", e.event_code AS "eventCode", e.kind AS "entryKind", e.source_document_id AS "sourceDocumentId"
         FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id
        WHERE ${RECEIVABLE_WHERE} AND l.posting_date BETWEEN $3::date AND $4::date
        ORDER BY l.posting_date, e.entry_no, l.line_no`,
      [filters.customerId, filters.branchId, filters.from, filters.to],
    );
    return rows.map((r) => ({ ...r, amountPesewas: BigInt(r.amountPesewas) }));
  }

  async receivableBalances(tx: Transaction, filters: { readonly branchIds: readonly string[]; readonly customerId: string | null; readonly asOf: string }): Promise<ReadonlyMap<string, bigint>> {
    const { rows } = await tx.query<{ customer_id: string; total: string }>(
      `SELECT p.ref_id AS customer_id, sum(CASE WHEN l.side = 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS total
         FROM fin.journal_line l JOIN fin.subledger_party p ON p.id = l.subledger_party_id AND p.kind = 'CUSTOMER'
        WHERE l.account_id = (SELECT a.id FROM fin.account a WHERE a.code = '${TRADE_RECEIVABLES}') AND l.branch_id = ANY($1::uuid[])
          AND ($2::uuid IS NULL OR p.ref_id = $2) AND l.posting_date <= $3::date
        GROUP BY p.ref_id
       HAVING sum(CASE WHEN l.side = 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END) <> 0`,
      [filters.branchIds, filters.customerId, filters.asOf],
    );
    return new Map(rows.map((r) => [r.customer_id, BigInt(r.total)]));
  }

  async accountFacts(tx: Transaction, ids: readonly string[]): Promise<Map<string, AccountFactsRow>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<AccountFactsRow>(`SELECT ${FACT_COLUMNS} FROM fin.account WHERE id = ANY($1::uuid[])`, [ids]);
    return new Map(rows.map((r) => [r.id, r]));
  }

  async allAccountFacts(tx: Transaction): Promise<Map<string, AccountFactsRow>> {
    const { rows } = await tx.query<AccountFactsRow>(`SELECT ${FACT_COLUMNS} FROM fin.account`);
    return new Map(rows.map((r) => [r.id, r]));
  }

  async accountByCode(tx: Transaction, code: string): Promise<AccountFactsRow | null> {
    const { rows } = await tx.query<AccountFactsRow>(`SELECT ${FACT_COLUMNS} FROM fin.account WHERE code = $1 AND deleted_at IS NULL`, [code]);
    return rows[0] ?? null;
  }

  async parties(tx: Transaction, ids: readonly string[]): Promise<Map<string, PartyRow>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<PartyRow>('SELECT id, kind, ref_id AS "refId", display_name AS "displayName" FROM fin.subledger_party WHERE id = ANY($1::uuid[])', [ids]);
    return new Map(rows.map((r) => [r.id, r]));
  }

  async manualJournals(tx: Transaction, filters: { readonly status: string | null; readonly kind: string | null }, beforeId: string | null, limit: number, branchIds: readonly string[]): Promise<ManualJournalRow[]> {
    const { rows } = await tx.query<ManualJournalRow>(
      `SELECT ${MANUAL_COLUMNS} FROM fin.manual_journal
        WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR kind = $2) AND ($3::uuid IS NULL OR id < $3) AND branch_id = ANY($5::uuid[])
        ORDER BY id DESC LIMIT $4`,
      [filters.status, filters.kind, beforeId, limit, branchIds],
    );
    return rows;
  }

  async manualJournal(tx: Transaction, id: string, forUpdate: boolean): Promise<ManualJournalRow | null> {
    const { rows } = await tx.query<ManualJournalRow>(`SELECT ${MANUAL_COLUMNS} FROM fin.manual_journal WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] ?? null;
  }

  async manualLines(tx: Transaction, journals: readonly Pick<ManualJournalRow, 'id' | 'revision'>[]): Promise<Map<string, ManualLineRow[]>> {
    const result = new Map<string, ManualLineRow[]>(journals.map((j) => [j.id, []]));
    if (journals.length === 0) return result;
    const { rows } = await tx.query<{
      journal_id: string;
      id: string;
      line_no: number;
      account_id: string;
      code: string;
      name: string;
      side: Side;
      amount: string;
      memo: string | null;
      party_id: string | null;
      party_kind: PartyRow['kind'] | null;
      party_ref: string | null;
      party_name: string | null;
    }>(
      `SELECT m.manual_journal_id AS journal_id, m.id, m.line_no, m.account_id, a.code, a.name, m.side, m.amount_pesewas::text AS amount, m.memo,
              s.id AS party_id, s.kind AS party_kind, s.ref_id AS party_ref, s.display_name AS party_name
         FROM fin.manual_journal_line m
         JOIN unnest($1::uuid[], $2::integer[]) AS j (id, revision) ON j.id = m.manual_journal_id AND j.revision = m.revision
         JOIN fin.account a ON a.id = m.account_id LEFT JOIN fin.subledger_party s ON s.id = m.subledger_party_id
        ORDER BY m.manual_journal_id, m.line_no`,
      [journals.map((j) => j.id), journals.map((j) => j.revision)],
    );
    for (const r of rows) {
      result.get(r.journal_id)!.push({ id: r.id, lineNo: r.line_no, account: { id: r.account_id, code: r.code, name: r.name }, side: r.side, amountPesewas: BigInt(r.amount), party: party(r), memo: r.memo });
    }
    return result;
  }

  async insertManualJournal(tx: Transaction, row: ManualJournalRow): Promise<void> {
    await tx.query(
      `INSERT INTO fin.manual_journal (id, kind, posting_date, description, branch_id, status, revision, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [row.id, row.kind, row.postingDate, row.description, row.branchId, row.status, row.revision, row.createdBy],
    );
  }

  async insertManualLines(tx: Transaction, journalId: string, revision: number, lines: readonly NewManualLine[], actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO fin.manual_journal_line (id, manual_journal_id, revision, line_no, account_id, side, amount_pesewas, subledger_party_id, memo, created_by)
       SELECT l.id, $1, $2, l.line_no, l.account_id, l.side, l.amount, l.party, l.memo, $3
         FROM unnest($4::uuid[], $5::integer[], $6::uuid[], $7::char(1)[], $8::bigint[], $9::uuid[], $10::text[]) AS l (id, line_no, account_id, side, amount, party, memo)`,
      [
        journalId,
        revision,
        actorId,
        lines.map((l) => l.id),
        lines.map((l) => l.lineNo),
        lines.map((l) => l.accountId),
        lines.map((l) => l.side),
        lines.map((l) => String(l.amountPesewas)),
        lines.map((l) => l.subledgerPartyId),
        lines.map((l) => l.memo),
      ],
    );
  }

  async reviseManualJournal(tx: Transaction, id: string, change: { readonly postingDate: string; readonly description: string; readonly revision: number }, actorId: string): Promise<void> {
    await tx.query('UPDATE fin.manual_journal SET posting_date = $2, description = $3, revision = $4, updated_by = $5, version = version + 1 WHERE id = $1', [
      id,
      change.postingDate,
      change.description,
      change.revision,
      actorId,
    ]);
  }

  async submitManualJournal(tx: Transaction, id: string, approvalRequestId: string, actorId: string): Promise<void> {
    await tx.query("UPDATE fin.manual_journal SET status = 'PENDING_APPROVAL', approval_request_id = $2, updated_by = $3, version = version + 1 WHERE id = $1", [id, approvalRequestId, actorId]);
  }

  async decideManualJournal(tx: Transaction, id: string, decision: { readonly status: 'POSTED' | 'REJECTED'; readonly journalEntryId: string | null; readonly decidedBy: string; readonly at: Date }): Promise<void> {
    await tx.query('UPDATE fin.manual_journal SET status = $2, journal_entry_id = $3, decided_by = $4, decided_at = $5, updated_by = $4, version = version + 1 WHERE id = $1', [
      id,
      decision.status,
      decision.journalEntryId,
      decision.decidedBy,
      decision.at,
    ]);
  }

  async openingTaken(tx: Transaction, exceptId: string): Promise<boolean> {
    const { rows } = await tx.query("SELECT 1 FROM fin.manual_journal WHERE kind = 'OPENING' AND status IN ('PENDING_APPROVAL', 'POSTED') AND id <> $1", [exceptId]);
    return rows.length > 0;
  }

  async eventTypes(tx: Transaction): Promise<{ readonly code: string; readonly ownerModule: string; readonly description: string; readonly amountKeys: readonly string[] }[]> {
    const { rows } = await tx.query<{ code: string; ownerModule: string; description: string; amountKeys: string[] }>(
      'SELECT code, owner_module AS "ownerModule", description, amount_keys AS "amountKeys" FROM fin.posting_event_type ORDER BY code',
    );
    return rows;
  }

  async postingRules(tx: Transaction, filters: { readonly eventCode: string | null; readonly at: string | null }, afterId: string | null, limit: number): Promise<PostingRuleRow[]> {
    const { rows } = await tx.query<
      DatedRule & { subledgerFrom: string | null; approvalRequestId: string | null; code: string | null; name: string | null }
    >(
      `SELECT r.id, r.event_code AS "eventCode", r.amount_key AS "amountKey", r.side, r.account_id AS "accountId", r.determinant_type AS "determinantType",
              r.determinant_role AS "determinantRole", r.subledger_from AS "subledgerFrom", r.valid_from::text AS "validFrom", r.valid_to::text AS "validTo",
              r.approval_request_id AS "approvalRequestId", a.code, a.name
         FROM fin.posting_rule r LEFT JOIN fin.account a ON a.id = r.account_id
        WHERE r.deleted_at IS NULL AND ($1::text IS NULL OR r.event_code = $1)
          AND ($2::date IS NULL OR (r.valid_from <= $2::date AND (r.valid_to IS NULL OR r.valid_to > $2::date)))
          AND ($3::uuid IS NULL OR r.id > $3)
        ORDER BY r.id LIMIT $4`,
      [filters.eventCode, filters.at, afterId, limit],
    );
    return rows.map(({ code, name, ...r }) => ({ ...r, account: r.accountId === null ? null : { id: r.accountId, code: code!, name: name! } }));
  }

  async rulesOfEvent(tx: Transaction, eventCode: string): Promise<DatedRule[]> {
    const { rows } = await tx.query<DatedRule>(
      `SELECT id, event_code AS "eventCode", amount_key AS "amountKey", side, account_id AS "accountId", determinant_type AS "determinantType",
              determinant_role AS "determinantRole", valid_from::text AS "validFrom", valid_to::text AS "validTo"
         FROM fin.posting_rule WHERE event_code = $1 AND deleted_at IS NULL`,
      [eventCode],
    );
    return rows;
  }

  async determinations(tx: Transaction, filters: { readonly type: string | null }, afterId: string | null, limit: number): Promise<DeterminationRow[]> {
    const { rows } = await tx.query<DatedDetermination & { approvalRequestId: string | null; code: string; name: string }>(
      `SELECT d.id, d.determinant_type AS type, d.determinant_key AS key, d.role, d.account_id AS "accountId", d.valid_from::text AS "validFrom",
              d.valid_to::text AS "validTo", d.approval_request_id AS "approvalRequestId", a.code, a.name
         FROM fin.account_determination d JOIN fin.account a ON a.id = d.account_id
        WHERE d.deleted_at IS NULL AND ($1::text IS NULL OR d.determinant_type = $1) AND ($2::uuid IS NULL OR d.id > $2)
        ORDER BY d.id LIMIT $3`,
      [filters.type, afterId, limit],
    );
    return rows.map(({ code, name, ...r }) => ({ ...r, account: { id: r.accountId, code, name } }));
  }

  async allDeterminations(tx: Transaction): Promise<DatedDetermination[]> {
    const { rows } = await tx.query<DatedDetermination>(
      `SELECT id, determinant_type AS type, determinant_key AS key, role, account_id AS "accountId", valid_from::text AS "validFrom", valid_to::text AS "validTo"
         FROM fin.account_determination WHERE deleted_at IS NULL`,
    );
    return rows;
  }

  async ruleChangePending(tx: Transaction, change: Pick<RuleChangeRow, 'target' | 'eventCode' | 'amountKey' | 'side' | 'determinantType' | 'determinantKey' | 'determinantRole'>): Promise<boolean> {
    const { rows } = await tx.query(
      `SELECT 1 FROM fin.posting_rule_change WHERE status = 'PENDING_APPROVAL' AND target = $1
          AND ((target = 'RULE' AND event_code = $2 AND amount_key = $3 AND side = $4)
            OR (target = 'DETERMINATION' AND determinant_type = $5 AND determinant_key = $6 AND determinant_role = $7))`,
      [change.target, change.eventCode, change.amountKey, change.side, change.determinantType, change.determinantKey, change.determinantRole],
    );
    return rows.length > 0;
  }

  async insertRuleChange(tx: Transaction, row: RuleChangeRow): Promise<void> {
    await tx.query(
      `INSERT INTO fin.posting_rule_change (id, branch_id, target, event_code, amount_key, side, account_id, determinant_type, determinant_role, determinant_key,
                                            subledger_from, valid_from, status, approval_request_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
      [
        row.id,
        row.branchId,
        row.target,
        row.eventCode,
        row.amountKey,
        row.side,
        row.accountId,
        row.determinantType,
        row.determinantRole,
        row.determinantKey,
        row.subledgerFrom,
        row.validFrom,
        row.status,
        row.approvalRequestId,
        row.createdBy,
      ],
    );
  }

  async ruleChange(tx: Transaction, id: string, forUpdate: boolean): Promise<RuleChangeRow | null> {
    const { rows } = await tx.query<RuleChangeRow>(`SELECT ${CHANGE_COLUMNS} FROM fin.posting_rule_change WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] ?? null;
  }

  async decideRuleChange(
    tx: Transaction,
    id: string,
    decision: { readonly status: 'POSTED' | 'REJECTED'; readonly effectiveFrom: string | null; readonly postingRuleId: string | null; readonly determinationId: string | null; readonly decidedBy: string; readonly at: Date },
  ): Promise<void> {
    await tx.query(
      `UPDATE fin.posting_rule_change SET status = $2, effective_from = $3, posting_rule_id = $4, account_determination_id = $5, decided_by = $6, decided_at = $7,
              updated_by = $6, version = version + 1 WHERE id = $1`,
      [id, decision.status, decision.effectiveFrom, decision.postingRuleId, decision.determinationId, decision.decidedBy, decision.at],
    );
  }

  async endRule(tx: Transaction, id: string, validTo: string, actorId: string): Promise<void> {
    await tx.query('UPDATE fin.posting_rule SET valid_to = $2, updated_by = $3, version = version + 1 WHERE id = $1', [id, validTo, actorId]);
  }

  async insertRule(
    tx: Transaction,
    row: { readonly id: string; readonly eventCode: string; readonly amountKey: string; readonly side: Side; readonly accountId: string | null; readonly determinantType: RuleDeterminant | null; readonly determinantRole: string | null; readonly subledgerFrom: string | null; readonly validFrom: string; readonly approvalRequestId: string },
    actorId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, approval_request_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [row.id, row.eventCode, row.amountKey, row.side, row.accountId, row.determinantType, row.determinantRole, row.subledgerFrom, row.validFrom, row.approvalRequestId, actorId],
    );
  }

  async endDetermination(tx: Transaction, id: string, validTo: string, actorId: string): Promise<void> {
    await tx.query('UPDATE fin.account_determination SET valid_to = $2, updated_by = $3, version = version + 1 WHERE id = $1', [id, validTo, actorId]);
  }

  async insertDetermination(
    tx: Transaction,
    row: { readonly id: string; readonly type: DeterminantType; readonly key: string; readonly role: string; readonly accountId: string; readonly validFrom: string; readonly approvalRequestId: string },
    actorId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO fin.account_determination (id, determinant_type, determinant_key, role, account_id, valid_from, approval_request_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [row.id, row.type, row.key, row.role, row.accountId, row.validFrom, row.approvalRequestId, actorId],
    );
  }
}
