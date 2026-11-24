import type { Transaction } from '../../../platform/database/unit-of-work';
import type { HeldOfLine, NewReturn, ReturnLineRecord, ReturnRecord, ReturnStore } from '../application/return-store';

type HeaderRow = Omit<ReturnRecord, 'lines'>;
type LineRow = Omit<ReturnLineRecord, 'refundPesewas'> & { readonly orderReturnId: string; readonly refundPesewas: string };

/** ORD's returns in PostgreSQL (migration 0200). The triggers decide what may be returned; this inserts and reads. */
export class PgReturnStore implements ReturnStore {
  async insert(tx: Transaction, r: NewReturn): Promise<void> {
    await tx.query(
      `INSERT INTO ord.order_return (id, return_no, sales_order_id, original_billing_document_id, kind, reason_code, refund_destination, note, status, branch_id,
                                     created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'REQUESTED', $9, $10, $10)`,
      [r.id, r.returnNo, r.salesOrderId, r.originalBillingDocumentId, r.kind, r.reasonCode, r.refundDestination, r.note, r.branchId, r.createdBy],
    );
    for (const l of r.lines) {
      await tx.query(
        'INSERT INTO ord.order_return_line (id, order_return_id, sales_order_line_id, line_no, qty, uom, pieces_per_unit, weight_kg, disposition, refund_pesewas) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [l.id, r.id, l.salesOrderLineId, l.lineNo, l.qty, l.uom, l.piecesPerUnit, l.weightKg, l.disposition, l.refundPesewas.toString()],
      );
    }
  }

  async returns(tx: Transaction, ids: readonly string[], forUpdate = false): Promise<ReturnRecord[]> {
    if (ids.length === 0) return [];
    const headers = await tx.query<HeaderRow>(
      `SELECT id, return_no AS "returnNo", sales_order_id AS "salesOrderId", original_billing_document_id AS "originalBillingDocumentId", kind, reason_code AS "reasonCode",
              refund_destination AS "refundDestination", note, status, approval_request_id AS "approvalRequestId", credit_note_id AS "creditNoteId", refund_id AS "refundId",
              submitted_by AS "submittedBy", decided_by AS "decidedBy", branch_id AS "branchId", version, created_at AS "createdAt", created_by AS "createdBy"
         FROM ord.order_return WHERE id = ANY($1::uuid[]) ORDER BY id${forUpdate ? ' FOR UPDATE' : ''}`,
      [ids],
    );
    const lines = await tx.query<LineRow>(
      `SELECT id, order_return_id AS "orderReturnId", sales_order_line_id AS "salesOrderLineId", line_no AS "lineNo", qty::text AS qty, uom, pieces_per_unit AS "piecesPerUnit", weight_kg::text AS "weightKg",
              disposition, refund_pesewas::text AS "refundPesewas", stock_movement_id AS "stockMovementId"
         FROM ord.order_return_line WHERE order_return_id = ANY($1::uuid[]) ORDER BY order_return_id, line_no`,
      [ids],
    );
    return headers.rows.map((h) => ({
      ...h,
      lines: lines.rows.filter((l) => l.orderReturnId === h.id).map(({ orderReturnId: _of, refundPesewas, ...l }) => ({ ...l, refundPesewas: BigInt(refundPesewas) })),
    }));
  }

  async idByApproval(tx: Transaction, approvalRequestId: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM ord.order_return WHERE approval_request_id = $1', [approvalRequestId]);
    return rows[0]?.id ?? null;
  }

  async heldOf(tx: Transaction, salesOrderLineIds: readonly string[]): Promise<ReadonlyMap<string, HeldOfLine>> {
    if (salesOrderLineIds.length === 0) return new Map();
    const { rows } = await tx.query<HeldOfLine & { line: string }>(
      `SELECT l.sales_order_line_id AS line,
              COALESCE(sum(l.qty) FILTER (WHERE l.uom IS NULL), 0)::numeric(14,3)::text AS "wholeQty",
              COALESCE(sum(l.qty) FILTER (WHERE l.uom IS NOT NULL), 0)::numeric(14,3)::text AS pieces,
              count(*) FILTER (WHERE r.status IN ('REQUESTED', 'PENDING_APPROVAL'))::int AS open,
              count(*) FILTER (WHERE r.status IN ('REQUESTED', 'PENDING_APPROVAL') AND l.uom IS NOT NULL)::int AS "openParts"
         FROM ord.order_return_line l JOIN ord.order_return r ON r.id = l.order_return_id
        WHERE l.sales_order_line_id = ANY($1::uuid[]) AND r.status <> 'REJECTED'
        GROUP BY l.sales_order_line_id`,
      [salesOrderLineIds],
    );
    return new Map(rows.map(({ line, ...held }) => [line, held] as const));
  }

  async submit(tx: Transaction, id: string, s: { readonly approvalRequestId: string; readonly actorId: string; readonly at: Date }): Promise<void> {
    await tx.query(
      "UPDATE ord.order_return SET status = 'PENDING_APPROVAL', approval_request_id = $2, submitted_by = $3, submitted_at = $4, updated_by = $3, updated_at = $4, version = version + 1 WHERE id = $1",
      [id, s.approvalRequestId, s.actorId, s.at],
    );
  }

  async setLine(tx: Transaction, lineId: string, l: { readonly refundPesewas: bigint; readonly stockMovementId: string | null }): Promise<void> {
    await tx.query('UPDATE ord.order_return_line SET refund_pesewas = $2, stock_movement_id = $3 WHERE id = $1', [lineId, l.refundPesewas.toString(), l.stockMovementId]);
  }

  async decide(tx: Transaction, id: string, d: { readonly status: 'COMPLETED' | 'REJECTED'; readonly creditNoteId: string | null; readonly refundId: string | null; readonly decidedBy: string; readonly at: Date }): Promise<void> {
    await tx.query(
      'UPDATE ord.order_return SET status = $2, credit_note_id = $3, refund_id = $4, decided_by = $5, decided_at = $6, updated_by = $5, updated_at = $6, version = version + 1 WHERE id = $1',
      [id, d.status, d.creditNoteId, d.refundId, d.decidedBy, d.at],
    );
  }
}
