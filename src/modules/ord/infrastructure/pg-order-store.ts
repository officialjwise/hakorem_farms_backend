import type { Transaction } from '../../../platform/database/unit-of-work';
import type { NewOrder, NewOrderLine, OrderLineRecord, OrderRecord, OrderStore, StatusChangeRecord } from '../application/order-store';

const big = (value: string | null): bigint | null => (value === null ? null : BigInt(value));

/** ORD's tables in PostgreSQL. Point reads by key only: a sale posts at serializable isolation (ADR-0005). */
export class PgOrderStore implements OrderStore {
  async insertOrder(tx: Transaction, o: NewOrder): Promise<void> {
    await tx.query(
      `INSERT INTO ord.sales_order (id, order_no, channel, customer_id, contact_name, contact_phone_e164, status, payment_terms, fulfilment_mode, source_document_id,
                                    shift_document_id, salesperson_id, tax_inclusive, delivery_fee_pesewas, estimated_total_pesewas, maximum_total_pesewas,
                                    is_offline, placed_at, notes, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'PLACED', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20)`,
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
                                           final_line_total_pesewas, stock_movement_id, line_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
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
        ],
      );
    }
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

  async complete(tx: Transaction, orderId: string, c: { readonly billingDocumentId: string; readonly finalTotalPesewas: bigint; readonly completedAt: Date; readonly actorId: string }): Promise<void> {
    await tx.query(
      `UPDATE ord.sales_order SET status = 'COMPLETED', billing_document_id = $2, final_total_pesewas = $3, completed_at = $4, posted_at = $4, posted_by = $5,
              updated_at = $4, updated_by = $5, version = version + 1
        WHERE id = $1`,
      [orderId, c.billingDocumentId, c.finalTotalPesewas.toString(), c.completedAt, c.actorId],
    );
  }

  async orders(tx: Transaction, ids: readonly string[]): Promise<OrderRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT id, order_no, channel, customer_id, contact_name, contact_phone_e164, status, payment_terms, fulfilment_mode, source_document_id, shift_document_id,
              salesperson_id, tax_inclusive, delivery_fee_pesewas::text, estimated_total_pesewas::text, maximum_total_pesewas::text, final_total_pesewas::text,
              billing_document_id, is_offline, placed_at, completed_at, recorded_at, notes, branch_id, version
         FROM ord.sales_order WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    );
    const { rows: lineRows } = await tx.query<Record<string, unknown>>(
      `SELECT id, sales_order_id, line_no, product_id, stock_unit_id, qty_ordered::text, uom, qty_fulfilled::text, fulfilled_weight_kg::text, weight_source,
              price_source, price_basis, price_list_entry_id, resolved_unit_price_pesewas::text, floor_unit_price_pesewas::text, ceiling_unit_price_pesewas::text,
              agreed_unit_price_pesewas::text, variance_pesewas::text, variance_direction, variance_reason_code, variance_requires_approval, discount_pesewas::text,
              estimated_line_total_pesewas::text, final_line_total_pesewas::text, reservation_id, stock_movement_id, stock_exception_id, line_status
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
        lineStatus: r['line_status'] as OrderLineRecord['lineStatus'],
      };
      lines.set(line.salesOrderId, [...(lines.get(line.salesOrderId) ?? []), line]);
    }
    return rows.map((r) => ({
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
      lines: lines.get(r['id'] as string) ?? [],
    }));
  }

  async history(tx: Transaction, orderId: string): Promise<StatusChangeRecord[]> {
    const { rows } = await tx.query<{ id: string; from_status: StatusChangeRecord['fromStatus']; to_status: StatusChangeRecord['toStatus']; reason: string | null; occurred_at: Date; recorded_at: Date; actor_id: string }>(
      'SELECT id, from_status, to_status, reason, occurred_at, recorded_at, actor_id FROM ord.order_status_history WHERE sales_order_id = $1 ORDER BY recorded_at, id',
      [orderId],
    );
    return rows.map((r) => ({ id: r.id, fromStatus: r.from_status, toStatus: r.to_status, reason: r.reason, occurredAt: r.occurred_at, recordedAt: r.recorded_at, actorId: r.actor_id }));
  }
}
