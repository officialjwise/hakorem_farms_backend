import type { Transaction } from '../../../platform/database/unit-of-work';
import type { NewOrder, NewOrderLine, OrderFilter, OrderHeaderRecord, OrderLineRecord, OrderRecord, OrderStore, OrderVoidRecord, ShiftSalesSummary, StatusChangeRecord, TrackingTokenRecord } from '../application/order-store';

const big = (value: string | null): bigint | null => (value === null ? null : BigInt(value));

/** ORD's tables in PostgreSQL. Point reads by key only: a sale posts at serializable isolation (ADR-0005). */
export class PgOrderStore implements OrderStore {
  async insertOrder(tx: Transaction, o: NewOrder): Promise<void> {
    await tx.query(
      `INSERT INTO ord.sales_order (id, order_no, channel, customer_id, contact_name, contact_phone_e164, status, payment_terms, fulfilment_mode, source_document_id,
                                    shift_document_id, salesperson_id, tax_inclusive, delivery_fee_pesewas, estimated_total_pesewas, maximum_total_pesewas,
                                    is_offline, placed_at, notes, branch_id, created_by, updated_by, delivery_address_snapshot, delivery_zone_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'PLACED', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20, $21::jsonb, $22)`,
      [
        o.id,
        o.orderNo,
        o.channel,
        o.customerId,
        o.contactName,
        o.contactPhone,
        o.paymentTerms,
        o.fulfilmentMode,
        o.sourceDocumentId,
        o.shiftDocumentId,
        o.salespersonId,
        o.taxInclusive,
        o.deliveryFeePesewas.toString(),
        o.estimatedTotalPesewas.toString(),
        o.maximumTotalPesewas.toString(),
        o.isOffline,
        o.placedAt,
        o.notes,
        o.branchId,
        o.actorId,
        o.deliveryAddressSnapshot === undefined || o.deliveryAddressSnapshot === null ? null : JSON.stringify(o.deliveryAddressSnapshot),
        o.deliveryZoneId ?? null,
      ],
    );
  }

  async insertLines(tx: Transaction, lines: readonly NewOrderLine[]): Promise<void> {
    for (const l of lines) {
      await tx.query(
        `INSERT INTO ord.sales_order_line (id, sales_order_id, line_no, product_id, stock_unit_id, qty_ordered, uom, price_source, price_basis, price_list_entry_id,
                                           resolved_unit_price_pesewas, floor_unit_price_pesewas, ceiling_unit_price_pesewas, agreed_unit_price_pesewas,
                                           variance_pesewas, variance_direction, variance_reason_code, variance_requires_approval, discount_pesewas,
                                           estimated_line_total_pesewas, reservation_id, qty_fulfilled, fulfilled_weight_kg, weight_source,
                                           final_line_total_pesewas, stock_movement_id, line_status, variance_approval_request_id, variance_approved_by,
                                           variance_approved_at, estimated_weight_kg, tolerance_percent, quote_line_ref, stock_exception_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34)`,
        [
          l.id,
          l.salesOrderId,
          l.lineNo,
          l.productId,
          l.stockUnitId,
          l.qtyOrdered,
          l.uom,
          l.priceSource,
          l.priceBasis,
          l.priceListEntryId,
          l.resolvedUnitPricePesewas.toString(),
          l.floorUnitPricePesewas.toString(),
          l.ceilingUnitPricePesewas.toString(),
          l.agreedUnitPricePesewas.toString(),
          l.variancePesewas.toString(),
          l.varianceDirection,
          l.varianceReasonCode,
          l.varianceRequiresApproval,
          l.discountPesewas.toString(),
          l.estimatedLineTotalPesewas.toString(),
          l.reservationId,
          l.qtyFulfilled,
          l.fulfilledWeightKg,
          l.weightSource,
          l.finalLineTotalPesewas?.toString() ?? null,
          l.stockMovementId,
          l.lineStatus,
          l.varianceApprovalRequestId,
          l.varianceApprovedBy,
          l.varianceApprovedAt,
          l.estimatedWeightKg ?? null,
          l.tolerancePercent ?? null,
          l.quoteLineRef ?? null,
          l.stockExceptionId ?? null,
        ],
      );
    }
  }

  async insertTrackingToken(tx: Transaction, t: TrackingTokenRecord): Promise<void> {
    await tx.query('INSERT INTO ord.order_tracking_token (id, sales_order_id, token_hash, recorded_at, expires_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6)', [
      t.id,
      t.salesOrderId,
      t.tokenHash,
      t.recordedAt,
      t.expiresAt,
      t.actorId,
    ]);
  }

  async trackingToken(tx: Transaction, tokenHash: Buffer, at: Date): Promise<{ readonly salesOrderId: string; readonly tokenHash: Buffer } | null> {
    const { rows } = await tx.query<{ sales_order_id: string; token_hash: Buffer }>('SELECT sales_order_id, token_hash FROM ord.order_tracking_token WHERE token_hash = $1 AND expires_at > $2', [tokenHash, at]);
    return rows[0] === undefined ? null : { salesOrderId: rows[0].sales_order_id, tokenHash: rows[0].token_hash };
  }

  async recordStatus(tx: Transaction, orderId: string, c: Omit<StatusChangeRecord, 'recordedAt'>): Promise<void> {
    await tx.query('INSERT INTO ord.order_status_history (id, sales_order_id, from_status, to_status, reason, occurred_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      c.id,
      orderId,
      c.fromStatus,
      c.toStatus,
      c.reason,
      c.occurredAt,
      c.actorId,
    ]);
  }

  async complete(
    tx: Transaction,
    orderId: string,
    c: {
      readonly billingDocumentId: string;
      readonly finalTotalPesewas: bigint;
      readonly completedAt: Date;
      readonly actorId: string;
    },
  ): Promise<void> {
    await tx.query(
      `UPDATE ord.sales_order SET status = 'COMPLETED', billing_document_id = $2, final_total_pesewas = $3, completed_at = $4, posted_at = $4, posted_by = $5,
              updated_at = $4, updated_by = $5, version = version + 1
        WHERE id = $1`,
      [orderId, c.billingDocumentId, c.finalTotalPesewas.toString(), c.completedAt, c.actorId],
    );
  }

  async shiftSales(tx: Transaction, shiftDocumentId: string): Promise<ShiftSalesSummary> {
    const { rows } = await tx.query<{ sales: number; gross: string; voids: number; voided: string; overrides: number; given: string }>(
      `SELECT count(*) FILTER (WHERE o.status = 'COMPLETED')::int AS sales,
              COALESCE(sum(o.final_total_pesewas) FILTER (WHERE o.status = 'COMPLETED'), 0)::text AS gross,
              count(*) FILTER (WHERE o.status = 'VOIDED')::int AS voids,
              COALESCE(sum(o.final_total_pesewas) FILTER (WHERE o.status = 'VOIDED'), 0)::text AS voided,
              COALESCE(sum(v.lines), 0)::int AS overrides,
              COALESCE(sum(v.given), 0)::text AS given
         FROM ord.sales_order o
         LEFT JOIN LATERAL (
           SELECT count(*) AS lines, sum(l.variance_pesewas) AS given FROM ord.sales_order_line l
            WHERE l.sales_order_id = o.id AND l.variance_direction = 'BELOW' AND l.variance_pesewas > 0 AND o.status = 'COMPLETED'
         ) v ON true
        WHERE o.shift_document_id = $1`,
      [shiftDocumentId],
    );
    const r = rows[0]!;
    return { salesCount: r.sales, grossSalesPesewas: BigInt(r.gross), voidsCount: r.voids, voidsPesewas: BigInt(r.voided), overridesCount: r.overrides, overridesPesewas: BigInt(r.given) };
  }

  async orders(tx: Transaction, ids: readonly string[]): Promise<OrderRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT ${HEADER_COLUMNS} FROM ord.sales_order WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    );
    const { rows: lineRows } = await tx.query<Record<string, unknown>>(
      `SELECT id, sales_order_id, line_no, product_id, stock_unit_id, qty_ordered::text, uom, qty_fulfilled::text, fulfilled_weight_kg::text, weight_source,
              price_source, price_basis, price_list_entry_id, resolved_unit_price_pesewas::text, floor_unit_price_pesewas::text, ceiling_unit_price_pesewas::text,
              agreed_unit_price_pesewas::text, variance_pesewas::text, variance_direction, variance_reason_code, variance_requires_approval, discount_pesewas::text,
              estimated_line_total_pesewas::text, final_line_total_pesewas::text, reservation_id, stock_movement_id, stock_exception_id, line_status,
              estimated_weight_kg::text, tolerance_percent::text, qty_backordered::text, quote_line_ref, variance_approval_request_id,
              variance_approved_by, variance_approved_at
         FROM ord.sales_order_line WHERE sales_order_id = ANY($1::uuid[]) ORDER BY sales_order_id, line_no`,
      [ids],
    );
    const lines = new Map<string, OrderLineRecord[]>();
    for (const r of lineRows) {
      const line: OrderLineRecord = {
        id: r['id'] as string,
        salesOrderId: r['sales_order_id'] as string,
        lineNo: r['line_no'] as number,
        productId: r['product_id'] as string,
        stockUnitId: r['stock_unit_id'] as string | null,
        qtyOrdered: r['qty_ordered'] as string,
        uom: r['uom'] as string,
        qtyFulfilled: r['qty_fulfilled'] as string,
        fulfilledWeightKg: r['fulfilled_weight_kg'] as string | null,
        weightSource: r['weight_source'] as OrderLineRecord['weightSource'],
        priceSource: r['price_source'] as OrderLineRecord['priceSource'],
        priceBasis: r['price_basis'] as OrderLineRecord['priceBasis'],
        priceListEntryId: r['price_list_entry_id'] as string | null,
        resolvedUnitPricePesewas: BigInt(r['resolved_unit_price_pesewas'] as string),
        floorUnitPricePesewas: BigInt(r['floor_unit_price_pesewas'] as string),
        ceilingUnitPricePesewas: BigInt(r['ceiling_unit_price_pesewas'] as string),
        agreedUnitPricePesewas: BigInt(r['agreed_unit_price_pesewas'] as string),
        variancePesewas: BigInt(r['variance_pesewas'] as string),
        varianceDirection: r['variance_direction'] as OrderLineRecord['varianceDirection'],
        varianceReasonCode: r['variance_reason_code'] as string | null,
        varianceRequiresApproval: r['variance_requires_approval'] as boolean,
        discountPesewas: BigInt(r['discount_pesewas'] as string),
        estimatedLineTotalPesewas: BigInt(r['estimated_line_total_pesewas'] as string),
        finalLineTotalPesewas: big(r['final_line_total_pesewas'] as string | null),
        reservationId: r['reservation_id'] as string | null,
        stockMovementId: r['stock_movement_id'] as string | null,
        stockExceptionId: r['stock_exception_id'] as string | null,
        estimatedWeightKg: r['estimated_weight_kg'] as string | null,
        tolerancePercent: r['tolerance_percent'] as string | null,
        qtyBackordered: r['qty_backordered'] as string,
        quoteLineRef: r['quote_line_ref'] as string | null,
        varianceApprovalRequestId: r['variance_approval_request_id'] as string | null,
        varianceApprovedBy: r['variance_approved_by'] as string | null,
        varianceApprovedAt: r['variance_approved_at'] as Date | null,
        lineStatus: r['line_status'] as OrderLineRecord['lineStatus'],
      };
      lines.set(line.salesOrderId, [...(lines.get(line.salesOrderId) ?? []), line]);
    }
    return rows.map((r) => ({
      ...header(r),
      lines: lines.get(r['id'] as string) ?? [],
    }));
  }

  async lock(tx: Transaction, orderId: string): Promise<OrderHeaderRecord | null> {
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${HEADER_COLUMNS} FROM ord.sales_order WHERE id = $1 FOR UPDATE`, [orderId]);
    return rows[0] === undefined ? null : header(rows[0]);
  }

  async confirm(
    tx: Transaction,
    orderId: string,
    c: {
      readonly creditCheck: 'PASSED' | 'NOT_REQUIRED';
      readonly at: Date;
      readonly actorId: string;
    },
  ): Promise<void> {
    await tx.query("UPDATE ord.sales_order SET status = 'CONFIRMED', credit_check = $2, updated_at = $3, updated_by = $4, version = version + 1 WHERE id = $1", [orderId, c.creditCheck, c.at, c.actorId]);
  }

  async holdLine(tx: Transaction, lineId: string, reservationId: string): Promise<void> {
    await tx.query('UPDATE ord.sales_order_line SET reservation_id = $2 WHERE id = $1', [lineId, reservationId]);
  }

  async cancel(tx: Transaction, orderId: string, c: { readonly reasonCode: string; readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query("UPDATE ord.sales_order_line SET line_status = 'CANCELLED' WHERE sales_order_id = $1 AND line_status = 'OPEN'", [orderId]);
    await tx.query(
      `UPDATE ord.sales_order SET status = 'CANCELLED', cancel_reason_code = $2, posted_at = $3, posted_by = $4, updated_at = $3, updated_by = $4, version = version + 1
        WHERE id = $1`,
      [orderId, c.reasonCode, c.at, c.actorId],
    );
  }

  async markVoided(tx: Transaction, orderId: string, v: { readonly approvalRequestId: string; readonly voidedBy: string; readonly at: Date }): Promise<void> {
    await tx.query(
      `UPDATE ord.sales_order SET status = 'VOIDED', void_approval_request_id = $2, voided_by = $3, voided_at = $4, updated_at = $4, updated_by = $3, version = version + 1
        WHERE id = $1`,
      [orderId, v.approvalRequestId, v.voidedBy, v.at],
    );
  }

  async insertVoid(tx: Transaction, v: Omit<OrderVoidRecord, 'status' | 'creditNoteId' | 'decidedBy'>): Promise<void> {
    await tx.query(
      `INSERT INTO ord.order_void (id, sales_order_id, reason_code, note, status, approval_request_id, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'PENDING_APPROVAL', $5, $6, $7, $7)`,
      [v.id, v.salesOrderId, v.reasonCode, v.note, v.approvalRequestId, v.branchId, v.createdBy],
    );
  }

  async openVoidOf(tx: Transaction, orderId: string): Promise<OrderVoidRecord | null> {
    return this.voidWhere(tx, "sales_order_id = $1 AND status <> 'REJECTED'", orderId);
  }

  async voidByApproval(tx: Transaction, approvalRequestId: string): Promise<OrderVoidRecord | null> {
    return this.voidWhere(tx, 'approval_request_id = $1', approvalRequestId);
  }

  async decideVoid(tx: Transaction, id: string, d: { readonly status: 'APPROVED' | 'REJECTED'; readonly creditNoteId: string | null; readonly decidedBy: string; readonly at: Date }): Promise<void> {
    await tx.query('UPDATE ord.order_void SET status = $2, credit_note_id = $3, decided_by = $4, decided_at = $5, updated_at = $5, updated_by = $4, version = version + 1 WHERE id = $1', [id, d.status, d.creditNoteId, d.decidedBy, d.at]);
  }

  private async voidWhere(tx: Transaction, where: string, value: string): Promise<OrderVoidRecord | null> {
    const { rows } = await tx.query<OrderVoidRecord>(
      `SELECT id, sales_order_id AS "salesOrderId", reason_code AS "reasonCode", note, status, approval_request_id AS "approvalRequestId", credit_note_id AS "creditNoteId",
              decided_by AS "decidedBy", branch_id AS "branchId", created_by AS "createdBy"
         FROM ord.order_void WHERE ${where} FOR UPDATE`,
      [value],
    );
    return rows[0] ?? null;
  }

  async approveVariances(tx: Transaction, orderId: string, a: { readonly approvalRequestId: string; readonly approvedBy: string; readonly at: Date }): Promise<void> {
    await tx.query(
      `UPDATE ord.sales_order_line SET variance_approved_by = $3, variance_approved_at = $4
        WHERE sales_order_id = $1 AND variance_approval_request_id = $2 AND variance_approved_by IS NULL`,
      [orderId, a.approvalRequestId, a.approvedBy, a.at],
    );
  }

  async setProforma(tx: Transaction, orderId: string, p: { readonly documentId: string; readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query('UPDATE ord.sales_order SET proforma_document_id = $2, updated_at = $3, updated_by = $4, version = version + 1 WHERE id = $1', [orderId, p.documentId, p.at, p.actorId]);
  }

  async list(tx: Transaction, f: OrderFilter, beforeId: string | null, limit: number): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM ord.sales_order
        WHERE branch_id = ANY($1::uuid[])
          AND ($2::text IS NULL OR channel = $2) AND ($3::text IS NULL OR status = $3)
          AND ($4::uuid IS NULL OR customer_id = $4) AND ($5::uuid IS NULL OR shift_document_id = $5) AND ($6::uuid IS NULL OR salesperson_id = $6)
          AND ($7::timestamptz IS NULL OR placed_at >= $7) AND ($8::timestamptz IS NULL OR placed_at < $8)
          AND ($9::text IS NULL OR order_no ILIKE $9 || '%' OR contact_name ILIKE '%' || $9 || '%')
          AND ($10::uuid IS NULL OR id < $10)
        ORDER BY id DESC LIMIT $11`,
      [f.branchIds, f.channel, f.status, f.customerId, f.shiftId, f.salespersonId, f.from, f.to, f.q, beforeId, limit],
    );
    return rows.map((r) => r.id);
  }

  async ofCustomer(tx: Transaction, customerId: string, beforeId: string | null, limit: number): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      'SELECT id FROM ord.sales_order WHERE customer_id = $1 AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3',
      [customerId, beforeId, limit],
    );
    return rows.map((r) => r.id);
  }

  async lockOnlineBySource(tx: Transaction, sourceDocumentId: string): Promise<OrderHeaderRecord | null> {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM ord.sales_order WHERE source_document_id = $1 AND channel = 'ONLINE' ORDER BY id LIMIT 1", [sourceDocumentId]);
    return rows[0] === undefined ? null : this.lock(tx, rows[0].id);
  }

  async history(tx: Transaction, orderId: string): Promise<StatusChangeRecord[]> {
    const { rows } = await tx.query<{
      id: string;
      from_status: StatusChangeRecord['fromStatus'];
      to_status: StatusChangeRecord['toStatus'];
      reason: string | null;
      occurred_at: Date;
      recorded_at: Date;
      actor_id: string;
    }>('SELECT id, from_status, to_status, reason, occurred_at, recorded_at, actor_id FROM ord.order_status_history WHERE sales_order_id = $1 ORDER BY recorded_at, id', [orderId]);
    return rows.map((r) => ({
      id: r.id,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reason: r.reason,
      occurredAt: r.occurred_at,
      recordedAt: r.recorded_at,
      actorId: r.actor_id,
    }));
  }
}

const HEADER_COLUMNS = `id, order_no, channel, customer_id, contact_name, contact_phone_e164, status, payment_terms, fulfilment_mode, source_document_id, shift_document_id,
              salesperson_id, tax_inclusive, delivery_fee_pesewas::text, estimated_total_pesewas::text, maximum_total_pesewas::text, final_total_pesewas::text,
              billing_document_id, is_offline, placed_at, completed_at, recorded_at, notes, branch_id, version,
              parent_order_id, credit_check, delivery_address_snapshot, delivery_zone_id, created_by, proforma_document_id`;

function header(r: Record<string, unknown>): OrderHeaderRecord {
  return {
    id: r['id'] as string,
    orderNo: r['order_no'] as string | null,
    channel: r['channel'] as OrderRecord['channel'],
    customerId: r['customer_id'] as string | null,
    contactName: r['contact_name'] as string | null,
    contactPhone: r['contact_phone_e164'] as string | null,
    status: r['status'] as OrderRecord['status'],
    paymentTerms: r['payment_terms'] as OrderRecord['paymentTerms'],
    fulfilmentMode: r['fulfilment_mode'] as OrderRecord['fulfilmentMode'],
    sourceDocumentId: r['source_document_id'] as string | null,
    shiftDocumentId: r['shift_document_id'] as string | null,
    salespersonId: r['salesperson_id'] as string | null,
    taxInclusive: r['tax_inclusive'] as boolean,
    deliveryFeePesewas: BigInt(r['delivery_fee_pesewas'] as string),
    estimatedTotalPesewas: BigInt(r['estimated_total_pesewas'] as string),
    maximumTotalPesewas: BigInt(r['maximum_total_pesewas'] as string),
    finalTotalPesewas: big(r['final_total_pesewas'] as string | null),
    billingDocumentId: r['billing_document_id'] as string | null,
    isOffline: r['is_offline'] as boolean,
    placedAt: r['placed_at'] as Date,
    completedAt: r['completed_at'] as Date | null,
    recordedAt: r['recorded_at'] as Date,
    notes: r['notes'] as string | null,
    branchId: r['branch_id'] as string,
    version: r['version'] as number,
    parentOrderId: r['parent_order_id'] as string | null,
    creditCheck: r['credit_check'] as OrderHeaderRecord['creditCheck'],
    deliveryAddressSnapshot: r['delivery_address_snapshot'] ?? null,
    deliveryZoneId: r['delivery_zone_id'] as string | null,
    createdBy: r['created_by'] as string,
    proformaDocumentId: r['proforma_document_id'] as string | null,
  };
}
