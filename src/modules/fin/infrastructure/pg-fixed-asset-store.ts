import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DepreciationLineRow, DepreciationRunRow, DisposalRecord, FixedAssetRow, FixedAssetStore, NewFixedAsset } from '../application/fixed-asset-store';
import type { AssetCategory, AssetStatus } from '../domain/fixed-asset';

const ASSET_COLUMNS = `a.id, a.asset_no AS "assetNo", a.name, a.category, a.branch_id AS "branchId", a.acquired_on::text AS "acquiredOn",
  a.cost_pesewas::text AS "costPesewas", a.residual_pesewas::text AS "residualPesewas", a.useful_life_months AS "usefulLifeMonths",
  a.accumulated_pesewas::text AS "accumulatedPesewas", a.depreciated_months AS "depreciatedMonths", a.status, a.disposed_on::text AS "disposedOn", a.version`;

const RUN_COLUMNS = `r.id, r.period_id AS "periodId", p.fiscal_year AS "fiscalYear", p.period_no AS "periodNo", r.branch_id AS "branchId", r.status,
  r.total_pesewas::text AS "totalPesewas", r.journal_entry_id AS "journalEntryId", r.created_at AS "createdAt", r.created_by AS "createdBy"`;

type RawAsset = Omit<FixedAssetRow, 'costPesewas' | 'residualPesewas' | 'accumulatedPesewas'> & { costPesewas: string; residualPesewas: string; accumulatedPesewas: string };
type RawRun = Omit<DepreciationRunRow, 'totalPesewas'> & { totalPesewas: string };

const asset = (r: RawAsset): FixedAssetRow => ({ ...r, costPesewas: BigInt(r.costPesewas), residualPesewas: BigInt(r.residualPesewas), accumulatedPesewas: BigInt(r.accumulatedPesewas) });
const run = (r: RawRun): DepreciationRunRow => ({ ...r, totalPesewas: BigInt(r.totalPesewas) });

/** FIN's register and runs. Every write names its actor; the version moves by one (platform.touch_version). */
export class PgFixedAssetStore implements FixedAssetStore {
  async assets(tx: Transaction, filters: { readonly category: AssetCategory | null; readonly status: AssetStatus | null }, after: { readonly assetNo: string; readonly id: string } | null, limit: number, branchIds: readonly string[]): Promise<FixedAssetRow[]> {
    const { rows } = await tx.query<RawAsset>(
      `SELECT ${ASSET_COLUMNS} FROM fin.fixed_asset a
        WHERE ($1::text IS NULL OR a.category = $1) AND ($2::text IS NULL OR a.status = $2)
          AND ($3::text IS NULL OR (a.asset_no, a.id) > ($3, $4::uuid)) AND a.branch_id = ANY($6::uuid[])
        ORDER BY a.asset_no, a.id LIMIT $5`,
      [filters.category, filters.status, after?.assetNo ?? null, after?.id ?? null, limit, branchIds],
    );
    return rows.map(asset);
  }

  async asset(tx: Transaction, id: string, forUpdate: boolean): Promise<FixedAssetRow | null> {
    const { rows } = await tx.query<RawAsset>(`SELECT ${ASSET_COLUMNS} FROM fin.fixed_asset a WHERE a.id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : asset(rows[0]);
  }

  async assetsInServiceOn(tx: Transaction, day: string): Promise<FixedAssetRow[]> {
    const { rows } = await tx.query<RawAsset>(`SELECT ${ASSET_COLUMNS} FROM fin.fixed_asset a WHERE a.status = 'IN_USE' AND a.acquired_on <= $1::date ORDER BY a.asset_no, a.id`, [day]);
    return rows.map(asset);
  }

  async insertAsset(tx: Transaction, row: NewFixedAsset, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO fin.fixed_asset (id, name, category, branch_id, acquired_on, cost_pesewas, residual_pesewas, useful_life_months, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $9)`,
      [row.id, row.name, row.category, row.branchId, row.acquiredOn, row.costPesewas.toString(), row.residualPesewas.toString(), row.usefulLifeMonths, actorId],
    );
  }

  async updateAsset(tx: Transaction, id: string, change: { readonly name: string; readonly usefulLifeMonths: number; readonly residualPesewas: bigint }, actorId: string): Promise<void> {
    await tx.query('UPDATE fin.fixed_asset SET version = version + 1, name = $2, useful_life_months = $3, residual_pesewas = $4, updated_by = $5 WHERE id = $1', [
      id,
      change.name,
      change.usefulLifeMonths,
      change.residualPesewas.toString(),
      actorId,
    ]);
  }

  async disposeAsset(tx: Transaction, id: string, disposal: DisposalRecord, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE fin.fixed_asset SET version = version + 1, status = 'DISPOSED', disposed_on = $2::date, disposal_document_id = $3, disposal_proceeds_pesewas = $4,
              disposal_note = $5, disposal_journal_entry_id = $6, updated_by = $7
        WHERE id = $1`,
      [id, disposal.disposedOn, disposal.documentId, disposal.proceedsPesewas.toString(), disposal.note, disposal.journalEntryId, actorId],
    );
  }

  async onPendingRun(tx: Transaction, assetId: string): Promise<boolean> {
    const { rows } = await tx.query(
      `SELECT 1 FROM fin.depreciation_line l JOIN fin.depreciation_run r ON r.id = l.depreciation_run_id JOIN fin.accounting_period p ON p.id = r.period_id
        WHERE l.fixed_asset_id = $1 AND r.status = 'DRAFT' AND p.status = 'OPEN'`,
      [assetId],
    );
    return rows.length > 0;
  }

  async runs(tx: Transaction, beforeId: string | null, limit: number, branchIds: readonly string[]): Promise<DepreciationRunRow[]> {
    const { rows } = await tx.query<RawRun>(
      `SELECT ${RUN_COLUMNS} FROM fin.depreciation_run r JOIN fin.accounting_period p ON p.id = r.period_id
        WHERE ($1::uuid IS NULL OR r.id < $1) AND r.branch_id = ANY($3::uuid[]) ORDER BY r.id DESC LIMIT $2`,
      [beforeId, limit, branchIds],
    );
    return rows.map(run);
  }

  async run(tx: Transaction, id: string, forUpdate: boolean): Promise<DepreciationRunRow | null> {
    const { rows } = await tx.query<RawRun>(`SELECT ${RUN_COLUMNS} FROM fin.depreciation_run r JOIN fin.accounting_period p ON p.id = r.period_id WHERE r.id = $1${forUpdate ? ' FOR UPDATE OF r' : ''}`, [id]);
    return rows[0] === undefined ? null : run(rows[0]);
  }

  async runOfPeriod(tx: Transaction, periodId: string): Promise<DepreciationRunRow | null> {
    const { rows } = await tx.query<RawRun>(`SELECT ${RUN_COLUMNS} FROM fin.depreciation_run r JOIN fin.accounting_period p ON p.id = r.period_id WHERE r.period_id = $1`, [periodId]);
    return rows[0] === undefined ? null : run(rows[0]);
  }

  async insertRun(tx: Transaction, row: { readonly id: string; readonly periodId: string; readonly branchId: string; readonly totalPesewas: bigint }, actorId: string): Promise<void> {
    await tx.query(`INSERT INTO fin.depreciation_run (id, period_id, branch_id, status, total_pesewas, created_by, updated_by) VALUES ($1, $2, $3, 'DRAFT', $4, $5, $5)`, [
      row.id,
      row.periodId,
      row.branchId,
      row.totalPesewas.toString(),
      actorId,
    ]);
  }

  async insertLines(tx: Transaction, runId: string, lines: readonly { readonly fixedAssetId: string; readonly fromMonth: number; readonly months: number; readonly amountPesewas: bigint }[], actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO fin.depreciation_line (depreciation_run_id, fixed_asset_id, from_month, months, amount_pesewas, actor_id)
       SELECT $1, l.asset, l.from_month, l.months, l.amount, $6
         FROM unnest($2::uuid[], $3::integer[], $4::integer[], $5::bigint[]) AS l (asset, from_month, months, amount)`,
      [runId, lines.map((l) => l.fixedAssetId), lines.map((l) => l.fromMonth), lines.map((l) => l.months), lines.map((l) => l.amountPesewas.toString()), actorId],
    );
  }

  async linesOf(tx: Transaction, runIds: readonly string[]): Promise<Map<string, DepreciationLineRow[]>> {
    const byRun = new Map<string, DepreciationLineRow[]>(runIds.map((id) => [id, []]));
    if (runIds.length === 0) return byRun;
    const { rows } = await tx.query<Omit<DepreciationLineRow, 'amountPesewas'> & { amountPesewas: string }>(
      `SELECT l.depreciation_run_id AS "runId", l.fixed_asset_id AS "fixedAssetId", a.asset_no AS "assetNo", a.name, a.category, a.branch_id AS "branchId",
              l.from_month AS "fromMonth", l.months, l.amount_pesewas::text AS "amountPesewas"
         FROM fin.depreciation_line l JOIN fin.fixed_asset a ON a.id = l.fixed_asset_id
        WHERE l.depreciation_run_id = ANY($1::uuid[]) ORDER BY a.asset_no, a.id`,
      [runIds],
    );
    for (const r of rows) byRun.get(r.runId)!.push({ ...r, amountPesewas: BigInt(r.amountPesewas) });
    return byRun;
  }

  async markRunPosted(tx: Transaction, id: string, journalEntryId: string, actorId: string, at: Date): Promise<void> {
    await tx.query(`UPDATE fin.depreciation_run SET version = version + 1, status = 'POSTED', journal_entry_id = $2, posted_at = $3, posted_by = $4, updated_by = $4 WHERE id = $1`, [
      id,
      journalEntryId,
      at,
      actorId,
    ]);
  }

  async entriesOf(tx: Transaction, sourceDocumentId: string): Promise<{ readonly entryId: string; readonly branchId: string }[]> {
    const { rows } = await tx.query<{ entryId: string; branchId: string }>(
      `SELECT e.id AS "entryId", e.branch_id AS "branchId" FROM fin.journal_entry e WHERE e.source_document_id = $1 ORDER BY e.branch_id, e.id`,
      [sourceDocumentId],
    );
    return rows;
  }

  async costByCategory(tx: Transaction): Promise<{ readonly key: string; readonly pesewas: bigint }[]> {
    const { rows } = await tx.query<{ key: string; pesewas: string }>(
      "SELECT category AS key, sum(cost_pesewas)::text AS pesewas FROM fin.fixed_asset WHERE status <> 'DISPOSED' GROUP BY category ORDER BY category",
    );
    return rows.map((r) => ({ key: r.key, pesewas: BigInt(r.pesewas) }));
  }

  /** As a credit: the ledger's balance of 1590 is debits less credits. */
  async accumulatedByCategory(tx: Transaction): Promise<{ readonly key: string; readonly pesewas: bigint }[]> {
    const { rows } = await tx.query<{ key: string; pesewas: string }>(
      "SELECT category AS key, (-sum(accumulated_pesewas))::text AS pesewas FROM fin.fixed_asset WHERE status <> 'DISPOSED' GROUP BY category HAVING sum(accumulated_pesewas) > 0 ORDER BY category",
    );
    return rows.map((r) => ({ key: r.key, pesewas: BigInt(r.pesewas) }));
  }
}
