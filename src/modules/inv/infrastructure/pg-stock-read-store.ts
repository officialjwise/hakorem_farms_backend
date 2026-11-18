import type { Transaction } from '../../../platform/database/unit-of-work';
import { keysetClause, positionOf, sortKeySelect, type SortOrder } from '../../../platform/http/keyset-sort';
import type { ReadScope } from '../application/goods-receipt-store';
import type { CostPoolRecord, HoldKind, OnHandFilters, OnHandNarrowing, OnHandRow, PoolRow, StockReadStore, StockUnitFilters, StockUnitRow } from '../application/stock-read-store';

/**
 * The holds covering a unit at the instant bound to `at` (the application clock's now, ADR-0067): unreleased, started,
 * not yet ended. `inv.pub_stock_on_hand` reads the same window at `platform.app_now()`, the same instant.
 */
const activeHold = (at: string) => `h.released_at IS NULL AND h.starts_at <= ${at}::timestamptz AND (h.ends_at IS NULL OR h.ends_at > ${at}::timestamptz)`;

interface OnHandSqlRow {
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
  received_at: Date | null;
  holds: HoldKind[] | null;
}

/** One balance at a physical location with its unit's dates and holds at `at`; `b` is its `inv.stock_balance` row. */
const onHandSelect = (at: string) => `SELECT v.product_id, v.stock_unit_id, v.location_id, v.branch_id, v.on_hand_qty, v.on_hand_weight_kg, v.reserved_qty, v.available_qty,
              b.pack_count, u.identifier, u.tracking, u.branch_id AS unit_branch_id,
              to_char(u.produced_on, 'YYYY-MM-DD') AS produced_on, to_char(u.expires_on, 'YYYY-MM-DD') AS expires_on, u.received_at,
              (SELECT array_agg(DISTINCT h.kind ORDER BY h.kind) FROM inv.stock_hold h WHERE h.stock_unit_id = v.stock_unit_id AND ${activeHold(at)}) AS holds
         FROM inv.pub_stock_on_hand v
         JOIN inv.stock_balance b ON b.product_id = v.product_id AND b.location_id = v.location_id AND b.stock_unit_id IS NOT DISTINCT FROM v.stock_unit_id
         LEFT JOIN inv.stock_unit u ON u.id = v.stock_unit_id`;

/** The reader's scopes ($1, $2) and the list's filters ($3 to $7). */
const ON_HAND_WHERE = `EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) s(branch_id, location_id)
                       WHERE s.branch_id = v.branch_id AND (s.location_id IS NULL OR s.location_id = v.location_id))
          AND ($3::uuid IS NULL OR v.branch_id = $3)
          AND ($4::uuid IS NULL OR v.location_id = $4)
          AND ($5::uuid IS NULL OR v.product_id = $5)
          AND ($6::uuid IS NULL OR v.stock_unit_id = $6)
          AND ($7::boolean OR v.on_hand_qty <> 0)`;

function onHandValues(filters: OnHandFilters, scopes: readonly ReadScope[], includeZero: boolean): unknown[] {
  return [
    scopes.map((s) => s.branchId),
    scopes.map((s) => s.locationId),
    filters.branchId ?? null,
    filters.locationId ?? null,
    filters.productId ?? null,
    filters.stockUnitId ?? null,
    includeZero,
  ];
}

function toOnHandRow(r: OnHandSqlRow): OnHandRow {
  return {
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
        : { identifier: r.identifier!, tracking: r.tracking!, branchId: r.unit_branch_id!, producedOn: r.produced_on, expiresOn: r.expires_on, receivedAt: r.received_at },
    holds: r.holds ?? [],
  };
}

/** The reader's scopes ($1, $2) and the stock unit list's filters ($3 to $9), holds at `at`, over `inv.stock_unit u`. */
const stockUnitWhere = (at: string) => `u.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) s(branch_id, location_id)
                       WHERE s.branch_id = u.branch_id
                         AND (s.location_id IS NULL OR s.location_id = u.current_location_id
                              OR EXISTS (SELECT 1 FROM inv.stock_balance b WHERE b.stock_unit_id = u.id AND b.location_id = s.location_id AND b.on_hand_qty <> 0)))
          AND ($3::text IS NULL OR strpos(lower(u.identifier), lower($3)) > 0)
          AND ($4::uuid IS NULL OR u.product_id = $4)
          AND ($5::uuid IS NULL OR u.current_location_id = $5
               OR EXISTS (SELECT 1 FROM inv.stock_balance b WHERE b.stock_unit_id = u.id AND b.location_id = $5 AND b.on_hand_qty <> 0))
          AND ($6::text IS NULL OR u.status = $6)
          AND ($7::text IS NULL OR u.tracking = $7)
          AND ($8::date IS NULL OR u.expires_on <= $8)
          AND ($9::boolean IS NULL OR $9 = EXISTS (SELECT 1 FROM inv.stock_hold h WHERE h.stock_unit_id = u.id AND ${activeHold(at)}))`;

function stockUnitValues(filters: StockUnitFilters, scopes: readonly ReadScope[]): unknown[] {
  return [
    scopes.map((s) => s.branchId),
    scopes.map((s) => s.locationId),
    filters.q ?? null,
    filters.productId ?? null,
    filters.locationId ?? null,
    filters.status ?? null,
    filters.tracking ?? null,
    filters.expiresBy ?? null,
    filters.onHold ?? null,
  ];
}

/** Stock reads over INV's own tables and published views (migration 0044). */
export class PgStockReadStore implements StockReadStore {
  async costPools(tx: Transaction, branchId: string, productIds: readonly string[]): Promise<CostPoolRecord[]> {
    if (productIds.length === 0) return [];
    const { rows } = await tx.query<{ productId: string; stockUnitId: string | null; qty: string; value: string }>(
      `SELECT c.product_id AS "productId", c.stock_unit_id AS "stockUnitId", c.qty::text AS qty, c.value_pesewas::text AS value
         FROM inv.cost_pool c LEFT JOIN inv.stock_unit u ON u.id = c.stock_unit_id
        WHERE c.branch_id = $1 AND c.product_id = ANY($2::uuid[]) AND c.qty > 0 AND (c.stock_unit_id IS NULL OR u.status = 'ACTIVE')
        ORDER BY c.product_id, c.stock_unit_id NULLS FIRST`,
      [branchId, productIds],
    );
    return rows.map((r) => ({ productId: r.productId, stockUnitId: r.stockUnitId, qty: r.qty, valuePesewas: BigInt(r.value) }));
  }

  async onHand(tx: Transaction, filters: OnHandFilters, scopes: readonly ReadScope[], includeZero: boolean, at: Date): Promise<OnHandRow[]> {
    const { rows } = await tx.query<OnHandSqlRow>(
      `${onHandSelect('$8')}
        WHERE ${ON_HAND_WHERE}
        ORDER BY v.location_id, v.product_id, v.stock_unit_id NULLS FIRST`,
      [...onHandValues(filters, scopes, includeZero), at],
    );
    return rows.map(toOnHandRow);
  }

  async onHandSorted(
    tx: Transaction,
    filters: OnHandFilters,
    scopes: readonly ReadScope[],
    includeZero: boolean,
    narrow: OnHandNarrowing,
    order: SortOrder,
    position: readonly string[] | null,
    limit: number,
    at: Date,
  ): Promise<Array<OnHandRow & { readonly position: string[] }>> {
    const clause = keysetClause(order, position, 12);
    const { rows } = await tx.query<OnHandSqlRow & Record<string, unknown>>(
      `${onHandSelect('$11').replace('SELECT ', `SELECT ${sortKeySelect(order)}, `)}
        WHERE ${ON_HAND_WHERE}
          AND ($8::uuid[] IS NULL OR v.product_id = ANY($8::uuid[]))
          AND ($9::date IS NULL OR u.expires_on <= $9::date)
          AND ${clause.after}
        ORDER BY ${clause.orderBy}
        LIMIT $10`,
      [...onHandValues(filters, scopes, includeZero), narrow.productIds, narrow.expiresBy, limit, at, ...clause.values],
    );
    return rows.map((r) => ({ ...toOnHandRow(r), position: positionOf(order, r) }));
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

  async stockUnitIds(tx: Transaction, filters: StockUnitFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number, at: Date): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT u.id FROM inv.stock_unit u
        WHERE ${stockUnitWhere('$12')}
          AND ($10::uuid IS NULL OR u.id > $10)
        ORDER BY u.id
        LIMIT $11`,
      [...stockUnitValues(filters, scopes), afterId, limit, at],
    );
    return rows.map((r) => r.id);
  }

  async stockUnitIdsSorted(
    tx: Transaction,
    filters: StockUnitFilters,
    scopes: readonly ReadScope[],
    order: SortOrder,
    position: readonly string[] | null,
    limit: number,
    at: Date,
  ): Promise<Array<{ readonly id: string; readonly position: string[] }>> {
    const clause = keysetClause(order, position, 12);
    const { rows } = await tx.query<{ id: string } & Record<string, unknown>>(
      `SELECT u.id, ${sortKeySelect(order)} FROM inv.stock_unit u
        WHERE ${stockUnitWhere('$11')}
          AND ${clause.after}
        ORDER BY ${clause.orderBy}
        LIMIT $10`,
      [...stockUnitValues(filters, scopes), limit, at, ...clause.values],
    );
    return rows.map((r) => ({ id: r.id, position: positionOf(order, r) }));
  }

  async stockUnit(tx: Transaction, id: string, at: Date): Promise<StockUnitRow | null> {
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
      received_at: Date | null;
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
              to_char(u.produced_on, 'YYYY-MM-DD') AS produced_on, to_char(u.expires_on, 'YYYY-MM-DD') AS expires_on, u.received_at, u.storage_temp_class,
              u.supplier_id, u.grade_id, u.last_weight_kg, u.last_weighed_at, u.source_document_id, u.created_at,
              (SELECT COALESCE(sum(v.on_hand_qty), 0)::numeric(14,3) FROM inv.pub_stock_on_hand v WHERE v.stock_unit_id = u.id) AS on_hand_qty,
              (SELECT COALESCE(sum(c.value_pesewas), 0) FROM inv.pub_stock_value c WHERE c.stock_unit_id = u.id) AS value_pesewas
         FROM inv.stock_unit u WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) return null;
    const holds = await tx.query<{ id: string; kind: HoldKind; starts_at: Date; ends_at: Date | null }>(
      `SELECT h.id, h.kind, h.starts_at, h.ends_at FROM inv.stock_hold h WHERE h.stock_unit_id = $1 AND ${activeHold('$2')} ORDER BY h.starts_at, h.id`,
      [id, at],
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
      receivedAt: r.received_at,
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
