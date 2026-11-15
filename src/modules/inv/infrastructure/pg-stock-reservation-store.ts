import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ReadScope } from '../application/stock-documents-store';
import type { StockReservationFilters, StockReservationRecord, StockReservationStore } from '../application/stock-reservation-store';

const RESERVATION = `SELECT r.id, r.product_id AS "productId", r.stock_unit_id AS "stockUnitId", r.location_id AS "locationId", r.qty::text AS qty,
                            r.is_exclusive AS "isExclusive", r.holder_document_id AS "holderDocumentId", r.status, r.expires_at AS "expiresAt",
                            r.released_reason AS "releasedReason", r.branch_id AS "branchId", r.created_at AS "createdAt"
                       FROM inv.stock_reservation r`;

/** The reservation table of migration 0044, whose triggers keep `stock_balance.reserved_qty` (ADR-0019). */
export class PgStockReservationStore implements StockReservationStore {
  async insert(tx: Transaction, r: Omit<StockReservationRecord, 'status' | 'releasedReason' | 'createdAt'>, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO inv.stock_reservation (id, product_id, stock_unit_id, location_id, qty, is_exclusive, holder_document_id, status, expires_at, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8, $9, $10, $10)`,
      [r.id, r.productId, r.stockUnitId, r.locationId, r.qty, r.isExclusive, r.holderDocumentId, r.expiresAt, r.branchId, actorId],
    );
  }

  async reservation(tx: Transaction, id: string): Promise<StockReservationRecord | null> {
    const { rows } = await tx.query<StockReservationRecord>(`${RESERVATION} WHERE r.id = $1`, [id]);
    return rows[0] ?? null;
  }

  async lock(tx: Transaction, id: string): Promise<StockReservationRecord | null> {
    const { rows } = await tx.query<StockReservationRecord>(`${RESERVATION} WHERE r.id = $1 FOR UPDATE`, [id]);
    return rows[0] ?? null;
  }

  async reservations(tx: Transaction, filters: StockReservationFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<StockReservationRecord[]> {
    const { rows } = await tx.query<StockReservationRecord>(
      `${RESERVATION}
        WHERE EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) s(branch_id, location_id)
                       WHERE s.branch_id = r.branch_id AND (s.location_id IS NULL OR s.location_id = r.location_id))
          AND ($3::text IS NULL OR r.status = $3)
          AND ($4::uuid IS NULL OR r.product_id = $4)
          AND ($5::uuid IS NULL OR r.holder_document_id = $5)
          AND ($6::uuid IS NULL OR r.id > $6)
        ORDER BY r.id
        LIMIT $7`,
      [scopes.map((s) => s.branchId), scopes.map((s) => s.locationId), filters.status ?? null, filters.productId ?? null, filters.holderDocumentId ?? null, afterId, limit],
    );
    return rows;
  }

  async end(tx: Transaction, id: string, status: 'RELEASED' | 'EXPIRED', reason: string, actorId: string): Promise<void> {
    await tx.query('UPDATE inv.stock_reservation SET status = $2, released_reason = $3, version = version + 1, updated_by = $4, updated_at = now() WHERE id = $1', [id, status, reason, actorId]);
  }

  async lockDue(tx: Transaction, at: Date, limit: number): Promise<StockReservationRecord[]> {
    const { rows } = await tx.query<StockReservationRecord>(
      `${RESERVATION} WHERE r.status = 'ACTIVE' AND r.expires_at <= $1 ORDER BY r.expires_at, r.id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [at, limit],
    );
    return rows;
  }
}
