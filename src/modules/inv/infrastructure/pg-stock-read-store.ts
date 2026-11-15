import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ReadScope } from '../application/goods-receipt-store';
import type { HoldKind, OnHandFilters, OnHandRow, PoolRow, StockReadStore, StockUnitRow } from '../application/stock-read-store';

/** The holds covering a unit now: unreleased, started, not yet ended. */
const ACTIVE_HOLD = 'h.released_at IS NULL AND h.starts_at <= now() AND (h.ends_at IS NULL OR h.ends_at > now())';

/** Stock reads over INV's own tables and published views (migration 0044). */
export class PgStockReadStore implements StockReadStore {
  async onHand(tx: Transaction, filters: OnHandFilters, scopes: readonly ReadScope[], includeZero: boolean): Promise<OnHandRow[]> {
    const { rows } = await tx.query<{
      product_id: string;
      stock_unit_id: string | null;
      location_id: string;
      branch_id: string;
      on_hand_qty: string;
      on_hand_weight_kg: string;
      reserved_qty: string;
      available_qty: string;
      pack_count: number;
      identifier: string | null;
      tracking: 'SERIAL' | 'LOT' | null;
      unit_branch_id: string | null;
      produced_on: string | null;
      expires_on: string | null;
      holds: HoldKind[] | null;
    }>(
      `SELECT v.product_id, v.stock_unit_id, v.location_id, v.branch_id, v.on_hand_qty, v.on_hand_weight_kg, v.reserved_qty, v.available_qty,
              b.pack_count, u.identifier, u.tracking, u.branch_id AS unit_branch_id,
              to_char(u.produced_on, 'YYYY-MM-DD') AS produced_on, to_char(u.expires_on, 'YYYY-MM-DD') AS expires_on,
              (SELECT array_agg(DISTINCT h.kind ORDER BY h.kind) FROM inv.stock_hold h WHERE h.stock_unit_id = v.stock_unit_id AND ${ACTIVE_HOLD}) AS holds
         FROM inv.pub_stock_on_hand v
         JOIN inv.stock_balance b ON b.product_id = v.product_id AND b.location_id = v.location_id AND b.stock_unit_id IS NOT DISTINCT FROM v.stock_unit_id
         LEFT JOIN inv.stock_unit u ON u.id = v.stock_unit_id
        WHERE EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) s(branch_id, location_id)
                       WHERE s.branch_id = v.branch_id AND (s.location_id IS NULL OR s.location_id = v.location_id))
          AND ($3::uuid IS NULL OR v.branch_id = $3)
          AND ($4::uuid IS NULL OR v.location_id = $4)
          AND ($5::uuid IS NULL OR v.product_id = $5)
          AND ($6::uuid IS NULL OR v.stock_unit_id = $6)
          AND ($7::boolean OR v.on_hand_qty <> 0)
        ORDER BY v.location_id, v.product_id, v.stock_unit_id NULLS FIRST`,
      [
        scopes.map((s) => s.branchId),
        scopes.map((s) => s.locationId),
        filters.branchId ?? null,
        filters.locationId ?? null,
        filters.productId ?? null,
        filters.stockUnitId ?? null,
        includeZero,
      ],
    );
    return rows.map((r) => ({
      productId: r.product_id,
      stockUnitId: r.stock_unit_id,
      locationId: r.location_id,
      branchId: r.branch_id,
      onHandQty: r.on_hand_qty,
      onHandWeightKg: r.on_hand_weight_kg,
      reservedQty: r.reserved_qty,
      availableQty: r.available_qty,
      packCount: r.pack_count,
      unit:
        r.stock_unit_id === null
          ? null
          : { identifier: r.identifier!, tracking: r.tracking!, branchId: r.unit_branch_id!, producedOn: r.produced_on, expiresOn: r.expires_on },
      holds: r.holds ?? [],
    }));
  }

  async poolBalances(tx: Transaction, productIds: readonly string[]) {
    if (productIds.length === 0) return [];
    const { rows } = await tx.query<{ product_id: string; stock_unit_id: string | null; location_id: string; branch_id: string; on_hand_qty: string }>(
      'SELECT product_id, stock_unit_id, location_id, branch_id, on_hand_qty FROM inv.pub_stock_on_hand WHERE product_id = ANY($1::uuid[]) ORDER BY location_id, product_id, stock_unit_id NULLS FIRST',
      [productIds],
    );
    return rows.map((r) => ({ productId: r.product_id, stockUnitId: r.stock_unit_id, locationId: r.location_id, branchId: r.branch_id, onHandQty: r.on_hand_qty }));
  }

  async pools(tx: Transaction, productIds: readonly string[]): Promise<PoolRow[]> {
    if (productIds.length === 0) return [];
    const { rows } = await tx.query<{ product_id: string; stock_unit_id: string | null; branch_id: string; qty: string; value_pesewas: string }>(
      'SELECT product_id, stock_unit_id, branch_id, qty, value_pesewas FROM inv.pub_stock_value WHERE product_id = ANY($1::uuid[])',
      [productIds],
    );
    return rows.map((r) => ({ productId: r.product_id, stockUnitId: r.stock_unit_id, branchId: r.branch_id, qty: r.qty, valuePesewas: BigInt(r.value_pesewas) }));
  }

  async stockUnit(tx: Transaction, id: string): Promise<StockUnitRow | null> {
    const { rows } = await tx.query<{
      id: string;
      product_id: string;
      tracking: 'SERIAL' | 'LOT';
      branch_id: string;
      identifier: string;
      current_location_id: string | null;
      status: StockUnitRow['status'];
      produced_on: string | null;
      expires_on: string | null;
      storage_temp_class: StockUnitRow['storageTempClass'];
      supplier_id: string | null;
      grade_id: string | null;
      last_weight_kg: string | null;
      last_weighed_at: Date | null;
      source_document_id: string;
      created_at: Date;
      on_hand_qty: string;
      value_pesewas: string;
    }>(
      `SELECT u.id, u.product_id, u.tracking, u.branch_id, u.identifier, u.current_location_id, u.status,
              to_char(u.produced_on, 'YYYY-MM-DD') AS produced_on, to_char(u.expires_on, 'YYYY-MM-DD') AS expires_on, u.storage_temp_class,
              u.supplier_id, u.grade_id, u.last_weight_kg, u.last_weighed_at, u.source_document_id, u.created_at,
              (SELECT COALESCE(sum(v.on_hand_qty), 0)::numeric(14,3) FROM inv.pub_stock_on_hand v WHERE v.stock_unit_id = u.id) AS on_hand_qty,
              (SELECT COALESCE(sum(c.value_pesewas), 0) FROM inv.pub_stock_value c WHERE c.stock_unit_id = u.id) AS value_pesewas
         FROM inv.stock_unit u WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) return null;
    const holds = await tx.query<{ id: string; kind: HoldKind; starts_at: Date; ends_at: Date | null }>(
      `SELECT h.id, h.kind, h.starts_at, h.ends_at FROM inv.stock_hold h WHERE h.stock_unit_id = $1 AND ${ACTIVE_HOLD} ORDER BY h.starts_at, h.id`,
      [id],
    );
    const reservation = await tx.query<{ id: string; holder_document_id: string; expires_at: Date | null }>(
      "SELECT id, holder_document_id, expires_at FROM inv.stock_reservation WHERE stock_unit_id = $1 AND status = 'ACTIVE' ORDER BY created_at, id LIMIT 1",
      [id],
    );
    const active = reservation.rows[0];
    return {
      id: r.id,
      productId: r.product_id,
      tracking: r.tracking,
      branchId: r.branch_id,
      identifier: r.identifier,
      currentLocationId: r.current_location_id,
      status: r.status,
      producedOn: r.produced_on,
      expiresOn: r.expires_on,
      storageTempClass: r.storage_temp_class,
      supplierId: r.supplier_id,
      gradeId: r.grade_id,
      lastWeightKg: r.last_weight_kg,
      lastWeighedAt: r.last_weighed_at,
      sourceDocumentId: r.source_document_id,
      createdAt: r.created_at,
      onHandQty: r.on_hand_qty,
      valuePesewas: BigInt(r.value_pesewas),
      activeHolds: holds.rows.map((h) => ({ id: h.id, kind: h.kind, startsAt: h.starts_at, endsAt: h.ends_at })),
      activeReservation: active === undefined ? null : { id: active.id, holderDocumentId: active.holder_document_id, expiresAt: active.expires_at },
    };
  }
}
