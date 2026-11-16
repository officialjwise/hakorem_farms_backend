import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DashboardStore } from '../application/dashboard-store';
import type { DayTotal, Period, SpeciesCount } from '../domain/dashboard';

/** The dashboard figures in plain SQL over published views only (ADR-0011, ADR-0023); never a module's own table. */
export class PgDashboardStore implements DashboardStore {
  async stockValueAtCost(tx: Transaction, branchIds: readonly string[]): Promise<bigint> {
    const { rows } = await tx.query<{ value: string }>('SELECT COALESCE(sum(v.value_pesewas), 0)::text AS value FROM inv.pub_stock_value v WHERE v.branch_id = ANY($1::uuid[])', [
      branchIds,
    ]);
    return BigInt(rows[0]!.value);
  }

  async animalsOnHand(tx: Transaction, branchIds: readonly string[]): Promise<SpeciesCount[]> {
    const { rows } = await tx.query<{ species_id: string | null; species_code: string | null; species_name: string | null; head: number }>(
      `SELECT p.species_id, p.species_code, p.species_name, count(DISTINCT s.stock_unit_id)::int AS head
         FROM inv.pub_stock_on_hand s
         JOIN mdm.pub_product p ON p.product_id = s.product_id
        WHERE s.branch_id = ANY($1::uuid[]) AND s.stock_unit_id IS NOT NULL AND s.on_hand_qty > 0 AND p.tracking = 'SERIAL'
        GROUP BY p.species_id, p.species_code, p.species_name`,
      [branchIds],
    );
    return rows.map((r) => ({ speciesId: r.species_id, code: r.species_code, name: r.species_name, count: r.head }));
  }

  async lowStockProducts(tx: Transaction, branchIds: readonly string[]): Promise<number> {
    const { rows } = await tx.query<{ n: number }>(
      'SELECT count(DISTINCT r.product_id)::int AS n FROM inv.pub_reorder_level r WHERE r.branch_id = ANY($1::uuid[]) AND r.at_or_below_reorder_point',
      [branchIds],
    );
    return rows[0]!.n;
  }

  async purchasesByDay(tx: Transaction, branchIds: readonly string[], period: Period): Promise<DayTotal[]> {
    const { rows } = await tx.query<{ day: string; value: string; receipts: number }>(
      `SELECT to_char(g.received_at AT TIME ZONE 'Africa/Accra', 'YYYY-MM-DD') AS day, sum(g.value_pesewas)::text AS value, count(*)::int AS receipts
         FROM inv.pub_goods_receipt g
        WHERE g.branch_id = ANY($1::uuid[]) AND g.kind = 'PURCHASE' AND g.status = 'POSTED'
          AND g.received_at >= ($2::date::timestamp AT TIME ZONE 'Africa/Accra')
          AND g.received_at < (($3::date + 1)::timestamp AT TIME ZONE 'Africa/Accra')
        GROUP BY 1`,
      [branchIds, period.from, period.to],
    );
    return rows.map((r) => ({ date: r.day, valuePesewas: BigInt(r.value), count: r.receipts }));
  }

  async cashBalances(tx: Transaction, branchIds: readonly string[]): Promise<{ readonly code: string; readonly balance: bigint }[]> {
    const { rows } = await tx.query<{ code: string; balance: string }>(
      'SELECT c.account_code AS code, sum(c.balance_pesewas)::text AS balance FROM fin.pub_cash_balance c WHERE c.branch_id = ANY($1::uuid[]) GROUP BY c.account_code ORDER BY c.account_code',
      [branchIds],
    );
    return rows.map((r) => ({ code: r.code, balance: BigInt(r.balance) }));
  }

  async receivablesBalance(tx: Transaction, branchIds: readonly string[]): Promise<bigint> {
    const { rows } = await tx.query<{ balance: string }>('SELECT COALESCE(sum(r.balance_pesewas), 0)::text AS balance FROM fin.pub_receivable_balance r WHERE r.branch_id = ANY($1::uuid[])', [branchIds]);
    return BigInt(rows[0]!.balance);
  }

  async overdueOutstanding(tx: Transaction, branchIds: readonly string[], today: string): Promise<bigint> {
    const { rows } = await tx.query<{ overdue: string }>(
      `SELECT COALESCE(sum(d.outstanding_pesewas), 0)::text AS overdue FROM bil.pub_document d
        WHERE d.branch_id = ANY($1::uuid[]) AND d.kind IN ('INVOICE', 'RECEIPT', 'DEBIT_NOTE') AND d.due_date < $2::date AND d.outstanding_pesewas > 0`,
      [branchIds, today],
    );
    return BigInt(rows[0]!.overdue);
  }
}
