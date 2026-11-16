import type { Transaction } from '../../../platform/database/unit-of-work';
import type { PeriodBalanceDrift, StatementRange, StatementStore } from '../application/statement-store';
import type { SubledgerKind } from '../domain/posting';
import type { CashFlowCategory, CashFlowLine, StatementAccount } from '../domain/statements';
import type { YearEndBalance } from '../domain/year-close';

type Figures = { od: string; oc: string; d: string; c: string; cd: string; cc: string };

/**
 * The statements in plain SQL (ADR-0058). The covered periods are the LOCKED and CLOSED ones wholly before the range
 * (its opening) or wholly inside it; their figures come from `fin.period_balance`, everything else from the lines.
 * Read committed: one statement per query, so each statement is one consistent snapshot.
 */
export class PgStatementStore implements StatementStore {
  async accounts(tx: Transaction, range: StatementRange): Promise<StatementAccount[]> {
    const { rows } = await tx.query<{ id: string; code: string; name: string; type: StatementAccount['type']; cash_flow_category: CashFlowCategory | null } & Figures>(
      `WITH covered AS (
         SELECT p.id, (p.end_date < $1::date) AS before_range
           FROM fin.accounting_period p
          WHERE p.status IN ('LOCKED', 'CLOSED') AND (p.end_date < $1::date OR (p.start_date >= $1::date AND p.end_date <= $2::date))
       ),
       projected AS (
         SELECT b.account_id,
                sum(b.debit_total_pesewas) FILTER (WHERE c.before_range) AS od, sum(b.credit_total_pesewas) FILTER (WHERE c.before_range) AS oc,
                sum(b.debit_total_pesewas) FILTER (WHERE NOT c.before_range) AS d, sum(b.credit_total_pesewas) FILTER (WHERE NOT c.before_range) AS c,
                sum(b.debit_total_pesewas) FILTER (WHERE NOT c.before_range AND b.is_closing) AS cd,
                sum(b.credit_total_pesewas) FILTER (WHERE NOT c.before_range AND b.is_closing) AS cc
           FROM fin.period_balance b JOIN covered c ON c.id = b.period_id
          WHERE ($3::uuid IS NULL OR b.branch_id = $3::uuid)
          GROUP BY b.account_id
       ),
       lined AS (
         SELECT l.account_id,
                sum(l.amount_pesewas) FILTER (WHERE l.side = 'D' AND l.posting_date < $1::date) AS od,
                sum(l.amount_pesewas) FILTER (WHERE l.side = 'C' AND l.posting_date < $1::date) AS oc,
                sum(l.amount_pesewas) FILTER (WHERE l.side = 'D' AND l.posting_date >= $1::date) AS d,
                sum(l.amount_pesewas) FILTER (WHERE l.side = 'C' AND l.posting_date >= $1::date) AS c,
                sum(l.amount_pesewas) FILTER (WHERE l.side = 'D' AND l.posting_date >= $1::date AND e.kind = 'CLOSING') AS cd,
                sum(l.amount_pesewas) FILTER (WHERE l.side = 'C' AND l.posting_date >= $1::date AND e.kind = 'CLOSING') AS cc
           FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id
          WHERE l.posting_date <= $2::date AND ($3::uuid IS NULL OR l.branch_id = $3::uuid)
            AND NOT EXISTS (SELECT 1 FROM covered c WHERE c.id = e.period_id)
          GROUP BY l.account_id
       )
       SELECT a.id, a.code, a.name, a.type, a.cash_flow_category,
              (COALESCE(p.od, 0) + COALESCE(l.od, 0))::text AS od, (COALESCE(p.oc, 0) + COALESCE(l.oc, 0))::text AS oc,
              (COALESCE(p.d, 0) + COALESCE(l.d, 0))::text AS d, (COALESCE(p.c, 0) + COALESCE(l.c, 0))::text AS c,
              (COALESCE(p.cd, 0) + COALESCE(l.cd, 0))::text AS cd, (COALESCE(p.cc, 0) + COALESCE(l.cc, 0))::text AS cc
         FROM fin.account a LEFT JOIN projected p ON p.account_id = a.id LEFT JOIN lined l ON l.account_id = a.id
        WHERE a.deleted_at IS NULL
        ORDER BY a.code`,
      [range.from, range.to, range.branchId],
    );
    return rows.map((r) => ({
      accountId: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      cashFlowCategory: r.cash_flow_category,
      openingDebit: BigInt(r.od),
      openingCredit: BigInt(r.oc),
      debit: BigInt(r.d),
      credit: BigInt(r.c),
      closingEntryDebit: BigInt(r.cd),
      closingEntryCredit: BigInt(r.cc),
    }));
  }

  async cashFlowLines(tx: Transaction, range: StatementRange, cash: { readonly from: string; readonly to: string }): Promise<CashFlowLine[]> {
    const { rows } = await tx.query<{ id: string; code: string; name: string; cash_flow_category: CashFlowCategory | null; inflow: string }>(
      `WITH moved AS (
         SELECT DISTINCT c.journal_entry_id FROM fin.journal_line c JOIN fin.account ca ON ca.id = c.account_id
          WHERE ca.code BETWEEN $4 AND $5 AND c.posting_date BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR c.branch_id = $3::uuid)
       )
       SELECT a.id, a.code, a.name, a.cash_flow_category, sum(CASE l.side WHEN 'C' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS inflow
         FROM moved m JOIN fin.journal_line l ON l.journal_entry_id = m.journal_entry_id JOIN fin.account a ON a.id = l.account_id
        WHERE NOT (a.code BETWEEN $4 AND $5) AND ($3::uuid IS NULL OR l.branch_id = $3::uuid)
        GROUP BY a.id, a.code, a.name, a.cash_flow_category
        ORDER BY a.code`,
      [range.from, range.to, range.branchId, cash.from, cash.to],
    );
    return rows.map((r) => ({ accountId: r.id, code: r.code, name: r.name, category: r.cash_flow_category, inflow: BigInt(r.inflow) }));
  }

  async yearEndBalances(tx: Transaction, date: string, codes: readonly string[]): Promise<(YearEndBalance & { readonly branchId: string })[]> {
    const { rows } = await tx.query<{
      branch_id: string;
      id: string;
      code: string;
      type: YearEndBalance['type'];
      party_id: string | null;
      kind: SubledgerKind | null;
      ref_id: string | null;
      display_name: string | null;
      balance: string;
    }>(
      `SELECT l.branch_id, a.id, a.code, a.type, s.id AS party_id, s.kind, s.ref_id, s.display_name,
              sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS balance
         FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id LEFT JOIN fin.subledger_party s ON s.id = l.subledger_party_id
        WHERE l.posting_date <= $1::date AND (a.type IN ('INCOME', 'COST_OF_SALES', 'EXPENSE') OR a.code = ANY($2::text[]))
        GROUP BY l.branch_id, a.id, a.code, a.type, s.id, s.kind, s.ref_id, s.display_name
       HAVING sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END) <> 0
        ORDER BY l.branch_id, a.code, s.id NULLS FIRST`,
      [date, codes],
    );
    return rows.map((r) => ({
      branchId: r.branch_id,
      accountId: r.id,
      code: r.code,
      type: r.type,
      subledger: r.party_id === null ? null : { kind: r.kind!, refId: r.ref_id!, displayName: r.display_name! },
      balance: BigInt(r.balance),
    }));
  }

  async openPeriodsUpTo(tx: Transaction, date: string): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM fin.accounting_period WHERE status = 'OPEN' AND start_date <= $1::date ORDER BY start_date", [date]);
    return rows.map((r) => r.id);
  }

  async refreshPeriodBalances(tx: Transaction, periodIds: readonly string[]): Promise<number> {
    let written = 0;
    for (const id of periodIds) {
      const { rows } = await tx.query<{ written: number }>('SELECT fin.refresh_period_balance($1) AS written', [id]);
      written += rows[0]!.written;
    }
    return written;
  }

  async periodBalanceDrift(tx: Transaction): Promise<PeriodBalanceDrift[]> {
    const { rows } = await tx.query<{ period_id: string; account_id: string; branch_id: string; pd: string; pc: string; ld: string; lc: string }>(
      `WITH projected AS (
         SELECT b.period_id, b.account_id, b.branch_id, sum(b.debit_total_pesewas) AS d, sum(b.credit_total_pesewas) AS c
           FROM fin.period_balance b JOIN fin.accounting_period p ON p.id = b.period_id WHERE p.status IN ('LOCKED', 'CLOSED')
          GROUP BY b.period_id, b.account_id, b.branch_id
       ),
       lined AS (
         SELECT e.period_id, l.account_id, l.branch_id,
                sum(l.amount_pesewas) FILTER (WHERE l.side = 'D') AS d, sum(l.amount_pesewas) FILTER (WHERE l.side = 'C') AS c
           FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.accounting_period p ON p.id = e.period_id
          WHERE p.status IN ('LOCKED', 'CLOSED')
          GROUP BY e.period_id, l.account_id, l.branch_id
       )
       SELECT COALESCE(p.period_id, l.period_id) AS period_id, COALESCE(p.account_id, l.account_id) AS account_id, COALESCE(p.branch_id, l.branch_id) AS branch_id,
              COALESCE(p.d, 0)::text AS pd, COALESCE(p.c, 0)::text AS pc, COALESCE(l.d, 0)::text AS ld, COALESCE(l.c, 0)::text AS lc
         FROM projected p FULL JOIN lined l ON l.period_id = p.period_id AND l.account_id = p.account_id AND l.branch_id = p.branch_id
        WHERE COALESCE(p.d, 0) <> COALESCE(l.d, 0) OR COALESCE(p.c, 0) <> COALESCE(l.c, 0)
        ORDER BY 1, 2, 3`,
    );
    return rows.map((r) => ({
      periodId: r.period_id,
      accountId: r.account_id,
      branchId: r.branch_id,
      projectedDebitPesewas: BigInt(r.pd),
      projectedCreditPesewas: BigInt(r.pc),
      lineDebitPesewas: BigInt(r.ld),
      lineCreditPesewas: BigInt(r.lc),
    }));
  }
}
