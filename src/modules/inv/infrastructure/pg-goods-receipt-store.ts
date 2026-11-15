import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  AnimalRecord,
  GoodsReceiptStore,
  NewStockUnit,
  ReadScope,
  ReceiptFilters,
  ReceiptHeader,
  ReceiptLineRecord,
  ReceiptRecord,
  ReceiptStatus,
} from '../application/goods-receipt-store';
import type { ReceiptKind } from '../domain/goods-receipt';
import type { WeightSource } from '../application/stock-store';

interface HeaderRow {
  id: string;
  receipt_no: string | null;
  kind: ReceiptKind;
  status: ReceiptStatus;
  supplier_id: string | null;
  location_id: string;
  order_document_id: string | null;
  delivery_note_ref: string | null;
  received_at: Date;
  notes: string | null;
  branch_id: string;
  version: number;
  created_at: Date;
  created_by: string;
  posted_at: Date | null;
  posted_by: string | null;
}

interface LineRow {
  id: string;
  goods_receipt_id: string;
  line_no: number;
  product_id: string;
  order_line_ref: string | null;
  qty_received: string;
  qty_rejected: string;
  weight_kg: string | null;
  weight_source: WeightSource | null;
  value_pesewas: string;
  stock_unit_id: string | null;
  batch_no: string | null;
  expires_on: string | null;
}

interface AnimalRow {
  id: string;
  goods_receipt_line_id: string;
  seq_no: number;
  tag_no: string;
  sex: AnimalRecord['sex'];
  breed: string | null;
  weight_kg: string | null;
  weight_source: WeightSource | null;
  date_of_birth: string | null;
  purpose: AnimalRecord['purpose'];
  stock_unit_id: string | null;
}

const HEADER = `SELECT r.id, r.receipt_no, r.kind, r.status, r.supplier_id, r.location_id, r.order_document_id, r.delivery_note_ref, r.received_at,
                       r.notes, r.branch_id, r.version, r.created_at, r.created_by, r.posted_at, r.posted_by
                  FROM inv.goods_receipt r`;

/** Goods receipts in schema `inv` (migration 0047). Dates come back as calendar strings, money as bigint. */
export class PgGoodsReceiptStore implements GoodsReceiptStore {
  async insertHeader(tx: Transaction, id: string, header: ReceiptHeader, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO inv.goods_receipt (id, kind, supplier_id, location_id, order_document_id, delivery_note_ref, received_at, notes, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', $9, $10, $10)`,
      [id, header.kind, header.supplierId, header.locationId, header.orderDocumentId, header.deliveryNoteRef, header.receivedAt, header.notes, header.branchId, actorId],
    );
  }

  async updateHeader(tx: Transaction, id: string, version: number, set: Record<string, unknown>, actorId: string): Promise<boolean> {
    const columns = Object.keys(set);
    const assignments = columns.map((column, index) => `${column} = $${index + 4}`);
    const { rowCount } = await tx.query(
      `UPDATE inv.goods_receipt SET ${[...assignments, 'version = version + 1', 'updated_by = $3', 'updated_at = now()'].join(', ')} WHERE id = $1 AND version = $2`,
      [id, version, actorId, ...columns.map((column) => set[column])],
    );
    return rowCount === 1;
  }

  async lock(tx: Transaction, id: string): Promise<{ readonly status: ReceiptStatus; readonly version: number } | null> {
    const { rows } = await tx.query<{ status: ReceiptStatus; version: number }>('SELECT status, version FROM inv.goods_receipt WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] ?? null;
  }

  async clearLines(tx: Transaction, id: string): Promise<void> {
    await tx.query('SELECT inv.clear_draft_goods_receipt_lines($1)', [id]);
  }

  async insertLine(tx: Transaction, receiptId: string, line: Omit<ReceiptLineRecord, 'stockUnitId' | 'animals'>): Promise<void> {
    await tx.query(
      `INSERT INTO inv.goods_receipt_line (id, goods_receipt_id, line_no, product_id, order_line_ref, qty_received, qty_rejected, weight_kg, weight_source,
                                           value_pesewas, batch_no, expires_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        line.id,
        receiptId,
        line.lineNo,
        line.productId,
        line.orderLineRef,
        line.qtyReceived,
        line.qtyRejected,
        line.weightKg,
        line.weightSource,
        line.valuePesewas.toString(),
        line.batchNo,
        line.expiresOn,
      ],
    );
  }

  async insertAnimal(tx: Transaction, lineId: string, animal: Omit<AnimalRecord, 'stockUnitId'>): Promise<void> {
    await tx.query(
      `INSERT INTO inv.goods_receipt_animal (id, goods_receipt_line_id, seq_no, tag_no, sex, breed, weight_kg, weight_source, date_of_birth, purpose)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [animal.id, lineId, animal.seqNo, animal.tagNo, animal.sex, animal.breed, animal.weightKg, animal.weightSource, animal.dateOfBirth, animal.purpose],
    );
  }

  async receipt(tx: Transaction, id: string): Promise<ReceiptRecord | null> {
    const { rows } = await tx.query<HeaderRow>(`${HEADER} WHERE r.id = $1`, [id]);
    return (await this.assemble(tx, rows))[0] ?? null;
  }

  async receipts(tx: Transaction, filters: ReceiptFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<ReceiptRecord[]> {
    const { rows } = await tx.query<HeaderRow>(
      `${HEADER}
        WHERE EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) s(branch_id, location_id)
                       WHERE s.branch_id = r.branch_id AND (s.location_id IS NULL OR s.location_id = r.location_id))
          AND ($3::text IS NULL OR r.status = $3)
          AND ($4::uuid IS NULL OR r.supplier_id = $4)
          AND ($5::uuid IS NULL OR r.order_document_id = $5)
          AND ($6::date IS NULL OR (r.received_at AT TIME ZONE 'Africa/Accra')::date >= $6::date)
          AND ($7::date IS NULL OR (r.received_at AT TIME ZONE 'Africa/Accra')::date <= $7::date)
          AND ($8::uuid IS NULL OR r.id > $8)
        ORDER BY r.id
        LIMIT $9`,
      [
        scopes.map((s) => s.branchId),
        scopes.map((s) => s.locationId),
        filters.status ?? null,
        filters.supplierId ?? null,
        filters.purchaseOrderId ?? null,
        filters.from ?? null,
        filters.to ?? null,
        afterId,
        limit,
      ],
    );
    return this.assemble(tx, rows);
  }

  async activeIdentifiers(tx: Transaction, productId: string, identifiers: readonly string[]): Promise<string[]> {
    if (identifiers.length === 0) return [];
    const { rows } = await tx.query<{ identifier: string }>(
      "SELECT identifier FROM inv.stock_unit WHERE product_id = $1 AND identifier = ANY($2::text[]) AND status = 'ACTIVE' AND deleted_at IS NULL",
      [productId, identifiers],
    );
    return rows.map((row) => row.identifier);
  }

  async insertStockUnit(tx: Transaction, unit: NewStockUnit, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO inv.stock_unit (id, product_id, tracking, branch_id, identifier, status, produced_on, expires_on, storage_temp_class, supplier_id,
                                   source_document_id, last_weight_kg, last_weighed_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
      [
        unit.id,
        unit.productId,
        unit.tracking,
        unit.branchId,
        unit.identifier,
        unit.producedOn,
        unit.expiresOn,
        unit.storageTempClass,
        unit.supplierId,
        unit.sourceDocumentId,
        unit.lastWeightKg,
        unit.lastWeighedAt,
        actorId,
      ],
    );
  }

  async setLineUnit(tx: Transaction, lineId: string, unitId: string): Promise<void> {
    await tx.query('UPDATE inv.goods_receipt_line SET stock_unit_id = $2 WHERE id = $1', [lineId, unitId]);
  }

  async setAnimalUnit(tx: Transaction, animalId: string, unitId: string): Promise<void> {
    await tx.query('UPDATE inv.goods_receipt_animal SET stock_unit_id = $2 WHERE id = $1', [animalId, unitId]);
  }

  async markPosted(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    await tx.query("UPDATE inv.goods_receipt SET status = 'POSTED', version = version + 1, posted_at = $2, posted_by = $3, updated_by = $3, updated_at = now() WHERE id = $1", [id, at, actorId]);
  }

  async markCancelled(tx: Transaction, id: string, reason: string, actorId: string): Promise<void> {
    await tx.query("UPDATE inv.goods_receipt SET status = 'CANCELLED', version = version + 1, cancel_reason = $2, updated_by = $3, updated_at = now() WHERE id = $1", [id, reason, actorId]);
  }

  async unitRefs(tx: Transaction, ids: readonly string[]) {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<{ id: string; identifier: string; tracking: 'SERIAL' | 'LOT' }>('SELECT id, identifier, tracking FROM inv.stock_unit WHERE id = ANY($1::uuid[])', [ids]);
    return new Map(rows.map((row) => [row.id, row] as const));
  }

  private async assemble(tx: Transaction, headers: readonly HeaderRow[]): Promise<ReceiptRecord[]> {
    if (headers.length === 0) return [];
    const ids = headers.map((h) => h.id);
    const lines = await tx.query<LineRow>(
      `SELECT id, goods_receipt_id, line_no, product_id, order_line_ref, qty_received, qty_rejected, weight_kg, weight_source, value_pesewas, stock_unit_id,
              batch_no, to_char(expires_on, 'YYYY-MM-DD') AS expires_on
         FROM inv.goods_receipt_line WHERE goods_receipt_id = ANY($1::uuid[]) ORDER BY goods_receipt_id, line_no`,
      [ids],
    );
    const animals = await tx.query<AnimalRow>(
      `SELECT a.id, a.goods_receipt_line_id, a.seq_no, a.tag_no, a.sex, a.breed, a.weight_kg, a.weight_source,
              to_char(a.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, a.purpose, a.stock_unit_id
         FROM inv.goods_receipt_animal a JOIN inv.goods_receipt_line l ON l.id = a.goods_receipt_line_id
        WHERE l.goods_receipt_id = ANY($1::uuid[]) ORDER BY a.goods_receipt_line_id, a.seq_no`,
      [ids],
    );
    const animalsByLine = new Map<string, AnimalRecord[]>();
    for (const a of animals.rows) {
      const list = animalsByLine.get(a.goods_receipt_line_id) ?? [];
      list.push({
        id: a.id,
        seqNo: a.seq_no,
        tagNo: a.tag_no,
        sex: a.sex,
        breed: a.breed,
        weightKg: a.weight_kg,
        weightSource: a.weight_source,
        dateOfBirth: a.date_of_birth,
        purpose: a.purpose,
        stockUnitId: a.stock_unit_id,
      });
      animalsByLine.set(a.goods_receipt_line_id, list);
    }
    const linesByReceipt = new Map<string, ReceiptLineRecord[]>();
    for (const l of lines.rows) {
      const list = linesByReceipt.get(l.goods_receipt_id) ?? [];
      list.push({
        id: l.id,
        lineNo: l.line_no,
        productId: l.product_id,
        orderLineRef: l.order_line_ref,
        qtyReceived: l.qty_received,
        qtyRejected: l.qty_rejected,
        weightKg: l.weight_kg,
        weightSource: l.weight_source,
        valuePesewas: BigInt(l.value_pesewas),
        stockUnitId: l.stock_unit_id,
        batchNo: l.batch_no,
        expiresOn: l.expires_on,
        animals: animalsByLine.get(l.id) ?? [],
      });
      linesByReceipt.set(l.goods_receipt_id, list);
    }
    return headers.map((h) => ({
      id: h.id,
      receiptNo: h.receipt_no,
      kind: h.kind,
      status: h.status,
      supplierId: h.supplier_id,
      locationId: h.location_id,
      orderDocumentId: h.order_document_id,
      deliveryNoteRef: h.delivery_note_ref,
      receivedAt: h.received_at,
      notes: h.notes,
      branchId: h.branch_id,
      version: h.version,
      createdAt: h.created_at,
      createdBy: h.created_by,
      postedAt: h.posted_at,
      postedBy: h.posted_by,
      lines: linesByReceipt.get(h.id) ?? [],
    }));
  }
}
