import type { Transaction } from '../../../platform/database/unit-of-work';
import type { NewReceiptLink, NewReceiptLinkRevocation, ReceiptBindingRecord, NewReceiptTokenRefusal, ReceiptLinkOfSale, ReceiptLinkRecord, ReceiptLinkStore, ReceiptTenderRecord } from '../application/receipt-link-store';

interface LinkRow {
  id: string;
  order_document_id: string;
  branch_id: string;
  issued_at: Date;
  expires_at: Date;
  tenders: ReceiptTenderRecord[];
  change_pesewas: string;
  revoked: boolean;
}

export class PgReceiptLinkStore implements ReceiptLinkStore {
  async bindingOfToken(tx: Transaction, tokenHash: Buffer): Promise<ReceiptBindingRecord | null> {
    const { rows } = await tx.query<{ order_document_id: string; shift_id: string; device_id: string }>('SELECT order_document_id, shift_id, device_id FROM pos.receipt_link WHERE token_hash = $1', [tokenHash]);
    const row = rows[0];
    return row === undefined ? null : { saleId: row.order_document_id, shiftId: row.shift_id, deviceId: row.device_id };
  }

  async liveLink(tx: Transaction, tokenHash: Buffer, at: Date): Promise<ReceiptLinkRecord | null> {
    const { rows } = await tx.query<LinkRow>(
      `SELECT l.id, l.order_document_id, l.branch_id, l.issued_at, l.expires_at, l.tenders, l.change_pesewas::text AS change_pesewas,
              EXISTS (SELECT 1 FROM pos.receipt_link_revocation r WHERE r.receipt_link_id = l.id AND r.revoked_at <= $2) AS revoked
         FROM pos.receipt_link l
        WHERE l.token_hash = $1 AND l.expires_at > $2`,
      [tokenHash, at],
    );
    const row = rows[0];
    if (row === undefined || row.revoked) return null;
    return { id: row.id, orderDocumentId: row.order_document_id, branchId: row.branch_id, issuedAt: row.issued_at, expiresAt: row.expires_at, tenders: row.tenders, changePesewas: BigInt(row.change_pesewas), revoked: row.revoked };
  }

  async insertLink(tx: Transaction, l: NewReceiptLink): Promise<void> {
    await tx.query(
      `INSERT INTO pos.receipt_link (id, order_document_id, branch_id, shift_id, device_id, source, token_hash, issued_at, expires_at, tenders, change_pesewas, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, 'TILL', $6, $7, (($7::timestamptz AT TIME ZONE 'UTC') + interval '12 months') AT TIME ZONE 'UTC', $8::jsonb, $9, $10, $11)`,
      [l.id, l.orderDocumentId, l.branchId, l.shiftId, l.deviceId, l.tokenHash, l.issuedAt, JSON.stringify(l.tenders), l.changePesewas.toString(), l.recordedAt, l.actorId],
    );
  }

  async insertRefusal(tx: Transaction, r: NewReceiptTokenRefusal): Promise<void> {
    await tx.query(
      `INSERT INTO pos.receipt_token_refusal (order_document_id, token_hash, reason, bound_order_document_id, branch_id, shift_id, device_id, cashier_id, needs_server_link, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10)`,
      [r.orderDocumentId, r.tokenHash, r.reason, r.boundOrderDocumentId, r.branchId, r.shiftId, r.deviceId, r.cashierId, r.recordedAt, r.actorId],
    );
  }

  async linkOfSale(tx: Transaction, saleId: string): Promise<ReceiptLinkOfSale | null> {
    const { rows } = await tx.query<{ id: string; branch_id: string; revoked: boolean }>(
      `SELECT l.id, l.branch_id, EXISTS (SELECT 1 FROM pos.receipt_link_revocation r WHERE r.receipt_link_id = l.id) AS revoked
         FROM pos.receipt_link l WHERE l.order_document_id = $1`,
      [saleId],
    );
    const row = rows[0];
    return row === undefined ? null : { id: row.id, branchId: row.branch_id, revoked: row.revoked };
  }

  async insertRevocation(tx: Transaction, r: NewReceiptLinkRevocation): Promise<void> {
    await tx.query('INSERT INTO pos.receipt_link_revocation (receipt_link_id, reason, revoked_at, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5)', [r.receiptLinkId, r.reason, r.revokedAt, r.recordedAt, r.actorId]);
  }
}
