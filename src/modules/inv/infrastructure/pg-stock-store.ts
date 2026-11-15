import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DriftRow, LinkType, MovementRow, PostedRow, StockStore, UnitLink, UnitMovement } from '../application/stock-store';

const LINEAGE_COLUMNS = `u.id AS unit_id, u.branch_id, u.identifier, u.product_id, u.tracking, u.status, u.supplier_id, u.source_document_id`;

/** The inventory ledger in PostgreSQL. The triggers of migration 0044 decide; this only inserts and reads. */
export class PgStockStore implements StockStore {
  async insertMovement(tx: Transaction, m: MovementRow): Promise<PostedRow> {
    const { rows } = await tx.query<{ value_pesewas: string; posting_event: string | null }>(
      `WITH posted AS (
         INSERT INTO inv.stock_movement (id, movement_type, product_id, stock_unit_id, branch_id, from_location_id, to_location_id, qty_base, weight_kg,
                                         weight_source, pack_count, value_pesewas, cost_element, reason_code, source_document_id, source_line_ref,
                                         reservation_id, reverses_movement_id, occurred_at, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         RETURNING value_pesewas, movement_type)
       SELECT p.value_pesewas, t.posting_event FROM posted p JOIN inv.movement_type t ON t.code = p.movement_type`,
      [
        m.id, m.movementType, m.productId, m.stockUnitId, m.branchId, m.fromLocationId, m.toLocationId, m.qtyBase, m.weightKg, m.weightSource,
        m.packCount, m.valuePesewas.toString(), m.costElement, m.reasonCode, m.sourceDocumentId, m.sourceLineRef, m.reservationId,
        m.reversesMovementId, m.occurredAt, m.actorId,
      ],
    );
    return { valuePesewas: BigInt(rows[0]!.value_pesewas), postingEvent: rows[0]!.posting_event };
  }

  async insertLineage(tx: Transaction, childUnitId: string, parentUnitId: string, linkType: LinkType, sourceDocumentId: string, actorId: string): Promise<void> {
    await tx.query(
      'INSERT INTO inv.stock_unit_lineage (child_unit_id, parent_unit_id, link_type, source_document_id, actor_id) VALUES ($1, $2, $3, $4, $5)',
      [childUnitId, parentUnitId, linkType, sourceDocumentId, actorId],
    );
  }

  async unitExists(tx: Transaction, unitId: string): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM inv.stock_unit WHERE id = $1', [unitId]);
    return rows.length > 0;
  }

  async lineage(tx: Transaction, unitId: string, direction: 'BACKWARD' | 'FORWARD'): Promise<UnitLink[]> {
    // Backward follows child -> parent; forward parent -> child. The path array stops a cycle a bad row could make.
    const [from, to] = direction === 'BACKWARD' ? ['child_unit_id', 'parent_unit_id'] : ['parent_unit_id', 'child_unit_id'];
    const { rows } = await tx.query<{
      unit_id: string; branch_id: string; identifier: string; product_id: string; tracking: 'SERIAL' | 'LOT'; status: string; supplier_id: string | null;
      source_document_id: string; via_unit_id: string | null; link_type: LinkType | null; link_document_id: string | null; depth: number;
    }>(
      `WITH RECURSIVE walk (unit_id, via_unit_id, link_type, link_document_id, depth, path) AS (
         SELECT $1::uuid, NULL::uuid, NULL::text, NULL::uuid, 0, ARRAY[$1::uuid]
         UNION ALL
         SELECT l.${to}, w.unit_id, l.link_type, l.source_document_id, w.depth + 1, w.path || l.${to}
           FROM walk w JOIN inv.stock_unit_lineage l ON l.${from} = w.unit_id
          WHERE NOT l.${to} = ANY (w.path))
       SELECT ${LINEAGE_COLUMNS}, w.via_unit_id, w.link_type, w.link_document_id, w.depth
         FROM walk w JOIN inv.stock_unit u ON u.id = w.unit_id
        ORDER BY w.depth, u.identifier`,
      [unitId],
    );
    return rows.map((r) => ({
      unitId: r.unit_id,
      branchId: r.branch_id,
      identifier: r.identifier,
      productId: r.product_id,
      tracking: r.tracking,
      status: r.status,
      supplierId: r.supplier_id,
      sourceDocumentId: r.source_document_id,
      via: r.via_unit_id === null ? null : { unitId: r.via_unit_id, linkType: r.link_type!, sourceDocumentId: r.link_document_id! },
      depth: r.depth,
    }));
  }

  async movementsOf(tx: Transaction, unitIds: readonly string[]): Promise<UnitMovement[]> {
    const { rows } = await tx.query<{
      id: string; stock_unit_id: string; movement_type: string; qty_base: string; value_pesewas: string; cost_element: UnitMovement['costElement'];
      source_document_id: string; reverses_movement_id: string | null; occurred_at: Date;
    }>(
      `SELECT id, stock_unit_id, movement_type, qty_base, value_pesewas, cost_element, source_document_id, reverses_movement_id, occurred_at
         FROM inv.stock_movement WHERE stock_unit_id = ANY ($1::uuid[]) ORDER BY occurred_at, recorded_at, id`,
      [unitIds],
    );
    return rows.map((r) => ({
      id: r.id,
      stockUnitId: r.stock_unit_id,
      movementType: r.movement_type,
      qtyBase: r.qty_base,
      valuePesewas: BigInt(r.value_pesewas),
      costElement: r.cost_element,
      sourceDocumentId: r.source_document_id,
      reversesMovementId: r.reverses_movement_id,
      occurredAt: r.occurred_at,
    }));
  }

  async drift(tx: Transaction): Promise<DriftRow[]> {
    const { rows } = await tx.query<{
      kind: 'BALANCE' | 'COST_POOL'; product_id: string; stock_unit_id: string | null; location_id: string | null; branch_id: string;
      projected_qty: string; ledger_qty: string; projected_value: string | null; ledger_value: string | null;
    }>(
      `WITH legs AS (
         SELECT product_id, stock_unit_id, from_location_id AS location_id, -qty_base AS qty FROM inv.stock_movement
         UNION ALL
         SELECT product_id, stock_unit_id, to_location_id, qty_base FROM inv.stock_movement),
       ledger AS (SELECT product_id, stock_unit_id, location_id, sum(qty) AS qty FROM legs GROUP BY 1, 2, 3)
       SELECT 'BALANCE' AS kind, COALESCE(b.product_id, l.product_id) AS product_id, COALESCE(b.stock_unit_id, l.stock_unit_id) AS stock_unit_id,
              COALESCE(b.location_id, l.location_id) AS location_id,
              COALESCE(b.branch_id, (SELECT f.branch_id FROM mdm.location_stock_facts(l.location_id) f)) AS branch_id,
              COALESCE(b.on_hand_qty, 0)::numeric(14,3)::text AS projected_qty, COALESCE(l.qty, 0)::numeric(14,3)::text AS ledger_qty,
              NULL AS projected_value, NULL AS ledger_value
         FROM inv.stock_balance b
         FULL JOIN ledger l ON l.product_id = b.product_id AND l.stock_unit_id IS NOT DISTINCT FROM b.stock_unit_id AND l.location_id = b.location_id
        WHERE COALESCE(b.on_hand_qty, 0) <> COALESCE(l.qty, 0)
       UNION ALL
       SELECT 'COST_POOL', c.product_id, c.stock_unit_id, NULL, c.branch_id, c.qty::text, COALESCE(r.qty, 0)::numeric(14,3)::text,
              c.value_pesewas::text, COALESCE(r.value, 0)::text
         FROM inv.cost_pool c
         LEFT JOIN LATERAL (
           SELECT sum(CASE WHEN m.to_location_id = ANY (pool_locations.ids) THEN m.qty_base ELSE -m.qty_base END) AS qty,
                  sum(CASE WHEN m.to_location_id = ANY (pool_locations.ids) THEN m.value_pesewas ELSE -m.value_pesewas END) AS value
             FROM (SELECT array_agg(b.location_id) AS ids FROM inv.stock_balance b
                    WHERE b.product_id = c.product_id AND b.stock_unit_id IS NOT DISTINCT FROM c.stock_unit_id
                      AND (c.stock_unit_id IS NOT NULL OR b.branch_id = c.branch_id)
                      AND NOT (SELECT f.is_virtual FROM mdm.location_stock_facts(b.location_id) f)) pool_locations,
                  inv.stock_movement m
            WHERE m.product_id = c.product_id AND m.stock_unit_id IS NOT DISTINCT FROM c.stock_unit_id
              AND (m.to_location_id = ANY (pool_locations.ids)) <> (m.from_location_id = ANY (pool_locations.ids))) r ON true
        WHERE c.qty <> COALESCE(r.qty, 0) OR c.value_pesewas <> COALESCE(r.value, 0)`,
    );
    return rows.map((r) => ({
      kind: r.kind,
      productId: r.product_id,
      stockUnitId: r.stock_unit_id,
      locationId: r.location_id,
      branchId: r.branch_id,
      projectedQty: r.projected_qty,
      ledgerQty: r.ledger_qty,
      projectedValuePesewas: r.projected_value === null ? null : BigInt(r.projected_value),
      ledgerValuePesewas: r.ledger_value === null ? null : BigInt(r.ledger_value),
    }));
  }

  async raiseDrift(tx: Transaction, d: DriftRow): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inv.stock_exception (kind, branch_id, product_id, stock_unit_id, location_id, qty, details)
       VALUES ('BALANCE_DRIFT', $1, $2, $3, $4, $5::numeric - $6::numeric, $7) RETURNING id`,
      [
        d.branchId, d.productId, d.stockUnitId, d.locationId, d.projectedQty, d.ledgerQty,
        JSON.stringify({
          projection: d.kind, projectedQty: d.projectedQty, ledgerQty: d.ledgerQty,
          projectedValuePesewas: d.projectedValuePesewas?.toString() ?? null, ledgerValuePesewas: d.ledgerValuePesewas?.toString() ?? null,
        }),
      ],
    );
    return rows[0]!.id;
  }
}
