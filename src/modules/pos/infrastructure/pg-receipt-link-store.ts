import type { Transaction } from '../../../platform/database/unit-of-work';
import type { NewReceiptLink, NewReceiptMessageLink, NewReceiptLinkRevocation, ReceiptBindingRecord, NewReceiptTokenRefusal, ReceiptLinkOfSale, ReceiptLinkRecord, ReceiptLinkStore, ReceiptTenderRecord } from '../application/receipt-link-store';

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
    // A till link's hash answers as it always has; only a hash no till link holds is looked for among the links sent by
    // message (B11 continued 12), each answering its own till link's receipt while that is live.
    const row = rows[0] ?? (await this.liveMessageLink(tx, tokenHash, at));
    if (row === undefined || row.revoked) return null;
    return { id: row.id, orderDocumentId: row.order_document_id, branchId: row.branch_id, issuedAt: row.issued_at, expiresAt: row.expires_at, tenders: row.tenders, changePesewas: BigInt(row.change_pesewas), revoked: row.revoked };
  }

  /** The till link a message link's hash opens, by the same rules as a till link's own hash, or undefined. */
  private async liveMessageLink(tx: Transaction, tokenHash: Buffer, at: Date): Promise<LinkRow | undefined> {
    const { rows } = await tx.query<LinkRow>(
      `SELECT l.id, l.order_document_id, l.branch_id, l.issued_at, l.expires_at, l.tenders, l.change_pesewas::text AS change_pesewas,
              EXISTS (SELECT 1 FROM pos.receipt_link_revocation r WHERE r.receipt_link_id = l.id AND r.revoked_at <= $2) AS revoked
         FROM pos.receipt_message_link m
         JOIN pos.receipt_link l ON l.id = m.receipt_link_id AND l.order_document_id = m.order_document_id
        WHERE m.token_hash = $1 AND m.expires_at > $2 AND l.expires_at > $2`,
      [tokenHash, at],
    );
    return rows[0];
  }

  async liveTillLinkOfSale(tx: Transaction, saleId: string, at: Date): Promise<{ readonly id: string; readonly expiresAt: Date } | null> {
    const { rows } = await tx.query<{ id: string; expires_at: Date }>(
      `SELECT l.id, l.expires_at FROM pos.receipt_link l
        WHERE l.order_document_id = $1 AND l.source = 'TILL' AND l.expires_at > $2
          AND NOT EXISTS (SELECT 1 FROM pos.receipt_link_revocation r WHERE r.receipt_link_id = l.id AND r.revoked_at <= $2)`,
      [saleId, at],
    );
    const row = rows[0];
    return row === undefined ? null : { id: row.id, expiresAt: row.expires_at };
  }

  async insertMessageLink(tx: Transaction, m: NewReceiptMessageLink): Promise<void> {
    await tx.query(
      'INSERT INTO pos.receipt_message_link (id, receipt_link_id, order_document_id, token_hash, expires_at, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [m.id, m.receiptLinkId, m.orderDocumentId, m.tokenHash, m.expiresAt, m.recordedAt, m.actorId],
    );
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
