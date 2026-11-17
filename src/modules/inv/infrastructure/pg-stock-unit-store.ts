import type { Transaction } from '../../../platform/database/unit-of-work';
import type { NewStockUnit } from '../application/goods-receipt-store';
import type { StockUnitFactsRecord, StockUnitStore, UnitOnHandRecord } from '../application/stock-unit-store';

interface FactsRow {
  id: string;
  product_id: string;
  tracking: 'SERIAL' | 'LOT';
  branch_id: string;
  identifier: string;
  status: StockUnitFactsRecord['status'];
  current_location_id: string | null;
  last_weight_kg: string | null;
  last_weighed_at: Date | null;
  grade_id: string | null;
  source_document_id: string;
  pool_value: string | null;
  pool_qty: string | null;
  reserved: boolean;
  holds: Array<{ id: string; kind: string; endsAt: string | null }>;
}

/** Stock units for the `StockUnits` interface: point reads by primary key, and the insert of a new lot. */
export class PgStockUnitStore implements StockUnitStore {
  async facts(tx: Transaction, ids: readonly string[], at: Date): Promise<StockUnitFactsRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<FactsRow>(
      `SELECT u.id, u.product_id, u.tracking, u.branch_id, u.identifier, u.status, u.current_location_id, u.last_weight_kg::text AS last_weight_kg,
              u.last_weighed_at, u.grade_id, u.source_document_id,
              (SELECT c.value_pesewas::text FROM inv.cost_pool c WHERE c.product_id = u.product_id AND c.stock_unit_id = u.id AND c.branch_id = u.branch_id) AS pool_value,
              (SELECT c.qty::text FROM inv.cost_pool c WHERE c.product_id = u.product_id AND c.stock_unit_id = u.id AND c.branch_id = u.branch_id) AS pool_qty,
              EXISTS (SELECT 1 FROM inv.stock_reservation r WHERE r.stock_unit_id = u.id AND r.status = 'ACTIVE') AS reserved,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id', h.id, 'kind', h.kind, 'endsAt', h.ends_at) ORDER BY h.starts_at)
                          FROM inv.stock_hold h
                         WHERE h.stock_unit_id = u.id AND h.released_at IS NULL AND h.starts_at <= $2 AND (h.ends_at IS NULL OR h.ends_at > $2)), '[]'::jsonb) AS holds
         FROM inv.stock_unit u
        WHERE u.id = ANY($1::uuid[]) AND u.deleted_at IS NULL`,
      [ids, at],
    );
    return rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      tracking: r.tracking,
      branchId: r.branch_id,
      identifier: r.identifier,
      status: r.status,
      currentLocationId: r.current_location_id,
      lastWeightKg: r.last_weight_kg,
      lastWeighedAt: r.last_weighed_at,
      gradeId: r.grade_id,
      sourceDocumentId: r.source_document_id,
      poolValuePesewas: BigInt(r.pool_value ?? '0'),
      poolQty: r.pool_qty ?? '0.000',
      reserved: r.reserved,
      holds: r.holds.map((h) => ({ id: h.id, kind: h.kind, endsAt: h.endsAt === null ? null : new Date(h.endsAt) })),
    }));
  }

  async activeIdentifiers(tx: Transaction, productId: string, identifiers: readonly string[]): Promise<string[]> {
    if (identifiers.length === 0) return [];
    const { rows } = await tx.query<{ identifier: string }>(
      "SELECT identifier FROM inv.stock_unit WHERE product_id = $1 AND identifier = ANY($2::text[]) AND status = 'ACTIVE' AND deleted_at IS NULL",
      [productId, identifiers],
    );
    return rows.map((row) => row.identifier);
  }

  async insert(tx: Transaction, unit: NewStockUnit, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO inv.stock_unit (id, product_id, tracking, branch_id, identifier, status, produced_on, expires_on, storage_temp_class, supplier_id,
                                   source_document_id, last_weight_kg, last_weighed_at, received_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
      [unit.id, unit.productId, unit.tracking, unit.branchId, unit.identifier, unit.producedOn, unit.expiresOn, unit.storageTempClass, unit.supplierId,
        unit.sourceDocumentId, unit.lastWeightKg, unit.lastWeighedAt, unit.receivedAt, actorId],
    );
  }

  async onHandOf(tx: Transaction, unitIds: readonly string[]): Promise<UnitOnHandRecord[]> {
    if (unitIds.length === 0) return [];
    const { rows } = await tx.query<{ id: string; product_id: string; tracking: 'SERIAL' | 'LOT'; identifier: string; branch_id: string; location_id: string; on_hand_qty: string }>(
      `SELECT u.id, u.product_id, u.tracking, u.identifier, u.branch_id, b.location_id, b.on_hand_qty::text AS on_hand_qty
         FROM inv.stock_balance b JOIN inv.stock_unit u ON u.id = b.stock_unit_id
        WHERE b.stock_unit_id = ANY($1::uuid[]) AND b.on_hand_qty > 0
          AND NOT (SELECT f.is_virtual FROM mdm.location_stock_facts(b.location_id) f)
        ORDER BY u.identifier, u.id, b.location_id`,
      [unitIds],
    );
    return rows.map((r) => ({ id: r.id, productId: r.product_id, tracking: r.tracking, identifier: r.identifier, branchId: r.branch_id, locationId: r.location_id, onHandQty: r.on_hand_qty }));
  }

  async onHandAt(tx: Transaction, locationIds: readonly string[]): Promise<UnitOnHandRecord[]> {
    if (locationIds.length === 0) return [];
    const { rows } = await tx.query<{ id: string; product_id: string; tracking: 'SERIAL' | 'LOT'; identifier: string; branch_id: string; location_id: string; on_hand_qty: string }>(
      `SELECT u.id, u.product_id, u.tracking, u.identifier, u.branch_id, b.location_id, b.on_hand_qty::text AS on_hand_qty
         FROM inv.stock_balance b JOIN inv.stock_unit u ON u.id = b.stock_unit_id
        WHERE b.location_id = ANY($1::uuid[]) AND b.stock_unit_id IS NOT NULL AND b.on_hand_qty > 0
        ORDER BY u.identifier, u.id`,
      [locationIds],
    );
    return rows.map((r) => ({ id: r.id, productId: r.product_id, tracking: r.tracking, identifier: r.identifier, branchId: r.branch_id, locationId: r.location_id, onHandQty: r.on_hand_qty }));
  }

  async onHandAsOf(tx: Transaction, unitIds: readonly string[], at: Date): Promise<UnitOnHandRecord[]> {
    if (unitIds.length === 0) return [];
    const { rows } = await tx.query<{ id: string; product_id: string; tracking: 'SERIAL' | 'LOT'; identifier: string; branch_id: string; location_id: string; on_hand_qty: string }>(
      `WITH legs AS (
         SELECT m.stock_unit_id, m.to_location_id AS location_id, m.qty_base AS qty FROM inv.stock_movement m
          WHERE m.stock_unit_id = ANY($1::uuid[]) AND m.occurred_at <= $2
         UNION ALL
         SELECT m.stock_unit_id, m.from_location_id, -m.qty_base FROM inv.stock_movement m
          WHERE m.stock_unit_id = ANY($1::uuid[]) AND m.occurred_at <= $2
       )
       SELECT u.id, u.product_id, u.tracking, u.identifier, u.branch_id, l.location_id, sum(l.qty)::text AS on_hand_qty
         FROM legs l JOIN inv.stock_unit u ON u.id = l.stock_unit_id
        WHERE NOT (SELECT f.is_virtual FROM mdm.location_stock_facts(l.location_id) f)
        GROUP BY u.id, u.product_id, u.tracking, u.identifier, u.branch_id, l.location_id
       HAVING sum(l.qty) > 0
        ORDER BY u.identifier, u.id, l.location_id`,
      [unitIds, at],
    );
    return rows.map((r) => ({ id: r.id, productId: r.product_id, tracking: r.tracking, identifier: r.identifier, branchId: r.branch_id, locationId: r.location_id, onHandQty: r.on_hand_qty }));
  }

  async setGrade(tx: Transaction, id: string, gradeId: string | null, actorId: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      "UPDATE inv.stock_unit SET grade_id = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL",
      [id, gradeId, actorId],
    );
    return rowCount === 1;
  }

  async recordWeight(tx: Transaction, id: string, weightKg: string, at: Date, actorId: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE inv.stock_unit SET last_weight_kg = $2, last_weighed_at = $3, version = version + 1, updated_at = now(), updated_by = $4
        WHERE id = $1 AND (last_weighed_at IS NULL OR last_weighed_at <= $3)`,
      [id, weightKg, at, actorId],
    );
    return rowCount === 1;
  }
}
