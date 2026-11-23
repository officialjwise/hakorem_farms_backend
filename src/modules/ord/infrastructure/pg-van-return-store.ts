import type { Transaction } from '../../../platform/database/unit-of-work';
import type { NewVanReturn, VanReturnRecord, VanReturnStore } from '../application/van-return-store';

const COLUMNS = `id, delivery_id AS "deliveryId", sales_order_id AS "salesOrderId", original_billing_document_id AS "originalBillingDocumentId", way_out AS "wayOut",
  returns_location_id AS "returnsLocationId", reason_code AS "reasonCode", stock_adjustment_id AS "stockAdjustmentId", note, refund_destination AS "refundDestination",
  status, credit_note_id AS "creditNoteId", refund_id AS "refundId", branch_id AS "branchId", created_by AS "createdBy"`;

/** ORD's `ord.delivery_return` in PostgreSQL (migration 0323). The guard decides what may change; this writes and reads. */
export class PgVanReturnStore implements VanReturnStore {
  async insertPending(tx: Transaction, r: NewVanReturn): Promise<void> {
    await this.insert(tx, r, 'PENDING_APPROVAL', null);
  }

  async insertPosted(tx: Transaction, r: NewVanReturn & { readonly creditNoteId: string }): Promise<void> {
    await this.insert(tx, r, 'POSTED', r.creditNoteId);
  }

  async post(tx: Transaction, id: string, p: { readonly creditNoteId: string; readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query(`UPDATE ord.delivery_return SET status = 'POSTED', credit_note_id = $2, posted_at = $3, posted_by = $4, updated_at = $3, updated_by = $4, version = version + 1 WHERE id = $1`, [id, p.creditNoteId, p.at, p.actorId]);
  }

  async reject(tx: Transaction, id: string, p: { readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query(`UPDATE ord.delivery_return SET status = 'REJECTED', updated_at = $2, updated_by = $3, version = version + 1 WHERE id = $1`, [id, p.at, p.actorId]);
  }

  async setRefund(tx: Transaction, id: string, p: { readonly refundId: string; readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query('UPDATE ord.delivery_return SET refund_id = $2, updated_at = $3, updated_by = $4, version = version + 1 WHERE id = $1', [id, p.refundId, p.at, p.actorId]);
  }

  async liveOfDelivery(tx: Transaction, deliveryId: string): Promise<VanReturnRecord | null> {
    return this.one(tx, `delivery_id = $1 AND status <> 'REJECTED'`, deliveryId);
  }

  async ofAdjustment(tx: Transaction, stockAdjustmentId: string): Promise<VanReturnRecord | null> {
    return this.one(tx, 'stock_adjustment_id = $1', stockAdjustmentId);
  }

  async ofCreditNote(tx: Transaction, creditNoteId: string): Promise<VanReturnRecord | null> {
    return this.one(tx, 'credit_note_id = $1', creditNoteId);
  }

  private async one(tx: Transaction, where: string, value: string): Promise<VanReturnRecord | null> {
    const { rows } = await tx.query<VanReturnRecord>(`SELECT ${COLUMNS} FROM ord.delivery_return WHERE ${where} FOR UPDATE`, [value]);
    return rows[0] ?? null;
  }

  private async insert(tx: Transaction, r: NewVanReturn, status: 'PENDING_APPROVAL' | 'POSTED', creditNoteId: string | null): Promise<void> {
    await tx.query(
      `INSERT INTO ord.delivery_return (id, delivery_id, sales_order_id, original_billing_document_id, way_out, returns_location_id, reason_code, stock_adjustment_id, note,
                                        refund_destination, status, credit_note_id, branch_id, created_at, created_by, updated_at, updated_by, posted_at, posted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $14, $15, $16, $17)`,
      [
        r.id,
        r.deliveryId,
        r.salesOrderId,
        r.originalBillingDocumentId,
        r.wayOut,
        r.returnsLocationId,
        r.reasonCode,
        r.stockAdjustmentId,
        r.note,
        r.refundDestination,
        status,
        creditNoteId,
        r.branchId,
        r.at,
        r.createdBy,
        status === 'POSTED' ? r.at : null,
        status === 'POSTED' ? r.createdBy : null,
      ],
    );
  }
}
