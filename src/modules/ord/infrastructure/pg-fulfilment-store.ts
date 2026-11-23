import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  ConsentMethod,
  FulfilmentFilter,
  FulfilmentHeaderRecord,
  FulfilmentRecord,
  FulfilmentStatus,
  FulfilmentStore,
  LinePicked,
  NewConsent,
  OrderConsentRecord,
  PickListLineRecord,
  PickRecord,
} from '../application/fulfilment-store';
import type { OrderStatus } from '../domain/order';

type Row = Record<string, unknown>;
const big = (value: unknown): bigint | null => (value === null ? null : BigInt(value as string));

const HEADER = `id, fulfilment_no, sales_order_id, pick_location_id, status, picker_id, picked_at, packed_at, dispatched_at, package_count,
                cancel_reason, branch_id, version, created_by`;
const pickColumns = (a: string) => `${a}id, ${a}fulfilment_id, ${a}pick_list_line_id, ${a}sales_order_line_id, ${a}stock_unit_id, ${a}pack_barcode,
  ${a}qty::text AS qty, ${a}qty_base::text AS qty_base, ${a}weight_kg::text AS weight_kg, ${a}weight_source, ${a}withdrawn_at, ${a}recorded_at, ${a}created_by`;
const PICK = pickColumns('');
const CONSENT = `id, sales_order_id, sales_order_line_id, kind, status, proposed_product_id, proposed_stock_unit_id, proposed_qty::text AS proposed_qty,
                 proposed_uom, price_list_entry_id, price_basis, resolved_unit_price_pesewas::text AS resolved, floor_unit_price_pesewas::text AS floor,
                 ceiling_unit_price_pesewas::text AS ceiling, proposed_line_total_pesewas::text AS proposed_total, weighed_weight_kg::text AS weighed_kg,
                 weighed_total_pesewas::text AS weighed_total, note, asked_at, answered_by, answered_at, method, answer_note, substitute_line_id, branch_id, created_by`;

function header(r: Row): FulfilmentHeaderRecord {
  return {
    id: r['id'] as string,
    fulfilmentNo: r['fulfilment_no'] as string,
    salesOrderId: r['sales_order_id'] as string,
    pickLocationId: r['pick_location_id'] as string,
    status: r['status'] as FulfilmentStatus,
    pickerId: r['picker_id'] as string | null,
    pickedAt: r['picked_at'] as Date | null,
    packedAt: r['packed_at'] as Date | null,
    dispatchedAt: r['dispatched_at'] as Date | null,
    packageCount: r['package_count'] as number | null,
    cancelReason: r['cancel_reason'] as string | null,
    branchId: r['branch_id'] as string,
    version: r['version'] as number,
    createdBy: r['created_by'] as string,
  };
}

function pick(r: Row): PickRecord {
  return {
    id: r['id'] as string,
    fulfilmentId: r['fulfilment_id'] as string,
    pickListLineId: r['pick_list_line_id'] as string,
    salesOrderLineId: r['sales_order_line_id'] as string,
    stockUnitId: r['stock_unit_id'] as string | null,
    packBarcode: r['pack_barcode'] as string | null,
    qty: r['qty'] as string,
    qtyBase: r['qty_base'] as string,
    weightKg: r['weight_kg'] as string | null,
    weightSource: r['weight_source'] as PickRecord['weightSource'],
    withdrawnAt: r['withdrawn_at'] as Date | null,
    recordedAt: r['recorded_at'] as Date,
    createdBy: r['created_by'] as string,
  };
}

function consent(r: Row): OrderConsentRecord {
  return {
    id: r['id'] as string,
    salesOrderId: r['sales_order_id'] as string,
    salesOrderLineId: r['sales_order_line_id'] as string,
    kind: r['kind'] as OrderConsentRecord['kind'],
    status: r['status'] as OrderConsentRecord['status'],
    proposedProductId: r['proposed_product_id'] as string | null,
    proposedStockUnitId: r['proposed_stock_unit_id'] as string | null,
    proposedQty: r['proposed_qty'] as string | null,
    proposedUom: r['proposed_uom'] as string | null,
    priceListEntryId: r['price_list_entry_id'] as string | null,
    priceBasis: r['price_basis'] as OrderConsentRecord['priceBasis'],
    resolvedUnitPricePesewas: big(r['resolved']),
    floorUnitPricePesewas: big(r['floor']),
    ceilingUnitPricePesewas: big(r['ceiling']),
    proposedLineTotalPesewas: big(r['proposed_total']),
    weighedWeightKg: r['weighed_kg'] as string | null,
    weighedTotalPesewas: big(r['weighed_total']),
    note: r['note'] as string | null,
    askedAt: r['asked_at'] as Date,
    answeredBy: r['answered_by'] as string | null,
    answeredAt: r['answered_at'] as Date | null,
    method: r['method'] as ConsentMethod | null,
    answerNote: r['answer_note'] as string | null,
    substituteLineId: r['substitute_line_id'] as string | null,
    branchId: r['branch_id'] as string,
    createdBy: r['created_by'] as string,
  };
}

export class PgFulfilmentStore implements FulfilmentStore {
  async insertFulfilment(tx: Transaction, f: Parameters<FulfilmentStore['insertFulfilment']>[1]): Promise<void> {
    await tx.query(
      `INSERT INTO ord.fulfilment (id, fulfilment_no, sales_order_id, pick_location_id, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'PICK_LIST', $5, $6, $6)`,
      [f.id, f.fulfilmentNo, f.salesOrderId, f.pickLocationId, f.branchId, f.createdBy],
    );
  }

  async insertPickListLines(tx: Transaction, lines: readonly PickListLineRecord[], actorId: string): Promise<void> {
    for (const l of lines) {
      await tx.query(
        `INSERT INTO ord.pick_list_line (id, fulfilment_id, sales_order_line_id, line_no, qty_to_pick, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [l.id, l.fulfilmentId, l.salesOrderLineId, l.lineNo, l.qtyToPick, l.status, actorId],
      );
    }
  }

  async fulfilments(tx: Transaction, ids: readonly string[]): Promise<FulfilmentRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<Row>(`SELECT ${HEADER} FROM ord.fulfilment WHERE id = ANY($1::uuid[])`, [ids]);
    const { rows: lines } = await tx.query<Row>(
      'SELECT id, fulfilment_id, sales_order_line_id, line_no, qty_to_pick::text AS qty_to_pick, status FROM ord.pick_list_line WHERE fulfilment_id = ANY($1::uuid[]) ORDER BY line_no',
      [ids],
    );
    const { rows: picks } = await tx.query<Row>(`SELECT ${PICK} FROM ord.fulfilment_line WHERE fulfilment_id = ANY($1::uuid[]) ORDER BY fulfilment_id, line_no`, [ids]);
    const byId = new Map(rows.map((r) => [r['id'] as string, header(r)]));
    return ids.flatMap((id) => {
      const h = byId.get(id);
      if (h === undefined) return [];
      return [
        {
          ...h,
          pickList: lines
            .filter((l) => l['fulfilment_id'] === id)
            .map((l) => ({
              id: l['id'] as string,
              fulfilmentId: id,
              salesOrderLineId: l['sales_order_line_id'] as string,
              lineNo: l['line_no'] as number,
              qtyToPick: l['qty_to_pick'] as string,
              status: l['status'] as PickListLineRecord['status'],
            })),
          picks: picks.filter((p) => p['fulfilment_id'] === id).map(pick),
        },
      ];
    });
  }

  async lock(tx: Transaction, id: string): Promise<FulfilmentHeaderRecord | null> {
    const { rows } = await tx.query<Row>(`SELECT ${HEADER} FROM ord.fulfilment WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] === undefined ? null : header(rows[0]);
  }

  async ofOrders(tx: Transaction, orderIds: readonly string[]): Promise<Array<{ id: string; salesOrderId: string; fulfilmentNo: string; status: FulfilmentStatus }>> {
    if (orderIds.length === 0) return [];
    const { rows } = await tx.query<Row>('SELECT id, sales_order_id, fulfilment_no, status FROM ord.fulfilment WHERE sales_order_id = ANY($1::uuid[]) ORDER BY id', [orderIds]);
    return rows.map((r) => ({ id: r['id'] as string, salesOrderId: r['sales_order_id'] as string, fulfilmentNo: r['fulfilment_no'] as string, status: r['status'] as FulfilmentStatus }));
  }

  async list(tx: Transaction, f: FulfilmentFilter, beforeId: string | null, limit: number): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM ord.fulfilment
        WHERE branch_id = ANY($1::uuid[])
          AND ($2::uuid IS NULL OR sales_order_id = $2) AND ($3::text IS NULL OR status = $3) AND ($4::uuid IS NULL OR pick_location_id = $4)
          AND ($5::timestamptz IS NULL OR created_at >= $5) AND ($6::timestamptz IS NULL OR created_at < $6)
          AND ($7::uuid IS NULL OR id < $7)
        ORDER BY id DESC LIMIT $8`,
      [f.branchIds, f.orderId, f.status, f.pickLocationId, f.from, f.to, beforeId, limit],
    );
    return rows.map((r) => r.id);
  }

  async startPicking(tx: Transaction, id: string, s: { readonly pickerId: string; readonly at: Date }): Promise<void> {
    await tx.query("UPDATE ord.fulfilment SET status = 'PICKING', picker_id = $2, picked_at = $3, updated_by = $2, version = version + 1 WHERE id = $1", [id, s.pickerId, s.at]);
  }

  async pack(tx: Transaction, id: string, p: { readonly packageCount: number; readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query("UPDATE ord.fulfilment SET status = 'PACKED', package_count = $2, packed_at = $3, updated_by = $4, version = version + 1 WHERE id = $1", [id, p.packageCount, p.at, p.actorId]);
  }

  async cancel(tx: Transaction, id: string, c: { readonly reason: string; readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query("UPDATE ord.fulfilment SET status = 'CANCELLED', cancel_reason = $2, cancelled_at = $3, cancelled_by = $4, updated_by = $4, version = version + 1 WHERE id = $1", [
      id,
      c.reason,
      c.at,
      c.actorId,
    ]);
  }

  async cancelPickListLines(tx: Transaction, ids: readonly string[], at: Date, actorId: string): Promise<void> {
    if (ids.length === 0) return;
    await tx.query("UPDATE ord.pick_list_line SET status = 'CANCELLED', updated_at = $2, updated_by = $3 WHERE id = ANY($1::uuid[]) AND status = 'OPEN'", [ids, at, actorId]);
  }

  async picksById(tx: Transaction, ids: readonly string[]): Promise<PickRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<Row>(`SELECT ${PICK} FROM ord.fulfilment_line WHERE id = ANY($1::uuid[])`, [ids]);
    return rows.map(pick);
  }

  /** Each pick numbered after the pick list's last, in the order given (the caller holds the pick list's lock). */
  async insertPicks(tx: Transaction, picks: readonly PickRecord[]): Promise<void> {
    for (const p of picks) {
      await tx.query(
        `INSERT INTO ord.fulfilment_line (id, fulfilment_id, pick_list_line_id, sales_order_line_id, stock_unit_id, pack_barcode, qty, qty_base, weight_kg, weight_source,
                                          recorded_at, created_by, updated_by, line_no)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12,
                 (SELECT COALESCE(max(n.line_no), 0) + 1 FROM ord.fulfilment_line n WHERE n.fulfilment_id = $2))`,
        [p.id, p.fulfilmentId, p.pickListLineId, p.salesOrderLineId, p.stockUnitId, p.packBarcode, p.qty, p.qtyBase, p.weightKg, p.weightSource, p.recordedAt, p.createdBy],
      );
    }
  }

  async withdrawPicks(tx: Transaction, ids: readonly string[], at: Date, actorId: string): Promise<void> {
    if (ids.length === 0) return;
    await tx.query('UPDATE ord.fulfilment_line SET withdrawn_at = $2, withdrawn_by = $3, updated_at = $2, updated_by = $3 WHERE id = ANY($1::uuid[]) AND withdrawn_at IS NULL', [ids, at, actorId]);
  }

  async activePicksOfOrder(tx: Transaction, orderId: string): Promise<PickRecord[]> {
    const { rows } = await tx.query<Row>(
      `SELECT ${pickColumns('l.')}
         FROM ord.fulfilment_line l JOIN ord.fulfilment f ON f.id = l.fulfilment_id
        WHERE f.sales_order_id = $1 AND f.status <> 'CANCELLED' AND l.withdrawn_at IS NULL
        ORDER BY l.fulfilment_id, l.line_no`,
      [orderId],
    );
    return rows.map(pick);
  }

  async askedOf(tx: Transaction, orderLineIds: readonly string[]): Promise<Map<string, string>> {
    if (orderLineIds.length === 0) return new Map();
    const { rows } = await tx.query<{ line: string; qty: string }>(
      `SELECT p.sales_order_line_id AS line, sum(p.qty_to_pick)::text AS qty
         FROM ord.pick_list_line p JOIN ord.fulfilment f ON f.id = p.fulfilment_id
        WHERE p.sales_order_line_id = ANY($1::uuid[]) AND p.status = 'OPEN' AND f.status <> 'CANCELLED'
        GROUP BY p.sales_order_line_id`,
      [orderLineIds],
    );
    return new Map(rows.map((r) => [r.line, r.qty]));
  }

  async setLinePicked(tx: Transaction, lineId: string, p: LinePicked): Promise<void> {
    await tx.query('UPDATE ord.sales_order_line SET qty_fulfilled = $2, fulfilled_weight_kg = $3, weight_source = $4, final_line_total_pesewas = $5 WHERE id = $1', [
      lineId,
      p.qtyPicked,
      p.weightKg,
      p.weightSource,
      p.finalLineTotalPesewas?.toString() ?? null,
    ]);
  }

  async setLineStatus(tx: Transaction, lineId: string, status: 'CANCELLED' | 'SUBSTITUTED'): Promise<void> {
    await tx.query('UPDATE ord.sales_order_line SET line_status = $2 WHERE id = $1', [lineId, status]);
  }

  async setSubstitutedFor(tx: Transaction, lineId: string, originalLineId: string): Promise<void> {
    await tx.query('UPDATE ord.sales_order_line SET substituted_for_line_id = $2 WHERE id = $1 AND substituted_for_line_id IS NULL', [lineId, originalLineId]);
  }

  async cancelOpenOfOrder(tx: Transaction, orderId: string, c: { readonly reason: string; readonly at: Date; readonly actorId: string }): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM ord.fulfilment WHERE sales_order_id = $1 AND status IN ('PICK_LIST', 'PICKING') ORDER BY id FOR UPDATE", [orderId]);
    for (const { id } of rows) {
      await tx.query('UPDATE ord.fulfilment_line SET withdrawn_at = $2, withdrawn_by = $3, updated_at = $2, updated_by = $3 WHERE fulfilment_id = $1 AND withdrawn_at IS NULL', [id, c.at, c.actorId]);
      await this.cancel(tx, id, c);
    }
    return rows.map((r) => r.id);
  }

  async moveOrder(tx: Transaction, orderId: string, to: OrderStatus, at: Date, actorId: string): Promise<void> {
    await tx.query('UPDATE ord.sales_order SET status = $2, updated_at = $3, updated_by = $4, version = version + 1 WHERE id = $1', [orderId, to, at, actorId]);
  }

  async insertConsent(tx: Transaction, c: NewConsent): Promise<void> {
    await tx.query(
      `INSERT INTO ord.order_consent (id, sales_order_id, sales_order_line_id, kind, status, proposed_product_id, proposed_stock_unit_id, proposed_qty, proposed_uom,
                                      price_list_entry_id, price_basis, resolved_unit_price_pesewas, floor_unit_price_pesewas, ceiling_unit_price_pesewas,
                                      proposed_line_total_pesewas, weighed_weight_kg, weighed_total_pesewas, note, asked_at, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20)`,
      [
        c.id,
        c.salesOrderId,
        c.salesOrderLineId,
        c.kind,
        c.proposedProductId,
        c.proposedStockUnitId,
        c.proposedQty,
        c.proposedUom,
        c.priceListEntryId,
        c.priceBasis,
        c.resolvedUnitPricePesewas?.toString() ?? null,
        c.floorUnitPricePesewas?.toString() ?? null,
        c.ceilingUnitPricePesewas?.toString() ?? null,
        c.proposedLineTotalPesewas?.toString() ?? null,
        c.weighedWeightKg,
        c.weighedTotalPesewas?.toString() ?? null,
        c.note,
        c.askedAt,
        c.branchId,
        c.createdBy,
      ],
    );
  }

  async pendingConsent(tx: Transaction, orderId: string): Promise<OrderConsentRecord | null> {
    const { rows } = await tx.query<Row>(`SELECT ${CONSENT} FROM ord.order_consent WHERE sales_order_id = $1 AND status = 'PENDING' FOR UPDATE`, [orderId]);
    return rows[0] === undefined ? null : consent(rows[0]);
  }

  async consentsOf(tx: Transaction, orderIds: readonly string[]): Promise<OrderConsentRecord[]> {
    if (orderIds.length === 0) return [];
    const { rows } = await tx.query<Row>(`SELECT ${CONSENT} FROM ord.order_consent WHERE sales_order_id = ANY($1::uuid[]) ORDER BY asked_at, id`, [orderIds]);
    return rows.map(consent);
  }

  async answerConsent(tx: Transaction, id: string, a: { readonly status: 'ACCEPTED' | 'REFUSED' | 'WITHDRAWN'; readonly answeredBy: string; readonly at: Date; readonly method: ConsentMethod; readonly note: string | null }): Promise<void> {
    await tx.query(
      'UPDATE ord.order_consent SET status = $2, answered_by = $3, answered_at = $4, method = $5, answer_note = $6, updated_by = $3, version = version + 1 WHERE id = $1',
      [id, a.status, a.answeredBy, a.at, a.method, a.note],
    );
  }

  async setSubstituteLine(tx: Transaction, consentId: string, lineId: string, _at: Date, actorId: string): Promise<void> {
    await tx.query('UPDATE ord.order_consent SET substitute_line_id = $2, updated_by = $3, version = version + 1 WHERE id = $1', [consentId, lineId, actorId]);
  }
}
