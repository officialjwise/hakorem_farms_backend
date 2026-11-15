import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ReadScope } from '../application/stock-documents-store';
import type { NewStockHold, StockHoldFilters, StockHoldRecord, StockHoldStore } from '../application/stock-hold-store';

const HOLD = `SELECT h.id, h.stock_unit_id AS "stockUnitId", h.kind, h.starts_at AS "startsAt", h.ends_at AS "endsAt", h.source_document_id AS "sourceDocumentId",
                     h.note, h.released_at AS "releasedAt", h.released_by AS "releasedBy", h.release_reason_code AS "releaseReasonCode",
                     h.release_note AS "releaseNote", h.created_at AS "createdAt", h.created_by AS "createdBy"
                FROM inv.stock_hold h`;

/** The hold table of migrations 0044 and 0057. */
export class PgStockHoldStore implements StockHoldStore {
  async insertHold(tx: Transaction, h: NewStockHold, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO inv.stock_hold (id, stock_unit_id, kind, starts_at, ends_at, source_document_id, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [h.id, h.stockUnitId, h.kind, h.startsAt, h.endsAt, h.sourceDocumentId, h.note, actorId],
    );
  }

  async hold(tx: Transaction, id: string): Promise<StockHoldRecord | null> {
    const { rows } = await tx.query<StockHoldRecord>(`${HOLD} WHERE h.id = $1`, [id]);
    return rows[0] ?? null;
  }

  async lockHold(tx: Transaction, id: string): Promise<StockHoldRecord | null> {
    const { rows } = await tx.query<StockHoldRecord>(`${HOLD} WHERE h.id = $1 FOR UPDATE`, [id]);
    return rows[0] ?? null;
  }

  async holds(tx: Transaction, filters: StockHoldFilters, at: Date, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<StockHoldRecord[]> {
    const { rows } = await tx.query<StockHoldRecord>(
      `${HOLD}
         JOIN inv.stock_unit u ON u.id = h.stock_unit_id
        WHERE EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) s(branch_id, location_id)
                       WHERE s.branch_id = u.branch_id
                         AND (s.location_id IS NULL OR s.location_id = u.current_location_id
                              OR EXISTS (SELECT 1 FROM inv.stock_balance b WHERE b.stock_unit_id = u.id AND b.location_id = s.location_id AND b.on_hand_qty <> 0)))
          AND ($3::boolean IS NULL
               OR $3 = (h.released_at IS NULL AND h.starts_at <= $4 AND (h.ends_at IS NULL OR h.ends_at > $4)))
          AND ($5::text IS NULL OR h.kind = $5)
          AND ($6::uuid IS NULL OR h.stock_unit_id = $6)
          AND ($7::uuid IS NULL OR h.id > $7)
        ORDER BY h.id
        LIMIT $8`,
      [scopes.map((s) => s.branchId), scopes.map((s) => s.locationId), filters.active ?? null, at, filters.kind ?? null, filters.stockUnitId ?? null, afterId, limit],
    );
    return rows;
  }

  async release(tx: Transaction, id: string, r: { at: Date; reasonCode: string; note: string }, actorId: string): Promise<void> {
    await tx.query('UPDATE inv.stock_hold SET released_at = $2, released_by = $3, release_reason_code = $4, release_note = $5 WHERE id = $1', [id, r.at, actorId, r.reasonCode, r.note]);
  }
}
