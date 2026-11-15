import type { Transaction } from '../../../platform/database/unit-of-work';
import type { PlaceUsage } from '../../mdm';
import type { InventoryUsageStore } from '../application/location-usage';

/** ADR-0051's questions in plain SQL over INV's own schema: stock through `inv.pub_stock_on_hand`, documents by status. */
export class PgInventoryUsageStore implements InventoryUsageStore {
  async branchUsage(tx: Transaction, branchId: string): Promise<PlaceUsage> {
    const { rows } = await tx.query<{ holds_stock: boolean; open_documents: number }>(
      `SELECT EXISTS (SELECT 1 FROM inv.pub_stock_on_hand s WHERE s.branch_id = $1 AND s.on_hand_qty <> 0) AS holds_stock,
              ((SELECT count(*) FROM inv.goods_receipt g WHERE g.branch_id = $1 AND g.status = 'DRAFT')
             + (SELECT count(*) FROM inv.stock_transfer t WHERE (t.branch_id = $1 OR t.to_branch_id = $1) AND t.status IN ('DRAFT', 'DISPATCHED'))
             + (SELECT count(*) FROM inv.stock_adjustment a WHERE a.branch_id = $1 AND a.status IN ('DRAFT', 'PENDING_APPROVAL'))
             + (SELECT count(*) FROM inv.stock_reversal r WHERE r.branch_id = $1 AND r.status = 'PENDING_APPROVAL')
             + (SELECT count(*) FROM inv.stock_take k WHERE k.branch_id = $1 AND k.status NOT IN ('POSTED', 'CANCELLED'))
             + (SELECT count(*) FROM inv.stock_exception e WHERE e.branch_id = $1 AND e.status = 'OPEN'))::int AS open_documents`,
      [branchId],
    );
    return { holdsStock: rows[0]!.holds_stock, openDocuments: rows[0]!.open_documents };
  }

  async locationUsage(tx: Transaction, locationId: string): Promise<PlaceUsage> {
    const { rows } = await tx.query<{ holds_stock: boolean; open_documents: number }>(
      `SELECT EXISTS (SELECT 1 FROM inv.pub_stock_on_hand s WHERE s.location_id = $1 AND s.on_hand_qty <> 0) AS holds_stock,
              ((SELECT count(*) FROM inv.goods_receipt g WHERE g.location_id = $1 AND g.status = 'DRAFT')
             + (SELECT count(*) FROM inv.stock_transfer t WHERE (t.from_location_id = $1 OR t.to_location_id = $1 OR t.in_transit_location_id = $1) AND t.status IN ('DRAFT', 'DISPATCHED'))
             + (SELECT count(*) FROM inv.stock_adjustment a WHERE a.location_id = $1 AND a.status IN ('DRAFT', 'PENDING_APPROVAL'))
             + (SELECT count(*) FROM inv.stock_take k WHERE k.location_id = $1 AND k.status NOT IN ('POSTED', 'CANCELLED'))
             + (SELECT count(*) FROM inv.stock_exception e WHERE e.location_id = $1 AND e.status = 'OPEN'))::int AS open_documents`,
      [locationId],
    );
    return { holdsStock: rows[0]!.holds_stock, openDocuments: rows[0]!.open_documents };
  }
}
