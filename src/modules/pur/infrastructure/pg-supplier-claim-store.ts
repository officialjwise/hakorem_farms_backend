import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ClaimFilter, ClaimLineRecord, ClaimRecord, ClaimSettlement, ClaimStatus, SupplierClaimStore } from '../application/supplier-claim-store';

interface ClaimRow {
  id: string;
  supplier_id: string;
  purchase_order_id: string;
  goods_receipt_id: string;
  received_by: string;
  note: string | null;
  claimed: string;
  status: ClaimStatus;
  settlement: ClaimSettlement | null;
  settled_by_invoice_id: string | null;
  branch_id: string;
  version: number;
  created_at: Date;
  created_by: string;
  posted_at: Date | null;
  posted_by: string | null;
}

interface ClaimLineRow {
  id: string;
  supplier_claim_id: string;
  line_no: number;
  goods_receipt_line_id: string;
  purchase_order_line_id: string;
  product_id: string;
  rejection_reason_code: string;
  accepted: string;
  rejected: string;
  line_value: string;
  accepted_value: string;
  claimed_value: string;
}

const CLAIM_COLUMNS = `c.id, c.supplier_id, c.purchase_order_id, c.goods_receipt_id, c.received_by, c.note, c.claimed_pesewas::text AS claimed, c.status,
  c.settlement, c.settled_by_invoice_id, c.branch_id, c.version, c.created_at, c.created_by, c.posted_at, c.posted_by`;

/** `pur.supplier_claim` and `pur.supplier_claim_line` (migration 0223), always in the caller's transaction. */
export class PgSupplierClaimStore implements SupplierClaimStore {
  async insertClaim(tx: Transaction, claim: Parameters<SupplierClaimStore['insertClaim']>[1]): Promise<void> {
    await tx.query(
      `INSERT INTO pur.supplier_claim (id, supplier_id, purchase_order_id, goods_receipt_id, received_by, note, claimed_pesewas, status, branch_id,
                                       created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, $9, $10, $9, $10)`,
      [claim.id, claim.supplierId, claim.purchaseOrderId, claim.goodsReceiptId, claim.receivedBy, claim.note, claim.claimedPesewas.toString(), claim.branchId, claim.createdAt, claim.createdBy],
    );
    for (const l of claim.lines) {
      await tx.query(
        `INSERT INTO pur.supplier_claim_line (id, supplier_claim_id, line_no, goods_receipt_line_id, purchase_order_line_id, product_id, rejection_reason_code,
                                              qty_accepted_base, qty_rejected_base, line_value_pesewas, accepted_value_pesewas, claimed_value_pesewas)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [l.id, claim.id, l.lineNo, l.goodsReceiptLineId, l.purchaseOrderLineId, l.productId, l.rejectionReasonCode, l.qtyAcceptedBase, l.qtyRejectedBase,
          l.lineValuePesewas.toString(), l.acceptedValuePesewas.toString(), l.claimedValuePesewas.toString()],
      );
    }
  }

  async claim(tx: Transaction, id: string): Promise<ClaimRecord | null> {
    return (await this.claimsWhere(tx, 'c.id = $1', [id]))[0] ?? null;
  }

  async lockClaim(tx: Transaction, id: string): Promise<ClaimRecord | null> {
    return (await this.claimsWhere(tx, 'c.id = $1', [id], ' FOR UPDATE OF c'))[0] ?? null;
  }

  async claimOfReceipt(tx: Transaction, goodsReceiptId: string): Promise<ClaimRecord | null> {
    return (await this.claimsWhere(tx, 'c.goods_receipt_id = $1', [goodsReceiptId]))[0] ?? null;
  }

  listClaims(tx: Transaction, filter: ClaimFilter, branches: readonly string[], beforeId: string | null, limit: number): Promise<ClaimRecord[]> {
    return this.claimsWhere(
      tx,
      `c.branch_id = ANY($1::uuid[]) AND ($2::text IS NULL OR c.status = $2) AND ($3::uuid IS NULL OR c.supplier_id = $3)
         AND ($4::uuid IS NULL OR c.purchase_order_id = $4) AND ($5::uuid IS NULL OR c.goods_receipt_id = $5) AND ($6::uuid IS NULL OR c.id < $6)`,
      [branches, filter.status ?? null, filter.supplierId ?? null, filter.purchaseOrderId ?? null, filter.goodsReceiptId ?? null, beforeId, limit],
      ' ORDER BY c.id DESC LIMIT $7',
    );
  }

  async claimedQty(tx: Transaction, orderLineIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (orderLineIds.length === 0) return new Map();
    const { rows } = await tx.query<{ line_id: string; qty: string }>(
      `SELECT l.purchase_order_line_id AS line_id, sum(l.qty_rejected_base)::text AS qty
         FROM pur.supplier_claim_line l JOIN pur.supplier_claim c ON c.id = l.supplier_claim_id
        WHERE l.purchase_order_line_id = ANY($1::uuid[]) AND c.settlement IS DISTINCT FROM 'INVOICE'
        GROUP BY l.purchase_order_line_id`,
      [orderLineIds],
    );
    return new Map(rows.map((r) => [r.line_id, r.qty] as const));
  }

  async creditedQty(tx: Transaction, orderLineIds: readonly string[], exceptClaimId: string): Promise<ReadonlyMap<string, string>> {
    if (orderLineIds.length === 0) return new Map();
    const { rows } = await tx.query<{ line_id: string; qty: string }>(
      `SELECT l.purchase_order_line_id AS line_id, sum(l.qty_rejected_base)::text AS qty
         FROM pur.supplier_claim_line l JOIN pur.supplier_claim c ON c.id = l.supplier_claim_id
        WHERE l.purchase_order_line_id = ANY($1::uuid[]) AND c.id <> $2
          AND (c.settlement = 'CREDIT_NOTE'
               OR EXISTS (SELECT 1 FROM pur.supplier_invoice i WHERE i.supplier_claim_id = c.id AND i.status <> 'CANCELLED'))
        GROUP BY l.purchase_order_line_id`,
      [orderLineIds, exceptClaimId],
    );
    return new Map(rows.map((r) => [r.line_id, r.qty] as const));
  }

  async liveCreditNotes(tx: Transaction, claimIds: readonly string[]): Promise<ReadonlyMap<string, { readonly id: string; readonly status: string; readonly supplierInvoiceNo: string }>> {
    if (claimIds.length === 0) return new Map();
    const { rows } = await tx.query<{ claim_id: string; id: string; status: string; no: string }>(
      `SELECT i.supplier_claim_id AS claim_id, i.id, i.status, i.supplier_invoice_no AS no
         FROM pur.supplier_invoice i WHERE i.supplier_claim_id = ANY($1::uuid[]) AND i.status <> 'CANCELLED'`,
      [claimIds],
    );
    return new Map(rows.map((r) => [r.claim_id, { id: r.id, status: r.status, supplierInvoiceNo: r.no }] as const));
  }

  async settle(tx: Transaction, id: string, settlement: ClaimSettlement, invoiceId: string, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `UPDATE pur.supplier_claim SET version = version + 1, status = 'SETTLED', settlement = $2, settled_by_invoice_id = $3, posted_at = $5, posted_by = $4, updated_at = $5, updated_by = $4
        WHERE id = $1 AND status = 'OPEN'`,
      [id, settlement, invoiceId, actorId, at],
    );
  }

  private async claimsWhere(tx: Transaction, where: string, values: unknown[], tail = ''): Promise<ClaimRecord[]> {
    const { rows } = await tx.query<ClaimRow>(`SELECT ${CLAIM_COLUMNS} FROM pur.supplier_claim c WHERE ${where}${tail}`, values);
    if (rows.length === 0) return [];
    const { rows: lineRows } = await tx.query<ClaimLineRow>(
      `SELECT l.id, l.supplier_claim_id, l.line_no, l.goods_receipt_line_id, l.purchase_order_line_id, l.product_id, l.rejection_reason_code,
              l.qty_accepted_base::text AS accepted, l.qty_rejected_base::text AS rejected, l.line_value_pesewas::text AS line_value,
              l.accepted_value_pesewas::text AS accepted_value, l.claimed_value_pesewas::text AS claimed_value
         FROM pur.supplier_claim_line l WHERE l.supplier_claim_id = ANY($1::uuid[]) ORDER BY l.line_no`,
      [rows.map((r) => r.id)],
    );
    const line = (l: ClaimLineRow): ClaimLineRecord => ({
      id: l.id,
      lineNo: l.line_no,
      goodsReceiptLineId: l.goods_receipt_line_id,
      purchaseOrderLineId: l.purchase_order_line_id,
      productId: l.product_id,
      rejectionReasonCode: l.rejection_reason_code,
      qtyAcceptedBase: l.accepted,
      qtyRejectedBase: l.rejected,
      lineValuePesewas: BigInt(l.line_value),
      acceptedValuePesewas: BigInt(l.accepted_value),
      claimedValuePesewas: BigInt(l.claimed_value),
    });
    return rows.map((r) => ({
      id: r.id,
      supplierId: r.supplier_id,
      purchaseOrderId: r.purchase_order_id,
      goodsReceiptId: r.goods_receipt_id,
      receivedBy: r.received_by,
      note: r.note,
      claimedPesewas: BigInt(r.claimed),
      status: r.status,
      settlement: r.settlement,
      settledByInvoiceId: r.settled_by_invoice_id,
      branchId: r.branch_id,
      version: r.version,
      createdAt: r.created_at,
      createdBy: r.created_by,
      postedAt: r.posted_at,
      postedBy: r.posted_by,
      lines: lineRows.filter((l) => l.supplier_claim_id === r.id).map(line),
    }));
  }
}
