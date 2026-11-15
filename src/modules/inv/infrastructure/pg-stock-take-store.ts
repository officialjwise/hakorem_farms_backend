import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ScopeClaim, StockTakeScope, StockTakeStatus } from '../domain/stock-take';
import type { ReadScope } from '../application/stock-documents-store';
import type { BalanceInScope, StockTakeFilters, StockTakeLineRecord, StockTakeRecord, StockTakeStore, VarianceTotalsRecord } from '../application/stock-take-store';

interface TakeRow {
  id: string;
  stock_take_no: string | null;
  status: StockTakeStatus;
  location_id: string;
  scope: StockTakeScope;
  product_ids: string[];
  snapshot_at: Date | null;
  counted_by: string | null;
  gain_value_pesewas: string | null;
  loss_value_pesewas: string | null;
  variance_value_pesewas: string | null;
  approval_request_id: string | null;
  cancel_reason: string | null;
  line_count: number;
  counted_line_count: number;
  branch_id: string;
  version: number;
  created_at: Date;
  created_by: string;
  posted_at: Date | null;
  posted_by: string | null;
}

const TAKE = `SELECT t.id, t.stock_take_no, t.status, t.location_id, t.scope, t.snapshot_at, t.counted_by, t.gain_value_pesewas, t.loss_value_pesewas,
                     t.variance_value_pesewas, t.approval_request_id, t.cancel_reason, t.branch_id, t.version, t.created_at, t.created_by, t.posted_at, t.posted_by,
                     COALESCE((SELECT array_agg(p.product_id ORDER BY p.product_id) FROM inv.stock_take_product p WHERE p.stock_take_id = t.id), '{}') AS product_ids,
                     (SELECT count(*)::int FROM inv.stock_take_line l WHERE l.stock_take_id = t.id) AS line_count,
                     (SELECT count(*)::int FROM inv.stock_take_line l WHERE l.stock_take_id = t.id AND l.counted_qty IS NOT NULL) AS counted_line_count
                FROM inv.stock_take t`;

const LINE = `SELECT id, product_id AS "productId", stock_unit_id AS "stockUnitId", expected_qty AS "expectedQty", counted_qty AS "countedQty",
                     recount_qty AS "recountQty", counted_weight_kg AS "countedWeightKg", counted_weight_source AS "countedWeightSource",
                     variance_qty AS "varianceQty", variance_value_pesewas AS "varianceValuePesewas", movement_id AS "movementId"
                FROM inv.stock_take_line`;

const bigintOrNull = (value: string | null): bigint | null => (value === null ? null : BigInt(value));

function toTake(r: TakeRow): StockTakeRecord {
  return {
    id: r.id,
    stockTakeNo: r.stock_take_no,
    status: r.status,
    locationId: r.location_id,
    scope: r.scope,
    productIds: r.product_ids,
    snapshotAt: r.snapshot_at,
    countedBy: r.counted_by,
    gainValuePesewas: bigintOrNull(r.gain_value_pesewas),
    lossValuePesewas: bigintOrNull(r.loss_value_pesewas),
    varianceValuePesewas: bigintOrNull(r.variance_value_pesewas),
    approvalRequestId: r.approval_request_id,
    cancelReason: r.cancel_reason,
    lineCount: r.line_count,
    countedLineCount: r.counted_line_count,
    branchId: r.branch_id,
    version: r.version,
    createdAt: r.created_at,
    createdBy: r.created_by,
    postedAt: r.posted_at,
    postedBy: r.posted_by,
  };
}

function toLine(r: Omit<StockTakeLineRecord, 'varianceValuePesewas'> & { varianceValuePesewas: string | null }): StockTakeLineRecord {
  return { ...r, varianceValuePesewas: bigintOrNull(r.varianceValuePesewas) };
}

/** The stock take tables of migration 0054. */
export class PgStockTakeStore implements StockTakeStore {
  async insertTake(tx: Transaction, t: { id: string; locationId: string; scope: StockTakeScope; branchId: string }, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO inv.stock_take (id, location_id, scope, status, branch_id, created_by, updated_by) VALUES ($1, $2, $3, 'DRAFT', $4, $5, $5)`,
      [t.id, t.locationId, t.scope, t.branchId, actorId],
    );
  }

  async insertTakeProducts(tx: Transaction, takeId: string, productIds: readonly string[]): Promise<void> {
    if (productIds.length === 0) return;
    await tx.query('INSERT INTO inv.stock_take_product (stock_take_id, product_id) SELECT $1, unnest($2::uuid[])', [takeId, [...productIds]]);
  }

  async lockTake(tx: Transaction, id: string): Promise<{ readonly status: StockTakeStatus } | null> {
    const { rows } = await tx.query<{ status: StockTakeStatus }>('SELECT status FROM inv.stock_take WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] ?? null;
  }

  async take(tx: Transaction, id: string): Promise<StockTakeRecord | null> {
    const { rows } = await tx.query<TakeRow>(`${TAKE} WHERE t.id = $1`, [id]);
    return rows[0] === undefined ? null : toTake(rows[0]);
  }

  async takes(tx: Transaction, filters: StockTakeFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<StockTakeRecord[]> {
    const { rows } = await tx.query<TakeRow>(
      `${TAKE}
        WHERE EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) s(branch_id, location_id)
                       WHERE s.branch_id = t.branch_id AND (s.location_id IS NULL OR s.location_id = t.location_id))
          AND ($3::text IS NULL OR t.status = $3)
          AND ($4::uuid IS NULL OR t.location_id = $4)
          AND ($5::uuid IS NULL OR t.id > $5)
        ORDER BY t.id
        LIMIT $6`,
      [scopes.map((s) => s.branchId), scopes.map((s) => s.locationId), filters.status ?? null, filters.locationId ?? null, afterId, limit],
    );
    return rows.map(toTake);
  }

  async claimsAt(tx: Transaction, locationId: string, statuses: readonly StockTakeStatus[], exceptId: string | null): Promise<Array<ScopeClaim & { readonly id: string }>> {
    const { rows } = await tx.query<{ id: string; location_id: string; scope: StockTakeScope; product_ids: string[] }>(
      `SELECT t.id, t.location_id, t.scope,
              COALESCE((SELECT array_agg(p.product_id) FROM inv.stock_take_product p WHERE p.stock_take_id = t.id), '{}') AS product_ids
         FROM inv.stock_take t
        WHERE t.location_id = $1 AND t.status = ANY($2::text[]) AND ($3::uuid IS NULL OR t.id <> $3)`,
      [locationId, [...statuses], exceptId],
    );
    return rows.map((r) => ({ id: r.id, locationId: r.location_id, scope: r.scope, productIds: r.product_ids }));
  }

  async balancesInScope(tx: Transaction, locationId: string, productIds: readonly string[] | null): Promise<BalanceInScope[]> {
    const { rows } = await tx.query<BalanceInScope>(
      `SELECT b.product_id AS "productId", b.stock_unit_id AS "stockUnitId", b.on_hand_qty AS "onHandQty"
         FROM inv.stock_balance b
         LEFT JOIN inv.stock_unit u ON u.id = b.stock_unit_id
        WHERE b.location_id = $1 AND b.on_hand_qty <> 0 AND u.tracking IS DISTINCT FROM 'SERIAL'
          AND ($2::uuid[] IS NULL OR b.product_id = ANY($2::uuid[]))
        ORDER BY b.product_id, b.stock_unit_id NULLS FIRST`,
      [locationId, productIds === null ? null : [...productIds]],
    );
    return rows;
  }

  async insertLine(tx: Transaction, takeId: string, l: { id: string; productId: string; stockUnitId: string | null; expectedQty: string }): Promise<void> {
    await tx.query('INSERT INTO inv.stock_take_line (id, stock_take_id, product_id, stock_unit_id, expected_qty) VALUES ($1, $2, $3, $4, $5)', [
      l.id,
      takeId,
      l.productId,
      l.stockUnitId,
      l.expectedQty,
    ]);
  }

  async markStarted(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    await tx.query("UPDATE inv.stock_take SET status = 'COUNTING', snapshot_at = $2, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1", [id, at, actorId]);
  }

  async lines(tx: Transaction, takeId: string): Promise<StockTakeLineRecord[]> {
    const { rows } = await tx.query<Parameters<typeof toLine>[0]>(`${LINE} WHERE stock_take_id = $1 ORDER BY id`, [takeId]);
    return rows.map(toLine);
  }

  async linesPage(tx: Transaction, takeId: string, afterId: string | null, limit: number): Promise<StockTakeLineRecord[]> {
    const { rows } = await tx.query<Parameters<typeof toLine>[0]>(`${LINE} WHERE stock_take_id = $1 AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT $3`, [
      takeId,
      afterId,
      limit,
    ]);
    return rows.map(toLine);
  }

  async setCount(tx: Transaction, lineId: string, c: { qty: string; weightKg: string | null; weightSource: StockTakeLineRecord['countedWeightSource'] }): Promise<void> {
    await tx.query('UPDATE inv.stock_take_line SET counted_qty = $2, counted_weight_kg = $3, counted_weight_source = $4 WHERE id = $1', [lineId, c.qty, c.weightKg, c.weightSource]);
  }

  async setRecount(tx: Transaction, lineId: string, recount: string, v: { qty: string; valuePesewas: bigint }): Promise<void> {
    await tx.query('UPDATE inv.stock_take_line SET recount_qty = $2, variance_qty = $3, variance_value_pesewas = $4 WHERE id = $1', [
      lineId,
      recount,
      v.qty,
      v.valuePesewas.toString(),
    ]);
  }

  async setVariance(tx: Transaction, lineId: string, v: { qty: string; valuePesewas: bigint }): Promise<void> {
    await tx.query('UPDATE inv.stock_take_line SET variance_qty = $2, variance_value_pesewas = $3 WHERE id = $1', [lineId, v.qty, v.valuePesewas.toString()]);
  }

  async setLineMovement(tx: Transaction, lineId: string, movementId: string): Promise<void> {
    await tx.query('UPDATE inv.stock_take_line SET movement_id = $2 WHERE id = $1', [lineId, movementId]);
  }

  async touchCounting(tx: Transaction, id: string, actorId: string): Promise<void> {
    await tx.query('UPDATE inv.stock_take SET counted_by = COALESCE(counted_by, $2), version = version + 1, updated_by = $2, updated_at = now() WHERE id = $1', [id, actorId]);
  }

  async markReview(tx: Transaction, id: string, totals: VarianceTotalsRecord, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE inv.stock_take SET status = 'REVIEW', gain_value_pesewas = $2, loss_value_pesewas = $3, variance_value_pesewas = $4,
              version = version + 1, updated_by = $5, updated_at = now() WHERE id = $1`,
      [id, totals.gainPesewas.toString(), totals.lossPesewas.toString(), totals.totalPesewas.toString(), actorId],
    );
  }

  async setTotals(tx: Transaction, id: string, totals: VarianceTotalsRecord, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE inv.stock_take SET gain_value_pesewas = $2, loss_value_pesewas = $3, variance_value_pesewas = $4, version = version + 1, updated_by = $5, updated_at = now()
        WHERE id = $1`,
      [id, totals.gainPesewas.toString(), totals.lossPesewas.toString(), totals.totalPesewas.toString(), actorId],
    );
  }

  async markJudged(
    tx: Transaction,
    id: string,
    o: { status: 'PENDING_APPROVAL' | 'POSTED'; totals: VarianceTotalsRecord; thresholdPesewas: bigint; approvalRequestId: string | null; at: Date },
    actorId: string,
  ): Promise<void> {
    const posted = o.status === 'POSTED';
    await tx.query(
      `UPDATE inv.stock_take SET status = $2, gain_value_pesewas = $3, loss_value_pesewas = $4, variance_value_pesewas = $5, approval_threshold_pesewas = $6,
              approval_request_id = $7, posted_at = $8, posted_by = $9, version = version + 1, updated_by = $10, updated_at = now() WHERE id = $1`,
      [
        id,
        o.status,
        o.totals.gainPesewas.toString(),
        o.totals.lossPesewas.toString(),
        o.totals.totalPesewas.toString(),
        o.thresholdPesewas.toString(),
        o.approvalRequestId,
        posted ? o.at : null,
        posted ? actorId : null,
        actorId,
      ],
    );
  }

  async markPosted(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    await tx.query("UPDATE inv.stock_take SET status = 'POSTED', posted_at = $2, posted_by = $3, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1", [
      id,
      at,
      actorId,
    ]);
  }

  async markCancelled(tx: Transaction, id: string, reason: string, actorId: string): Promise<void> {
    await tx.query("UPDATE inv.stock_take SET status = 'CANCELLED', cancel_reason = $2, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1", [
      id,
      reason,
      actorId,
    ]);
  }
}
