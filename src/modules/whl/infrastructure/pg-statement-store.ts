import type { Transaction } from '../../../platform/database/unit-of-work';
import type { StatementFilter, StatementLineRecord, StatementRecord, StatementStore } from '../application/statement-store';

const STATEMENT_COLUMNS = `id, statement_no AS "statementNo", status, customer_id AS "customerId", branch_id AS "branchId",
  period_start::text AS "periodStart", period_end::text AS "periodEnd", opening_pesewas::text AS "openingPesewas",
  opening_credit_pesewas::text AS "openingCreditPesewas", invoiced_pesewas::text AS "invoicedPesewas", credited_pesewas::text AS "creditedPesewas",
  paid_pesewas::text AS "paidPesewas", other_charges_pesewas::text AS "otherChargesPesewas", other_credits_pesewas::text AS "otherCreditsPesewas",
  closing_pesewas::text AS "closingPesewas", closing_credit_pesewas::text AS "closingCreditPesewas", issue_date::text AS "issueDate",
  archived_document_id AS "archivedDocumentId"`;

const AMOUNTS = [
  'openingPesewas',
  'openingCreditPesewas',
  'invoicedPesewas',
  'creditedPesewas',
  'paidPesewas',
  'otherChargesPesewas',
  'otherCreditsPesewas',
  'closingPesewas',
  'closingCreditPesewas',
] as const;

type RawStatement = Omit<StatementRecord, (typeof AMOUNTS)[number]> & Record<(typeof AMOUNTS)[number], string>;
type RawLine = Omit<StatementLineRecord, 'debitPesewas' | 'creditPesewas' | 'balancePesewas'> & { debitPesewas: string; creditPesewas: string; balancePesewas: string };

function statement(row: RawStatement): StatementRecord {
  const amounts = Object.fromEntries(AMOUNTS.map((k) => [k, BigInt(row[k])])) as Record<(typeof AMOUNTS)[number], bigint>;
  return { ...row, ...amounts };
}

/** WHL's statements (migration 0242): written once with their lines; only the archived rendering is set later, once. */
export class PgStatementStore implements StatementStore {
  async insert(tx: Transaction, s: StatementRecord, lines: readonly StatementLineRecord[], actorId: string, at: Date): Promise<void> {
    const issued = s.status === 'ISSUED';
    await tx.query(
      `INSERT INTO whl.statement (id, statement_no, customer_id, period_start, period_end, opening_pesewas, opening_credit_pesewas, invoiced_pesewas,
         credited_pesewas, paid_pesewas, other_charges_pesewas, other_credits_pesewas, closing_pesewas, closing_credit_pesewas, issue_date, status,
         branch_id, created_at, created_by, updated_at, updated_by, posted_at, posted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $18, $19, $20, $21)`,
      [
        s.id,
        s.statementNo,
        s.customerId,
        s.periodStart,
        s.periodEnd,
        s.openingPesewas.toString(),
        s.openingCreditPesewas.toString(),
        s.invoicedPesewas.toString(),
        s.creditedPesewas.toString(),
        s.paidPesewas.toString(),
        s.otherChargesPesewas.toString(),
        s.otherCreditsPesewas.toString(),
        s.closingPesewas.toString(),
        s.closingCreditPesewas.toString(),
        s.issueDate,
        s.status,
        s.branchId,
        at,
        actorId,
        issued ? at : null,
        issued ? actorId : null,
      ],
    );
    await tx.query(
      `INSERT INTO whl.statement_line (statement_id, line_no, line_date, kind, reference, debit_pesewas, credit_pesewas, balance_pesewas, balance_side,
         source_document_id, recorded_at, actor_id)
       SELECT $1, l.line_no, l.line_date, l.kind, l.reference, l.debit, l.credit, l.balance, l.side, l.source, $2, $3
         FROM unnest($4::integer[], $5::date[], $6::text[], $7::text[], $8::bigint[], $9::bigint[], $10::bigint[], $11::text[], $12::uuid[])
           AS l (line_no, line_date, kind, reference, debit, credit, balance, side, source)`,
      [
        s.id,
        at,
        actorId,
        lines.map((l) => l.lineNo),
        lines.map((l) => l.date),
        lines.map((l) => l.kind),
        lines.map((l) => l.reference),
        lines.map((l) => l.debitPesewas.toString()),
        lines.map((l) => l.creditPesewas.toString()),
        lines.map((l) => l.balancePesewas.toString()),
        lines.map((l) => l.balanceSide),
        lines.map((l) => l.sourceDocumentId),
      ],
    );
  }

  async statement(tx: Transaction, id: string): Promise<StatementRecord | null> {
    const { rows } = await tx.query<RawStatement>(`SELECT ${STATEMENT_COLUMNS} FROM whl.statement WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : statement(rows[0]);
  }

  async issuedFor(tx: Transaction, key: { readonly customerId: string; readonly branchId: string; readonly periodStart: string; readonly periodEnd: string }): Promise<StatementRecord | null> {
    const { rows } = await tx.query<RawStatement>(
      `SELECT ${STATEMENT_COLUMNS} FROM whl.statement
        WHERE customer_id = $1 AND branch_id = $2 AND period_start = $3::date AND period_end = $4::date AND status = 'ISSUED'`,
      [key.customerId, key.branchId, key.periodStart, key.periodEnd],
    );
    return rows[0] === undefined ? null : statement(rows[0]);
  }

  async list(tx: Transaction, filter: StatementFilter, beforeId: string | null, limit: number): Promise<StatementRecord[]> {
    const { rows } = await tx.query<RawStatement>(
      `SELECT ${STATEMENT_COLUMNS} FROM whl.statement
        WHERE branch_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR customer_id = $2) AND ($3::date IS NULL OR period_end = $3::date)
          AND ($4::uuid IS NULL OR id < $4)
        ORDER BY id DESC LIMIT $5`,
      [filter.branchIds, filter.customerId, filter.periodEnd, beforeId, limit],
    );
    return rows.map(statement);
  }

  async lines(tx: Transaction, statementId: string): Promise<StatementLineRecord[]> {
    const { rows } = await tx.query<RawLine>(
      `SELECT line_no AS "lineNo", line_date::text AS date, kind, reference, debit_pesewas::text AS "debitPesewas", credit_pesewas::text AS "creditPesewas",
              balance_pesewas::text AS "balancePesewas", balance_side AS "balanceSide", source_document_id AS "sourceDocumentId"
         FROM whl.statement_line WHERE statement_id = $1 ORDER BY line_no`,
      [statementId],
    );
    return rows.map((r) => ({ ...r, debitPesewas: BigInt(r.debitPesewas), creditPesewas: BigInt(r.creditPesewas), balancePesewas: BigInt(r.balancePesewas) }));
  }

  async linkArchive(tx: Transaction, statementId: string, archivedDocumentId: string, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `UPDATE whl.statement SET archived_document_id = $2, version = version + 1, updated_at = $3, updated_by = $4
        WHERE id = $1 AND archived_document_id IS NULL`,
      [statementId, archivedDocumentId, at, actorId],
    );
  }
}
