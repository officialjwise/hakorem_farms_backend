import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ResolutionKind } from '../domain/stock-exception';
import type {
  AdjustmentFilters,
  AdjustmentLineRecord,
  AdjustmentRecord,
  AdjustmentStatus,
  MovementFilters,
  MovementRecord,
  MovementTypeRecord,
  NewStockException,
  PoolRecord,
  ReadScope,
  ReversalRecord,
  StockDocumentsStore,
  TransferFilters,
  TransferLineRecord,
  TransferRecord,
  TransferStatus,
  UnitRecord,
} from '../application/stock-documents-store';

interface MovementRow {
  id: string;
  movement_type: string;
  product_id: string;
  stock_unit_id: string | null;
  branch_id: string;
  from_location_id: string;
  to_location_id: string;
  qty_base: string;
  weight_kg: string | null;
  weight_source: MovementRecord['weightSource'];
  pack_count: number | null;
  value_pesewas: string;
  cost_element: MovementRecord['costElement'];
  reason_code: string | null;
  source_document_id: string;
  reservation_id: string | null;
  reverses_movement_id: string | null;
  occurred_at: Date;
  recorded_at: Date;
  actor_id: string;
}

const MOVEMENT = `SELECT m.id, m.movement_type, m.product_id, m.stock_unit_id, m.branch_id, m.from_location_id, m.to_location_id, m.qty_base, m.weight_kg,
                         m.weight_source, m.pack_count, m.value_pesewas, m.cost_element, m.reason_code, m.source_document_id, m.reservation_id,
                         m.reverses_movement_id, m.occurred_at, m.recorded_at, m.actor_id
                    FROM inv.stock_movement m`;

/** A row of `unnest($1, $2)` scopes reaches the branch and, when the grant names one, the location. */
const SCOPED = (branch: string, locations: readonly string[]) =>
  `EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) s(branch_id, location_id)
            WHERE s.branch_id = ${branch} AND (s.location_id IS NULL OR s.location_id IN (${locations.join(', ')})))`;

function toMovement(r: MovementRow): MovementRecord {
  return {
    id: r.id,
    movementType: r.movement_type,
    productId: r.product_id,
    stockUnitId: r.stock_unit_id,
    branchId: r.branch_id,
    fromLocationId: r.from_location_id,
    toLocationId: r.to_location_id,
    qtyBase: r.qty_base,
    weightKg: r.weight_kg,
    weightSource: r.weight_source,
    packCount: r.pack_count,
    valuePesewas: BigInt(r.value_pesewas),
    costElement: r.cost_element,
    reasonCode: r.reason_code,
    sourceDocumentId: r.source_document_id,
    reservationId: r.reservation_id,
    reversesMovementId: r.reverses_movement_id,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    actorId: r.actor_id,
  };
}

function scopeArrays(scopes: readonly ReadScope[]): [string[], (string | null)[]] {
  return [scopes.map((s) => s.branchId), scopes.map((s) => s.locationId)];
}

interface TransferRow {
  id: string;
  transfer_no: string | null;
  status: TransferStatus;
  from_location_id: string;
  to_location_id: string;
  to_branch_id: string;
  in_transit_location_id: string | null;
  dispatched_at: Date | null;
  dispatched_by: string | null;
  received_at: Date | null;
  received_by: string | null;
  branch_id: string;
  version: number;
  created_at: Date;
}

const TRANSFER = `SELECT t.id, t.transfer_no, t.status, t.from_location_id, t.to_location_id, t.to_branch_id, t.in_transit_location_id, t.dispatched_at,
                         t.dispatched_by, t.received_at, t.received_by, t.branch_id, t.version, t.created_at
                    FROM inv.stock_transfer t`;

interface AdjustmentRow {
  id: string;
  adjustment_no: string | null;
  status: AdjustmentStatus;
  location_id: string;
  reason_code: string;
  note: string | null;
  total_value_pesewas: string;
  approval_request_id: string | null;
  exception_id: string | null;
  branch_id: string;
  version: number;
  created_at: Date;
  created_by: string;
  posted_at: Date | null;
  posted_by: string | null;
}

const ADJUSTMENT = `SELECT a.id, a.adjustment_no, a.status, a.location_id, a.reason_code, a.note, a.total_value_pesewas, a.approval_request_id, a.exception_id,
                           a.branch_id, a.version, a.created_at, a.created_by, a.posted_at, a.posted_by
                      FROM inv.stock_adjustment a`;

/** Transfers, adjustments, reversals and the movement reads in schema `inv` (migrations 0044 and 0051). */
export class PgStockDocumentsStore implements StockDocumentsStore {
  async movementTypes(tx: Transaction): Promise<MovementTypeRecord[]> {
    const { rows } = await tx.query<MovementTypeRecord>(
      `SELECT code, name, is_value_only AS "isValueOnly", allows_negative AS "allowsNegative", blocked_by_hold AS "blockedByHold",
              requires_reason AS "requiresReason", requires_stock_unit AS "requiresStockUnit"
         FROM inv.movement_type ORDER BY code`,
    );
    return rows;
  }

  async movement(tx: Transaction, id: string): Promise<MovementRecord | null> {
    const { rows } = await tx.query<MovementRow>(`${MOVEMENT} WHERE m.id = $1`, [id]);
    return rows[0] === undefined ? null : toMovement(rows[0]);
  }

  async movements(tx: Transaction, filters: MovementFilters, scopes: readonly ReadScope[], beforeId: string | null, limit: number): Promise<MovementRecord[]> {
    const { rows } = await tx.query<MovementRow>(
      `${MOVEMENT}
        WHERE ${SCOPED('m.branch_id', ['m.from_location_id', 'm.to_location_id'])}
          AND ($3::uuid IS NULL OR m.product_id = $3)
          AND ($4::uuid IS NULL OR m.stock_unit_id = $4)
          AND ($5::uuid IS NULL OR m.from_location_id = $5 OR m.to_location_id = $5)
          AND ($6::text IS NULL OR m.movement_type = $6)
          AND ($7::uuid IS NULL OR m.source_document_id = $7)
          AND ($8::timestamptz IS NULL OR m.occurred_at >= $8)
          AND ($9::timestamptz IS NULL OR m.occurred_at < $9)
          AND ($10::uuid IS NULL OR m.id < $10)
        ORDER BY m.id DESC
        LIMIT $11`,
      [
        ...scopeArrays(scopes),
        filters.productId ?? null,
        filters.stockUnitId ?? null,
        filters.locationId ?? null,
        filters.movementType ?? null,
        filters.sourceDocumentId ?? null,
        filters.from ?? null,
        filters.to ?? null,
        beforeId,
        limit,
      ],
    );
    return rows.map(toMovement);
  }

  async reversedBy(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<{ id: string; reverses_movement_id: string }>(
      'SELECT id, reverses_movement_id FROM inv.stock_movement WHERE reverses_movement_id = ANY($1::uuid[])',
      [ids],
    );
    return new Map(rows.map((r) => [r.reverses_movement_id, r.id] as const));
  }

  async units(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, UnitRecord>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<UnitRecord>(
      `SELECT id, product_id AS "productId", tracking, identifier, status, branch_id AS "branchId", current_location_id AS "currentLocationId"
         FROM inv.stock_unit WHERE id = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    return new Map(rows.map((r) => [r.id, r] as const));
  }

  async pool(tx: Transaction, productId: string, stockUnitId: string | null, branchId: string): Promise<PoolRecord | null> {
    const { rows } = await tx.query<{ qty: string; value_pesewas: string }>(
      'SELECT qty, value_pesewas FROM inv.cost_pool WHERE product_id = $1 AND stock_unit_id IS NOT DISTINCT FROM $2 AND branch_id = $3',
      [productId, stockUnitId, branchId],
    );
    return rows[0] === undefined ? null : { qty: rows[0].qty, valuePesewas: BigInt(rows[0].value_pesewas) };
  }

  async exceptionState(tx: Transaction, id: string): Promise<{ readonly status: string; readonly branchId: string; readonly kind: string; readonly movementId: string | null } | null> {
    const { rows } = await tx.query<{ status: string; branchId: string; kind: string; movementId: string | null }>(
      'SELECT status, branch_id AS "branchId", kind, movement_id AS "movementId" FROM inv.stock_exception WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  async insertException(tx: Transaction, e: NewStockException): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inv.stock_exception (kind, branch_id, product_id, stock_unit_id, location_id, movement_id, source_document_id, qty, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [e.kind, e.branchId, e.productId, e.stockUnitId, e.locationId, e.movementId, e.sourceDocumentId, e.qty, JSON.stringify(e.details)],
    );
    return rows[0]!.id;
  }

  async resolveException(tx: Transaction, id: string, r: { readonly kind: ResolutionKind; readonly note: string; readonly documentId: string | null; readonly at: Date }, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE inv.stock_exception SET status = 'RESOLVED', resolved_at = $2, resolved_by = $3, resolution_document_id = $4, resolution_note = $5, resolution_kind = $6 WHERE id = $1`,
      [id, r.at, actorId, r.documentId, r.note, r.kind],
    );
  }

  // Transfers.

  async insertTransfer(tx: Transaction, t: { id: string; fromLocationId: string; toLocationId: string; toBranchId: string; branchId: string }, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO inv.stock_transfer (id, from_location_id, to_location_id, to_branch_id, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $6)`,
      [t.id, t.fromLocationId, t.toLocationId, t.toBranchId, t.branchId, actorId],
    );
  }

  async insertTransferLine(tx: Transaction, transferId: string, line: Omit<TransferLineRecord, 'qtyReceived' | 'varianceQty' | 'varianceReasonCode'>): Promise<void> {
    await tx.query(
      'INSERT INTO inv.stock_transfer_line (id, stock_transfer_id, line_no, product_id, stock_unit_id, qty_dispatched) VALUES ($1, $2, $3, $4, $5, $6)',
      [line.id, transferId, line.lineNo, line.productId, line.stockUnitId, line.qtyDispatched],
    );
  }

  async lockTransfer(tx: Transaction, id: string): Promise<{ readonly status: TransferStatus; readonly version: number } | null> {
    const { rows } = await tx.query<{ status: TransferStatus; version: number }>('SELECT status, version FROM inv.stock_transfer WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] ?? null;
  }

  async transfer(tx: Transaction, id: string): Promise<TransferRecord | null> {
    const { rows } = await tx.query<TransferRow>(`${TRANSFER} WHERE t.id = $1`, [id]);
    return (await this.assembleTransfers(tx, rows))[0] ?? null;
  }

  async transfers(tx: Transaction, filters: TransferFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<TransferRecord[]> {
    const { rows } = await tx.query<TransferRow>(
      `${TRANSFER}
        WHERE (${SCOPED('t.branch_id', ['t.from_location_id'])} OR ${SCOPED('t.to_branch_id', ['t.to_location_id'])})
          AND ($3::text IS NULL OR t.status = $3)
          AND ($4::uuid IS NULL OR t.from_location_id = $4)
          AND ($5::uuid IS NULL OR t.to_location_id = $5)
          AND ($6::uuid IS NULL OR t.id > $6)
        ORDER BY t.id
        LIMIT $7`,
      [...scopeArrays(scopes), filters.status ?? null, filters.fromLocationId ?? null, filters.toLocationId ?? null, afterId, limit],
    );
    return this.assembleTransfers(tx, rows);
  }

  async setDispatchMovement(tx: Transaction, lineId: string, movementId: string): Promise<void> {
    await tx.query('UPDATE inv.stock_transfer_line SET dispatch_movement_id = $2 WHERE id = $1', [lineId, movementId]);
  }

  async markDispatched(tx: Transaction, id: string, inTransitLocationId: string, at: Date, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE inv.stock_transfer SET status = 'DISPATCHED', in_transit_location_id = $2, dispatched_at = $3, dispatched_by = $4, version = version + 1,
              updated_by = $4, updated_at = now() WHERE id = $1`,
      [id, inTransitLocationId, at, actorId],
    );
  }

  async setLineReceipt(
    tx: Transaction,
    lineId: string,
    r: { received: string; variance: string; reasonCode: string | null; receiptMovementId: string | null; varianceMovementId: string | null },
  ): Promise<void> {
    await tx.query(
      `UPDATE inv.stock_transfer_line SET qty_received = $2, variance_qty = $3, variance_reason_code = $4, receipt_movement_id = $5, variance_movement_id = $6
        WHERE id = $1`,
      [lineId, r.received, r.variance, r.reasonCode, r.receiptMovementId, r.varianceMovementId],
    );
  }

  async markReceived(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    await tx.query(
      "UPDATE inv.stock_transfer SET status = 'RECEIVED', received_at = $2, received_by = $3, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1",
      [id, at, actorId],
    );
  }

  async markTransferCancelled(tx: Transaction, id: string, reason: string, actorId: string): Promise<void> {
    await tx.query("UPDATE inv.stock_transfer SET status = 'CANCELLED', cancel_reason = $2, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1", [
      id,
      reason,
      actorId,
    ]);
  }

  private async assembleTransfers(tx: Transaction, headers: readonly TransferRow[]): Promise<TransferRecord[]> {
    if (headers.length === 0) return [];
    const { rows } = await tx.query<TransferLineRecord & { transferId: string }>(
      `SELECT id, stock_transfer_id AS "transferId", line_no AS "lineNo", product_id AS "productId", stock_unit_id AS "stockUnitId",
              qty_dispatched AS "qtyDispatched", qty_received AS "qtyReceived", variance_qty AS "varianceQty", variance_reason_code AS "varianceReasonCode"
         FROM inv.stock_transfer_line WHERE stock_transfer_id = ANY($1::uuid[]) ORDER BY stock_transfer_id, line_no`,
      [headers.map((h) => h.id)],
    );
    return headers.map((h) => ({
      id: h.id,
      transferNo: h.transfer_no,
      status: h.status,
      fromLocationId: h.from_location_id,
      toLocationId: h.to_location_id,
      toBranchId: h.to_branch_id,
      inTransitLocationId: h.in_transit_location_id,
      dispatchedAt: h.dispatched_at,
      dispatchedBy: h.dispatched_by,
      receivedAt: h.received_at,
      receivedBy: h.received_by,
      branchId: h.branch_id,
      version: h.version,
      createdAt: h.created_at,
      lines: rows.filter((l) => l.transferId === h.id).map(({ transferId: _transferId, ...line }) => line),
    }));
  }

  // Adjustments.

  async insertAdjustment(
    tx: Transaction,
    a: { id: string; locationId: string; reasonCode: string; note: string | null; exceptionId: string | null; branchId: string },
    actorId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO inv.stock_adjustment (id, location_id, reason_code, note, exception_id, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, $7)`,
      [a.id, a.locationId, a.reasonCode, a.note, a.exceptionId, a.branchId, actorId],
    );
  }

  async insertAdjustmentLine(tx: Transaction, adjustmentId: string, l: AdjustmentLineRecord): Promise<void> {
    await tx.query(
      `INSERT INTO inv.stock_adjustment_line (id, stock_adjustment_id, line_no, product_id, stock_unit_id, direction, qty, weight_kg, weight_source, value_pesewas)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [l.id, adjustmentId, l.lineNo, l.productId, l.stockUnitId, l.direction, l.qty, l.weightKg, l.weightSource, l.valuePesewas.toString()],
    );
  }

  async lockAdjustment(tx: Transaction, id: string): Promise<{ readonly status: AdjustmentStatus; readonly version: number } | null> {
    const { rows } = await tx.query<{ status: AdjustmentStatus; version: number }>('SELECT status, version FROM inv.stock_adjustment WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] ?? null;
  }

  async adjustment(tx: Transaction, id: string): Promise<AdjustmentRecord | null> {
    const { rows } = await tx.query<AdjustmentRow>(`${ADJUSTMENT} WHERE a.id = $1`, [id]);
    return (await this.assembleAdjustments(tx, rows))[0] ?? null;
  }

  async adjustments(tx: Transaction, filters: AdjustmentFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<AdjustmentRecord[]> {
    const { rows } = await tx.query<AdjustmentRow>(
      `${ADJUSTMENT}
        WHERE ${SCOPED('a.branch_id', ['a.location_id'])}
          AND ($3::text IS NULL OR a.status = $3)
          AND ($4::uuid IS NULL OR a.location_id = $4)
          AND ($5::text IS NULL OR a.reason_code = $5)
          AND ($6::uuid IS NULL OR a.created_by = $6)
          AND ($7::uuid IS NULL OR a.id > $7)
        ORDER BY a.id
        LIMIT $8`,
      [...scopeArrays(scopes), filters.status ?? null, filters.locationId ?? null, filters.reasonCode ?? null, filters.createdBy ?? null, afterId, limit],
    );
    return this.assembleAdjustments(tx, rows);
  }

  async setAdjustmentLineValue(tx: Transaction, lineId: string, valuePesewas: bigint): Promise<void> {
    await tx.query('UPDATE inv.stock_adjustment_line SET value_pesewas = $2 WHERE id = $1', [lineId, valuePesewas.toString()]);
  }

  async setAdjustmentLineMovement(tx: Transaction, lineId: string, movementId: string): Promise<void> {
    await tx.query('UPDATE inv.stock_adjustment_line SET movement_id = $2 WHERE id = $1', [lineId, movementId]);
  }

  async markAdjustmentJudged(
    tx: Transaction,
    id: string,
    o: { status: 'PENDING_APPROVAL' | 'POSTED'; totalValuePesewas: bigint; thresholdPesewas: bigint; approvalRequestId: string | null; at: Date },
    actorId: string,
  ): Promise<void> {
    const posted = o.status === 'POSTED';
    await tx.query(
      `UPDATE inv.stock_adjustment SET status = $2, total_value_pesewas = $3, approval_threshold_pesewas = $4, approval_request_id = $5,
              posted_at = $6, posted_by = $7, version = version + 1, updated_by = $8, updated_at = now() WHERE id = $1`,
      [id, o.status, o.totalValuePesewas.toString(), o.thresholdPesewas.toString(), o.approvalRequestId, posted ? o.at : null, posted ? actorId : null, actorId],
    );
  }

  async markAdjustmentDecided(tx: Transaction, id: string, status: 'POSTED' | 'REJECTED', at: Date, actorId: string): Promise<void> {
    const posted = status === 'POSTED';
    await tx.query(
      'UPDATE inv.stock_adjustment SET status = $2, posted_at = $3, posted_by = $4, version = version + 1, updated_by = $5, updated_at = now() WHERE id = $1',
      [id, status, posted ? at : null, posted ? actorId : null, actorId],
    );
  }

  private async assembleAdjustments(tx: Transaction, headers: readonly AdjustmentRow[]): Promise<AdjustmentRecord[]> {
    if (headers.length === 0) return [];
    const { rows } = await tx.query<Omit<AdjustmentLineRecord, 'valuePesewas'> & { adjustmentId: string; valuePesewas: string }>(
      `SELECT id, stock_adjustment_id AS "adjustmentId", line_no AS "lineNo", product_id AS "productId", stock_unit_id AS "stockUnitId", direction, qty,
              weight_kg AS "weightKg", weight_source AS "weightSource", value_pesewas AS "valuePesewas", movement_id AS "movementId"
         FROM inv.stock_adjustment_line WHERE stock_adjustment_id = ANY($1::uuid[]) ORDER BY stock_adjustment_id, line_no`,
      [headers.map((h) => h.id)],
    );
    return headers.map((h) => ({
      id: h.id,
      adjustmentNo: h.adjustment_no,
      status: h.status,
      locationId: h.location_id,
      reasonCode: h.reason_code,
      note: h.note,
      totalValuePesewas: BigInt(h.total_value_pesewas),
      approvalRequestId: h.approval_request_id,
      exceptionId: h.exception_id,
      branchId: h.branch_id,
      version: h.version,
      createdAt: h.created_at,
      createdBy: h.created_by,
      postedAt: h.posted_at,
      postedBy: h.posted_by,
      lines: rows
        .filter((l) => l.adjustmentId === h.id)
        .map(({ adjustmentId: _adjustmentId, valuePesewas, ...line }) => ({ ...line, valuePesewas: BigInt(valuePesewas) })),
    }));
  }

  // Reversals.

  async hasOpenReversal(tx: Transaction, movementId: string): Promise<boolean> {
    const { rows } = await tx.query("SELECT 1 FROM inv.stock_reversal WHERE movement_id = $1 AND status <> 'REJECTED'", [movementId]);
    return rows.length > 0;
  }

  async insertReversal(tx: Transaction, r: Omit<ReversalRecord, 'createdBy'> & { thresholdPesewas: bigint; postedAt: Date | null }, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO inv.stock_reversal (id, movement_id, reason_code, note, value_pesewas, approval_threshold_pesewas, approval_request_id, reversal_movement_id,
                                       status, branch_id, created_by, updated_by, posted_at, posted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13)`,
      [
        r.id,
        r.movementId,
        r.reasonCode,
        r.note,
        r.valuePesewas.toString(),
        r.thresholdPesewas.toString(),
        r.approvalRequestId,
        r.reversalMovementId,
        r.status,
        r.branchId,
        actorId,
        r.postedAt,
        r.postedAt === null ? null : actorId,
      ],
    );
  }

  async lockReversal(tx: Transaction, id: string): Promise<ReversalRecord | null> {
    const { rows } = await tx.query<ReversalRecord & { valuePesewas: string }>(
      `SELECT id, movement_id AS "movementId", reason_code AS "reasonCode", note, value_pesewas AS "valuePesewas", approval_request_id AS "approvalRequestId",
              reversal_movement_id AS "reversalMovementId", status, branch_id AS "branchId", created_by AS "createdBy"
         FROM inv.stock_reversal WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : { ...row, valuePesewas: BigInt(row.valuePesewas) };
  }

  async markReversalDecided(tx: Transaction, id: string, o: { status: 'POSTED' | 'REJECTED'; reversalMovementId: string | null; at: Date }, actorId: string): Promise<void> {
    const posted = o.status === 'POSTED';
    await tx.query(
      `UPDATE inv.stock_reversal SET status = $2, reversal_movement_id = $3, posted_at = $4, posted_by = $5, version = version + 1, updated_by = $6, updated_at = now()
        WHERE id = $1`,
      [id, o.status, o.reversalMovementId, posted ? o.at : null, posted ? actorId : null, actorId],
    );
  }
}
