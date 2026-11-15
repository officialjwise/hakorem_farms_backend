import type { Transaction } from '../../../platform/database/unit-of-work';
import type { NewStockUnit } from '../application/goods-receipt-store';
import type { StockUnitFactsRecord, StockUnitStore } from '../application/stock-unit-store';

interface FactsRow {
  id: string;
  product_id: string;
  tracking: 'SERIAL' | 'LOT';
  branch_id: string;
  identifier: string;
  status: StockUnitFactsRecord['status'];
  current_location_id: string | null;
  last_weight_kg: string | null;
  pool_value: string | null;
  holds: Array<{ id: string; kind: string; endsAt: string | null }>;
}

/** Stock units for the `StockUnits` interface: point reads by primary key, and the insert of a new lot. */
export class PgStockUnitStore implements StockUnitStore {
  async facts(tx: Transaction, ids: readonly string[], at: Date): Promise<StockUnitFactsRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<FactsRow>(
      `SELECT u.id, u.product_id, u.tracking, u.branch_id, u.identifier, u.status, u.current_location_id, u.last_weight_kg::text AS last_weight_kg,
              (SELECT c.value_pesewas::text FROM inv.cost_pool c WHERE c.product_id = u.product_id AND c.stock_unit_id = u.id AND c.branch_id = u.branch_id) AS pool_value,
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
      poolValuePesewas: BigInt(r.pool_value ?? '0'),
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
                                   source_document_id, last_weight_kg, last_weighed_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
      [unit.id, unit.productId, unit.tracking, unit.branchId, unit.identifier, unit.producedOn, unit.expiresOn, unit.storageTempClass, unit.supplierId,
        unit.sourceDocumentId, unit.lastWeightKg, unit.lastWeighedAt, actorId],
    );
  }
}
