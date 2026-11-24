import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  CostingStore,
  DailyHead,
  LineRecord,
  LossFactRecord,
  MarginGroupBy,
  MarginRange,
  MarginSums,
  ProcessingFlow,
  RunRecord,
  SummaryRecord,
} from '../application/costing-store';
import type { ElementAmounts } from '../domain/cost-object';

const RUN = `id, branch_id, period_start::text AS period_start, period_end::text AS period_end, cost_element, basis, scope_location_id,
  total_pesewas::text AS total, status, version, created_at, created_by, posted_at, posted_by`;
type RawRun = {
  id: string;
  branch_id: string;
  period_start: string;
  period_end: string;
  cost_element: RunRecord['costElement'];
  basis: RunRecord['basis'];
  scope_location_id: string | null;
  total: string;
  status: RunRecord['status'];
  version: number;
  created_at: Date;
  created_by: string;
  posted_at: Date | null;
  posted_by: string | null;
};
const runOf = (r: RawRun): RunRecord => ({
  id: r.id,
  branchId: r.branch_id,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  costElement: r.cost_element,
  basis: r.basis,
  scopeLocationId: r.scope_location_id,
  totalPesewas: BigInt(r.total),
  status: r.status,
  version: r.version,
  createdAt: r.created_at,
  createdBy: r.created_by,
  postedAt: r.posted_at,
  postedBy: r.posted_by,
});

type RawSums = { k: string; rs: string; rc: string; cs: string; cc: string; v: string; qty: string; w: string | null };
const sumsOf = (r: RawSums): MarginSums => ({
  key: r.k === '' ? null : r.k,
  revenueSales: BigInt(r.rs),
  revenueCredits: BigInt(r.rc),
  costSales: BigInt(r.cs),
  costCredits: BigInt(r.cc),
  variance: BigInt(r.v),
  qty: r.qty,
  weightKg: r.w,
});

/** The group key of each margin dimension, over cst.margin_fact's own columns only. */
const GROUP_KEY: Readonly<Record<MarginGroupBy, string>> = {
  PRODUCT: 'product_id::text',
  PRODUCT_LINE: 'product_line',
  CHANNEL: 'channel',
  CUSTOMER: 'customer_ref::text',
  SALESPERSON: 'salesperson_ref::text',
  BRANCH: 'branch_id::text',
};

const SUMS = `COALESCE(sum(revenue_pesewas) FILTER (WHERE NOT is_credit), 0)::text AS rs,
  COALESCE(sum(revenue_pesewas) FILTER (WHERE is_credit), 0)::text AS rc,
  COALESCE(sum(cost_pesewas) FILTER (WHERE NOT is_credit), 0)::text AS cs,
  COALESCE(sum(cost_pesewas) FILTER (WHERE is_credit), 0)::text AS cc,
  COALESCE(sum(price_variance_pesewas), 0)::text AS v,
  GREATEST(COALESCE(sum(CASE WHEN fact_kind = 'REVENUE' THEN CASE WHEN is_credit THEN -qty ELSE qty END END), 0), 0)::numeric(14,3)::text AS qty,
  GREATEST(sum(CASE WHEN fact_kind = 'REVENUE' THEN CASE WHEN is_credit THEN -weight_kg ELSE weight_kg END END), 0)::numeric(12,3)::text AS w`;
const IN_RANGE = 'document_date BETWEEN $1::date AND $2::date AND ($3::uuid[] IS NULL OR branch_id = ANY ($3::uuid[]))';

type RawSummary = {
  object_type: SummaryRecord['objectType'];
  object_id: string;
  branch_id: string;
  purchase: string;
  feed: string;
  veterinary: string;
  labour: string;
  overhead: string;
  processing: string;
  refreshed_at: Date;
};

const count = (rows: readonly { n: number }[]): number => rows[0]?.n ?? 0;

/** CST's store: its own schema, and the published views of INV and MDM it may read (ADR-0011, ADR-0023). */
export class PgCostingStore implements CostingStore {
  async insertRun(tx: Transaction, run: Omit<RunRecord, 'status' | 'version' | 'postedAt' | 'postedBy'>, lines: readonly Omit<LineRecord, 'movementRef'>[]): Promise<void> {
    await tx.query(
      `INSERT INTO cst.overhead_allocation_run (id, branch_id, period_start, period_end, cost_element, basis, scope_location_id, total_pesewas, status,
                                                created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', $9, $10, $9, $10)`,
      [run.id, run.branchId, run.periodStart, run.periodEnd, run.costElement, run.basis, run.scopeLocationId, run.totalPesewas.toString(), run.createdAt, run.createdBy],
    );
    await tx.query(
      `INSERT INTO cst.overhead_allocation_line (run_id, stock_unit_id, weight, amount_pesewas, treatment)
       SELECT $1, l.unit, l.weight, l.amount, l.treatment
         FROM unnest($2::uuid[], $3::bigint[], $4::bigint[], $5::text[]) AS l (unit, weight, amount, treatment)`,
      [run.id, lines.map((l) => l.stockUnitId), lines.map((l) => l.weight.toString()), lines.map((l) => l.amountPesewas.toString()), lines.map((l) => l.treatment)],
    );
  }

  async run(tx: Transaction, id: string, forUpdate: boolean): Promise<RunRecord | null> {
    const { rows } = await tx.query<RawRun>(`SELECT ${RUN} FROM cst.overhead_allocation_run WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : runOf(rows[0]);
  }

  async lines(tx: Transaction, runIds: readonly string[]): Promise<LineRecord[]> {
    const { rows } = await tx.query<{ run_id: string; stock_unit_id: string; weight: string; amount: string; treatment: LineRecord['treatment']; movement_ref: string | null }>(
      `SELECT run_id, stock_unit_id, weight::text AS weight, amount_pesewas::text AS amount, treatment, movement_ref
         FROM cst.overhead_allocation_line WHERE run_id = ANY ($1::uuid[]) ORDER BY run_id, stock_unit_id`,
      [runIds],
    );
    return rows.map((r) => ({ runId: r.run_id, stockUnitId: r.stock_unit_id, weight: BigInt(r.weight), amountPesewas: BigInt(r.amount), treatment: r.treatment, movementRef: r.movement_ref }));
  }

  async listRuns(tx: Transaction, branchIds: readonly string[], after: { readonly createdAt: string; readonly id: string } | null, limit: number): Promise<RunRecord[]> {
    const { rows } = await tx.query<RawRun>(
      `SELECT ${RUN} FROM cst.overhead_allocation_run
        WHERE branch_id = ANY ($1::uuid[]) AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [branchIds, after?.createdAt ?? null, after?.id ?? null, limit],
    );
    return rows.map(runOf);
  }

  async postedRunExists(tx: Transaction, run: RunRecord): Promise<boolean> {
    const { rows } = await tx.query(
      `SELECT 1 FROM cst.overhead_allocation_run
        WHERE status = 'POSTED' AND branch_id = $1 AND cost_element = $2 AND scope_location_id IS NOT DISTINCT FROM $3::uuid AND period_start = $4 AND period_end = $5`,
      [run.branchId, run.costElement, run.scopeLocationId, run.periodStart, run.periodEnd],
    );
    return rows.length > 0;
  }

  async markPosted(tx: Transaction, id: string, postedBy: string, at: Date, movements: ReadonlyMap<string, string>): Promise<void> {
    if (movements.size > 0) {
      await tx.query(
        `UPDATE cst.overhead_allocation_line l SET movement_ref = m.movement
           FROM unnest($2::uuid[], $3::uuid[]) AS m (unit, movement)
          WHERE l.run_id = $1 AND l.stock_unit_id = m.unit`,
        [id, [...movements.keys()], [...movements.values()]],
      );
    }
    await tx.query(`UPDATE cst.overhead_allocation_run SET status = 'POSTED', posted_at = $2, posted_by = $3, version = version + 1, updated_at = $2, updated_by = $3 WHERE id = $1`, [id, at, postedBy]);
  }

  async dailyHeads(tx: Transaction, scope: { readonly branchId: string; readonly locationId: string | null; readonly from: string; readonly to: string }): Promise<DailyHead[]> {
    const { rows } = await tx.query<{ stock_unit_id: string; day: string; on_hand: string }>(
      `WITH days AS (
         SELECT d::date AS day, ((d::date + 1)::timestamp AT TIME ZONE 'Africa/Accra') AS day_end
           FROM generate_series($3::date, $4::date, interval '1 day') d
       ), flows AS (
         SELECT m.stock_unit_id, x.location_id, x.qty, m.occurred_at
           FROM inv.pub_movement m
           JOIN mdm.pub_product p ON p.product_id = m.product_id AND p.species_id IS NOT NULL
           CROSS JOIN LATERAL (VALUES (m.to_location_id, m.qty_base), (m.from_location_id, -m.qty_base)) AS x (location_id, qty)
          WHERE m.stock_unit_id IS NOT NULL AND m.qty_base > 0 AND m.branch_id = $1
            AND m.occurred_at < ((($4::date) + 1)::timestamp AT TIME ZONE 'Africa/Accra')
       ), scoped AS (
         SELECT f.* FROM flows f CROSS JOIN LATERAL mdm.location_stock_facts(f.location_id) l
          WHERE l.branch_id = $1 AND NOT l.is_virtual AND l.kind NOT IN ('IN_TRANSIT', 'SITE') AND ($2::uuid IS NULL OR f.location_id = $2::uuid)
       )
       SELECT s.stock_unit_id, d.day::text AS day, sum(s.qty)::numeric(14,3)::text AS on_hand
         FROM scoped s CROSS JOIN days d
        WHERE s.occurred_at < d.day_end
        GROUP BY s.stock_unit_id, d.day
       HAVING sum(s.qty) > 0
        ORDER BY s.stock_unit_id, d.day`,
      [scope.branchId, scope.locationId, scope.from, scope.to],
    );
    return rows.map((r) => ({ stockUnitId: r.stock_unit_id, day: r.day, onHandQty: r.on_hand }));
  }

  async placesNow(tx: Transaction, stockUnitIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const { rows } = await tx.query<{ stock_unit_id: string; location_id: string }>(
      `SELECT DISTINCT ON (s.stock_unit_id) s.stock_unit_id, s.location_id FROM inv.pub_stock_on_hand s
        WHERE s.stock_unit_id = ANY ($1::uuid[]) AND s.on_hand_qty > 0
        ORDER BY s.stock_unit_id, s.on_hand_qty DESC, s.location_id`,
      [stockUnitIds],
    );
    return new Map(rows.map((r) => [r.stock_unit_id, r.location_id] as const));
  }

  async unitsOnHandAt(tx: Transaction, locationId: string): Promise<string[]> {
    const { rows } = await tx.query<{ stock_unit_id: string }>(
      'SELECT DISTINCT s.stock_unit_id FROM inv.pub_stock_on_hand s WHERE s.location_id = $1 AND s.on_hand_qty > 0 AND s.stock_unit_id IS NOT NULL ORDER BY 1',
      [locationId],
    );
    return rows.map((r) => r.stock_unit_id);
  }

  async refreshUnits(tx: Transaction, stockUnitIds: readonly string[] | null): Promise<number> {
    if (stockUnitIds !== null && stockUnitIds.length === 0) return 0;
    return count((await tx.query<{ n: number }>('SELECT cst.refresh_unit_costs($1::uuid[]) AS n', [stockUnitIds])).rows);
  }

  async refreshMarginRevenue(tx: Transaction, documentIds: readonly string[] | null): Promise<number> {
    return count((await tx.query<{ n: number }>('SELECT cst.refresh_margin_revenue($1::uuid[]) AS n', [documentIds])).rows);
  }

  async refreshMarginCost(tx: Transaction, movementIds: readonly string[] | null): Promise<number> {
    return count((await tx.query<{ n: number }>('SELECT cst.refresh_margin_cost($1::uuid[]) AS n', [movementIds])).rows);
  }

  async refreshLosses(tx: Transaction, movementIds: readonly string[] | null): Promise<number> {
    return count((await tx.query<{ n: number }>('SELECT cst.refresh_loss_facts($1::uuid[]) AS n', [movementIds])).rows);
  }

  async processingFlows(tx: Transaction, orderIds: readonly string[] | null): Promise<ProcessingFlow[]> {
    const { rows } = await tx.query<{ order_id: string; branch_id: string; stock_unit_id: string | null; kind: ProcessingFlow['kind']; value: string }>(
      `SELECT COALESCE(o.source_document_id, m.source_document_id) AS order_id, m.branch_id, m.stock_unit_id,
              CASE WHEN COALESCE(o.movement_type, m.movement_type) = 'PROCESS_CONSUME' THEN 'CONSUME' ELSE 'OUTPUT' END AS kind,
              (CASE WHEN m.reverses_movement_id IS NULL THEN 1 ELSE -1 END * m.value_pesewas)::text AS value
         FROM inv.pub_movement m
         LEFT JOIN inv.pub_movement o ON o.id = m.reverses_movement_id
        WHERE COALESCE(o.movement_type, m.movement_type) IN ('PROCESS_CONSUME', 'PROCESS_OUTPUT')
          AND ($1::uuid[] IS NULL OR COALESCE(o.source_document_id, m.source_document_id) = ANY ($1::uuid[]))
        ORDER BY 1, m.occurred_at, m.id`,
      [orderIds],
    );
    return rows.map((r) => ({ orderId: r.order_id, branchId: r.branch_id, stockUnitId: r.stock_unit_id, kind: r.kind, signedValue: BigInt(r.value) }));
  }

  async putProcessingOrders(tx: Transaction, orderIds: readonly string[] | null, rows: readonly { readonly objectId: string; readonly branchId: string; readonly elements: ElementAmounts }[]): Promise<number> {
    const payload = rows.map((r) => ({
      objectId: r.objectId,
      branchId: r.branchId,
      purchase: r.elements.PURCHASE.toString(),
      feed: r.elements.FEED.toString(),
      veterinary: r.elements.VETERINARY.toString(),
      labour: r.elements.LABOUR.toString(),
      overhead: r.elements.OVERHEAD.toString(),
      processing: r.elements.PROCESSING.toString(),
    }));
    return count((await tx.query<{ n: number }>('SELECT cst.put_processing_order_costs($1::uuid[], $2::jsonb) AS n', [orderIds, JSON.stringify(payload)])).rows);
  }

  async summaries(tx: Transaction, objectType: 'STOCK_UNIT' | 'PROCESSING_ORDER', ids: readonly string[]): Promise<SummaryRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<RawSummary>(
      `SELECT object_type, object_id, branch_id, purchase_pesewas::text AS purchase, feed_pesewas::text AS feed, veterinary_pesewas::text AS veterinary,
              labour_pesewas::text AS labour, overhead_pesewas::text AS overhead, processing_pesewas::text AS processing, refreshed_at
         FROM cst.cost_object_summary WHERE object_type = $1 AND object_id = ANY ($2::uuid[]) ORDER BY object_id`,
      [objectType, ids],
    );
    return rows.map((r) => ({
      objectType: r.object_type,
      objectId: r.object_id,
      branchId: r.branch_id,
      elements: { PURCHASE: BigInt(r.purchase), FEED: BigInt(r.feed), VETERINARY: BigInt(r.veterinary), LABOUR: BigInt(r.labour), OVERHEAD: BigInt(r.overhead), PROCESSING: BigInt(r.processing) },
      refreshedAt: r.refreshed_at,
    }));
  }

  async marginGroups(tx: Transaction, range: MarginRange, groupBy: MarginGroupBy, after: string | null, limit: number): Promise<MarginSums[]> {
    const { rows } = await tx.query<RawSums>(
      `SELECT * FROM (SELECT COALESCE(${GROUP_KEY[groupBy]}, '') AS k, ${SUMS} FROM cst.margin_fact WHERE ${IN_RANGE} GROUP BY 1) g
        WHERE $4::text IS NULL OR g.k > $4::text ORDER BY g.k LIMIT $5`,
      [range.from, range.to, range.branchIds, after, limit],
    );
    return rows.map(sumsOf);
  }

  async marginTotals(tx: Transaction, range: MarginRange): Promise<MarginSums> {
    const { rows } = await tx.query<RawSums>(`SELECT '' AS k, ${SUMS} FROM cst.margin_fact WHERE ${IN_RANGE}`, [range.from, range.to, range.branchIds]);
    return sumsOf(rows[0]!);
  }

  async lineSums(tx: Transaction, range: MarginRange): Promise<MarginSums[]> {
    const { rows } = await tx.query<RawSums>(`SELECT product_line AS k, ${SUMS} FROM cst.margin_fact WHERE ${IN_RANGE} GROUP BY product_line ORDER BY product_line`, [
      range.from,
      range.to,
      range.branchIds,
    ]);
    return rows.map(sumsOf);
  }

  async lossFacts(tx: Transaction, range: MarginRange): Promise<LossFactRecord[]> {
    const { rows } = await tx.query<{
      movement_ref: string;
      location_id: string;
      product_id: string;
      handler_ref: string | null;
      loss_group: LossFactRecord['lossGroup'];
      is_reversal: boolean;
      qty: string;
      value: string;
    }>(
      `SELECT movement_ref, location_id, product_id, handler_ref, loss_group, is_reversal, qty::text AS qty, value_pesewas::text AS value
         FROM cst.loss_fact
        WHERE occurred_on BETWEEN $1::date AND $2::date AND ($3::uuid[] IS NULL OR branch_id = ANY ($3::uuid[]))
        ORDER BY CASE loss_group WHEN 'MORTALITY' THEN 1 WHEN 'SHRINKAGE' THEN 2 ELSE 3 END, occurred_on, movement_ref`,
      [range.from, range.to, range.branchIds],
    );
    return rows.map((r) => ({
      movementRef: r.movement_ref,
      locationId: r.location_id,
      productId: r.product_id,
      handlerRef: r.handler_ref,
      lossGroup: r.loss_group,
      isReversal: r.is_reversal,
      qty: r.qty,
      valuePesewas: BigInt(r.value),
    }));
  }
}
