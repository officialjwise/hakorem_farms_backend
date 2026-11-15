import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ReadScope } from '../application/stock-documents-store';
import type { ExceptionPosition, StockExceptionFilters, StockExceptionRecord, StockExceptionStore } from '../application/stock-exception-store';

const EXCEPTION = `SELECT e.id, e.kind, e.branch_id AS "branchId", e.product_id AS "productId", e.stock_unit_id AS "stockUnitId",
                          e.location_id AS "locationId", e.movement_id AS "movementId", e.source_document_id AS "sourceDocumentId",
                          e.qty::text AS qty, e.details, e.raised_at AS "raisedAt", e.status, e.resolved_at AS "resolvedAt",
                          e.resolved_by AS "resolvedBy", e.resolution_document_id AS "resolutionDocumentId",
                          e.resolution_note AS "resolutionNote", e.resolution_kind AS "resolutionKind"
                     FROM inv.stock_exception e`;

/** The exception table of migrations 0044 and 0060. */
export class PgStockExceptionStore implements StockExceptionStore {
  async exception(tx: Transaction, id: string): Promise<StockExceptionRecord | null> {
    const { rows } = await tx.query<StockExceptionRecord>(`${EXCEPTION} WHERE e.id = $1`, [id]);
    return rows[0] ?? null;
  }

  async lockException(tx: Transaction, id: string): Promise<StockExceptionRecord | null> {
    const { rows } = await tx.query<StockExceptionRecord>(`${EXCEPTION} WHERE e.id = $1 FOR UPDATE`, [id]);
    return rows[0] ?? null;
  }

  async exceptions(tx: Transaction, filters: StockExceptionFilters, scopes: readonly ReadScope[], after: ExceptionPosition | null, limit: number): Promise<StockExceptionRecord[]> {
    const { rows } = await tx.query<StockExceptionRecord>(
      `${EXCEPTION}
        WHERE EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) s(branch_id, location_id)
                       WHERE s.branch_id = e.branch_id AND (s.location_id IS NULL OR s.location_id = e.location_id))
          AND ($3::text IS NULL OR e.status = $3)
          AND ($4::text IS NULL OR e.kind = $4)
          AND ($5::uuid IS NULL OR e.branch_id = $5)
          AND ($6::timestamptz IS NULL OR (e.raised_at, e.id) < ($6, $7::uuid))
        ORDER BY e.raised_at DESC, e.id DESC
        LIMIT $8`,
      [scopes.map((s) => s.branchId), scopes.map((s) => s.locationId), filters.status ?? null, filters.kind ?? null, filters.branchId ?? null, after?.raisedAt ?? null, after?.id ?? null, limit],
    );
    return rows;
  }

  async writeOffPending(tx: Transaction, exceptionId: string): Promise<boolean> {
    const { rowCount } = await tx.query("SELECT 1 FROM inv.stock_adjustment WHERE exception_id = $1 AND status = 'PENDING_APPROVAL'", [exceptionId]);
    return (rowCount ?? 0) > 0;
  }

  async adjustmentFor(tx: Transaction, adjustmentId: string): Promise<{ readonly status: string; readonly exceptionId: string | null } | null> {
    const { rows } = await tx.query<{ status: string; exceptionId: string | null }>('SELECT status, exception_id AS "exceptionId" FROM inv.stock_adjustment WHERE id = $1', [adjustmentId]);
    return rows[0] ?? null;
  }
}
