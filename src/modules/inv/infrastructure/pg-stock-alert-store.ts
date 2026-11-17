import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ExpiryAlertKind, LevelAlertKind } from '../domain/stock-alert';
import type {
  ExpiringLotRecord,
  LocationStockRecord,
  NewStockAlert,
  NewTemperatureReading,
  ReorderLevelRecord,
  ReorderRuleRecord,
  StockAlertFilters,
  StockAlertRecord,
  StockAlertStore,
  TemperatureReadingFilters,
  TemperatureReadingRecord,
} from '../application/stock-alert-store';
import type { ReadScope } from '../application/stock-documents-store';

const RULE = `SELECT r.id, r.product_id AS "productId", r.branch_id AS "branchId", r.location_id AS "locationId", r.min_qty::text AS "minQty",
                     r.reorder_point_qty::text AS "reorderPointQty", r.max_qty::text AS "maxQty", r.uom, r.min_qty_uom::text AS "minQtyUom",
                     r.reorder_point_qty_uom::text AS "reorderPointQtyUom", r.max_qty_uom::text AS "maxQtyUom", r.expiry_alert_days AS "expiryAlertDays", r.version
                FROM inv.reorder_rule r`;

const ALERT = `SELECT a.id, a.kind, a.branch_id AS "branchId", a.product_id AS "productId", a.location_id AS "locationId", a.stock_unit_id AS "stockUnitId",
                      a.reorder_rule_id AS "reorderRuleId", a.qty::text AS qty, a.threshold_qty::text AS "thresholdQty", a.suggested_qty::text AS "suggestedQty",
                      to_char(a.expires_on, 'YYYY-MM-DD') AS "expiresOn", a.raised_at AS "raisedAt"
                 FROM inv.stock_alert a`;

const READING = `SELECT t.id, t.location_id AS "locationId", t.branch_id AS "branchId", t.reading_c::text AS "readingC", t.range_min_c::text AS "rangeMinC",
                        t.range_max_c::text AS "rangeMaxC", t.measured_at AS "measuredAt", t.source, t.is_excursion AS "isExcursion",
                        t.excursion_document_id AS "excursionDocumentId", t.exception_id AS "exceptionId", t.recorded_at AS "recordedAt", t.actor_id AS "actorId"
                   FROM inv.temperature_reading t`;

/** A scope filter on a branch column and an optional location column, as every INV list narrows (A-135). */
const IN_SCOPE = (branch: string, location: string) => `EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) s(branch_id, location_id)
                       WHERE s.branch_id = ${branch} AND (s.location_id IS NULL OR s.location_id = ${location}))`;

/** Reorder rules, stock alerts and the cold chain log of migration 0064. */
export class PgStockAlertStore implements StockAlertStore {
  async rule(tx: Transaction, id: string): Promise<ReorderRuleRecord | null> {
    const { rows } = await tx.query<ReorderRuleRecord>(`${RULE} WHERE r.id = $1 AND r.deleted_at IS NULL`, [id]);
    return rows[0] ?? null;
  }

  async lockRule(tx: Transaction, id: string): Promise<ReorderRuleRecord | null> {
    const { rows } = await tx.query<ReorderRuleRecord>(`${RULE} WHERE r.id = $1 AND r.deleted_at IS NULL FOR UPDATE`, [id]);
    return rows[0] ?? null;
  }

  async ruleFor(tx: Transaction, productId: string, branchId: string, locationId: string | null): Promise<ReorderRuleRecord | null> {
    const { rows } = await tx.query<ReorderRuleRecord>(
      `${RULE} WHERE r.product_id = $1 AND r.branch_id = $2 AND r.location_id IS NOT DISTINCT FROM $3 AND r.deleted_at IS NULL`,
      [productId, branchId, locationId],
    );
    return rows[0] ?? null;
  }

  async rules(tx: Transaction, filters: { readonly productId?: string | undefined; readonly branchId?: string | undefined }, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<ReorderRuleRecord[]> {
    const { rows } = await tx.query<ReorderRuleRecord>(
      `${RULE}
        WHERE r.deleted_at IS NULL AND ${IN_SCOPE('r.branch_id', 'r.location_id')}
          AND ($3::uuid IS NULL OR r.product_id = $3) AND ($4::uuid IS NULL OR r.branch_id = $4) AND ($5::uuid IS NULL OR r.id > $5)
        ORDER BY r.id LIMIT $6`,
      [scopes.map((s) => s.branchId), scopes.map((s) => s.locationId), filters.productId ?? null, filters.branchId ?? null, afterId, limit],
    );
    return rows;
  }

  async insertRule(tx: Transaction, r: Omit<ReorderRuleRecord, 'version'>, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO inv.reorder_rule (id, product_id, branch_id, location_id, min_qty, reorder_point_qty, max_qty, expiry_alert_days, uom, min_qty_uom,
                                     reorder_point_qty_uom, max_qty_uom, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
      [r.id, r.productId, r.branchId, r.locationId, r.minQty, r.reorderPointQty, r.maxQty, r.expiryAlertDays, r.uom, r.minQtyUom, r.reorderPointQtyUom, r.maxQtyUom, actorId],
    );
  }

  async updateRule(
    tx: Transaction,
    id: string,
    version: number,
    l: Pick<ReorderRuleRecord, 'minQty' | 'reorderPointQty' | 'maxQty' | 'minQtyUom' | 'reorderPointQtyUom' | 'maxQtyUom' | 'expiryAlertDays'>,
    actorId: string,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE inv.reorder_rule SET min_qty = $3, reorder_point_qty = $4, max_qty = $5, expiry_alert_days = $6, min_qty_uom = $8, reorder_point_qty_uom = $9,
                                   max_qty_uom = $10, version = version + 1, updated_by = $7
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
      [id, version, l.minQty, l.reorderPointQty, l.maxQty, l.expiryAlertDays, actorId, l.minQtyUom, l.reorderPointQtyUom, l.maxQtyUom],
    );
    return result.rowCount === 1;
  }

  async leadTimes(tx: Transaction, productIds: readonly string[]): Promise<ReorderRuleRecord[]> {
    if (productIds.length === 0) return [];
    const { rows } = await tx.query<ReorderRuleRecord>(`${RULE} WHERE r.product_id = ANY($1::uuid[]) AND r.deleted_at IS NULL`, [productIds]);
    return rows;
  }

  async levels(tx: Transaction, productIds: readonly string[] | null): Promise<ReorderLevelRecord[]> {
    const { rows } = await tx.query<ReorderLevelRecord>(
      `SELECT v.reorder_rule_id AS "reorderRuleId", v.product_id AS "productId", v.branch_id AS "branchId", v.location_id AS "locationId",
              v.min_qty::text AS "minQty", v.reorder_point_qty::text AS "reorderPointQty", v.max_qty::text AS "maxQty", v.available_qty::text AS "availableQty"
         FROM inv.pub_reorder_level v
        WHERE $1::uuid[] IS NULL OR v.product_id = ANY($1::uuid[])
        ORDER BY v.reorder_rule_id`,
      [productIds],
    );
    return rows;
  }

  async openLevelAlerts(tx: Transaction, ruleIds: readonly string[]): Promise<ReadonlyArray<{ readonly id: string; readonly reorderRuleId: string; readonly kind: LevelAlertKind }>> {
    if (ruleIds.length === 0) return [];
    const { rows } = await tx.query<{ id: string; reorderRuleId: string; kind: LevelAlertKind }>(
      `SELECT id, reorder_rule_id AS "reorderRuleId", kind FROM inv.stock_alert WHERE reorder_rule_id = ANY($1::uuid[]) AND status = 'OPEN'`,
      [ruleIds],
    );
    return rows;
  }

  async openExpiryAlerts(tx: Transaction): Promise<ReadonlyArray<{ readonly id: string; readonly stockUnitId: string; readonly locationId: string; readonly kind: ExpiryAlertKind }>> {
    const { rows } = await tx.query<{ id: string; stockUnitId: string; locationId: string; kind: ExpiryAlertKind }>(
      `SELECT id, stock_unit_id AS "stockUnitId", location_id AS "locationId", kind FROM inv.stock_alert
        WHERE status = 'OPEN' AND kind IN ('EXPIRING', 'EXPIRED') ORDER BY id`,
    );
    return rows;
  }

  async raiseAlert(tx: Transaction, a: NewStockAlert, at: Date, actorId: string): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO inv.stock_alert (id, kind, branch_id, product_id, location_id, stock_unit_id, reorder_rule_id, qty, threshold_qty, suggested_qty, expires_on,
                                    status, raised_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'OPEN', $12, $13, $13)
       ON CONFLICT DO NOTHING`,
      [a.id, a.kind, a.branchId, a.productId, a.locationId, a.stockUnitId, a.reorderRuleId, a.qty, a.thresholdQty, a.suggestedQty, a.expiresOn, at, actorId],
    );
    return result.rowCount === 1;
  }

  async clearAlert(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    await tx.query(`UPDATE inv.stock_alert SET status = 'CLEARED', cleared_at = $2, version = version + 1, updated_by = $3 WHERE id = $1 AND status = 'OPEN'`, [id, at, actorId]);
  }

  async alerts(tx: Transaction, filters: StockAlertFilters, scopes: readonly ReadScope[], after: { readonly raisedAt: string; readonly id: string } | null, limit: number): Promise<StockAlertRecord[]> {
    const { rows } = await tx.query<StockAlertRecord>(
      `${ALERT}
        WHERE a.status = 'OPEN' AND ${IN_SCOPE('a.branch_id', 'a.location_id')}
          AND ($3::uuid IS NULL OR a.branch_id = $3) AND ($4::text IS NULL OR a.kind = $4)
          AND ($5::timestamptz IS NULL OR (a.raised_at, a.id) < ($5::timestamptz, $6::uuid))
        ORDER BY a.raised_at DESC, a.id DESC LIMIT $7`,
      [scopes.map((s) => s.branchId), scopes.map((s) => s.locationId), filters.branchId ?? null, filters.kind ?? null, after?.raisedAt ?? null, after?.id ?? null, limit],
    );
    return rows;
  }

  async datedLots(tx: Transaction): Promise<ExpiringLotRecord[]> {
    const { rows } = await tx.query<ExpiringLotRecord>(
      `SELECT u.id AS "stockUnitId", u.product_id AS "productId", v.branch_id AS "branchId", v.location_id AS "locationId", u.identifier,
              to_char(u.expires_on, 'YYYY-MM-DD') AS "expiresOn", v.on_hand_qty::text AS "onHandQty"
         FROM inv.stock_unit u
         JOIN inv.pub_stock_on_hand v ON v.stock_unit_id = u.id
        WHERE u.tracking = 'LOT' AND u.expires_on IS NOT NULL AND v.on_hand_qty > 0
        ORDER BY u.id, v.location_id`,
    );
    return rows;
  }

  async unitOnHand(tx: Transaction, pairs: ReadonlyArray<{ readonly stockUnitId: string; readonly locationId: string }>): Promise<ReadonlyMap<string, string>> {
    if (pairs.length === 0) return new Map();
    const { rows } = await tx.query<{ stockUnitId: string; locationId: string; qty: string }>(
      `SELECT b.stock_unit_id AS "stockUnitId", b.location_id AS "locationId", b.on_hand_qty::text AS qty
         FROM inv.stock_balance b JOIN unnest($1::uuid[], $2::uuid[]) p(unit_id, location_id) ON p.unit_id = b.stock_unit_id AND p.location_id = b.location_id`,
      [pairs.map((p) => p.stockUnitId), pairs.map((p) => p.locationId)],
    );
    return new Map(rows.map((r) => [`${r.stockUnitId}:${r.locationId}`, r.qty] as const));
  }

  async reading(tx: Transaction, id: string): Promise<TemperatureReadingRecord | null> {
    const { rows } = await tx.query<TemperatureReadingRecord>(`${READING} WHERE t.id = $1`, [id]);
    return rows[0] ?? null;
  }

  async readings(tx: Transaction, filters: TemperatureReadingFilters, scopes: readonly ReadScope[], after: { readonly measuredAt: string; readonly id: string } | null, limit: number): Promise<TemperatureReadingRecord[]> {
    const { rows } = await tx.query<TemperatureReadingRecord>(
      `${READING}
        WHERE ${IN_SCOPE('t.branch_id', 't.location_id')}
          AND ($3::uuid IS NULL OR t.location_id = $3) AND ($4::timestamptz IS NULL OR t.measured_at >= $4) AND ($5::timestamptz IS NULL OR t.measured_at < $5)
          AND (NOT $6::boolean OR t.is_excursion)
          AND ($7::timestamptz IS NULL OR (t.measured_at, t.id) > ($7::timestamptz, $8::uuid))
        ORDER BY t.measured_at, t.id LIMIT $9`,
      [
        scopes.map((s) => s.branchId),
        scopes.map((s) => s.locationId),
        filters.locationId ?? null,
        filters.from ?? null,
        filters.to ?? null,
        filters.excursionsOnly === true,
        after?.measuredAt ?? null,
        after?.id ?? null,
        limit,
      ],
    );
    return rows;
  }

  async insertReading(tx: Transaction, r: NewTemperatureReading, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO inv.temperature_reading (id, location_id, branch_id, reading_c, range_min_c, range_max_c, measured_at, source, is_excursion,
                                            excursion_document_id, exception_id, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [r.id, r.locationId, r.branchId, r.readingC, r.rangeMinC, r.rangeMaxC, r.measuredAt, r.source, r.isExcursion, r.excursionDocumentId, r.exceptionId, actorId],
    );
  }

  async stockAt(tx: Transaction, locationId: string): Promise<LocationStockRecord[]> {
    const { rows } = await tx.query<LocationStockRecord>(
      `SELECT b.product_id AS "productId", b.stock_unit_id AS "stockUnitId", u.status AS "unitStatus", b.on_hand_qty::text AS "onHandQty"
         FROM inv.stock_balance b LEFT JOIN inv.stock_unit u ON u.id = b.stock_unit_id
        WHERE b.location_id = $1 AND b.on_hand_qty > 0
        ORDER BY b.product_id, b.stock_unit_id NULLS FIRST`,
      [locationId],
    );
    return rows;
  }
}
