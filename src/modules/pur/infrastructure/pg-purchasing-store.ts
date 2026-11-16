import type { Transaction } from '../../../platform/database/unit-of-work';
import type { SubmittedOrder } from '../domain/order-splitting';
import type { OrderStatus } from '../domain/purchasing';
import type { MatchReason, MatchStatus } from '../domain/three-way-match';
import type {
  InvoiceFilter,
  InvoiceHeader,
  InvoiceLineRecord,
  InvoiceRecord,
  InvoiceStatus,
  LevyRecord,
  LineMatchRecord,
  OrderFilter,
  OrderHeader,
  OrderLineRecord,
  OrderRecord,
  PaymentFilter,
  PaymentHeader,
  PaymentMethod,
  PaymentRecord,
  PaymentStatus,
  PurchasingStore,
  ReadScope,
} from '../application/purchasing-store';

const big = (value: string | null): bigint | null => (value === null ? null : BigInt(value));

const ORDER_COLUMNS = `o.id, o.order_no, o.status, o.supplier_id, o.deliver_to_location_id, o.order_date::text AS order_date, o.expected_on::text AS expected_on,
  o.tax_inclusive, o.tax_scheme_version_id, o.net_pesewas::text AS net, o.tax_pesewas::text AS tax, o.gross_pesewas::text AS gross,
  o.approval_threshold_pesewas::text AS threshold, o.approval_request_id, o.sent_at, o.branch_id, o.version, o.created_at, o.created_by`;
const LINE_COLUMNS = `l.id, l.purchase_order_id, l.line_no, l.product_id, l.description, l.uom, l.qty_ordered::text AS qty_ordered, l.qty_ordered_base::text AS qty_ordered_base,
  l.unit_price_pesewas::text AS unit_price, l.line_net_pesewas::text AS line_net, l.tax_category_id, l.tax_pesewas::text AS tax,
  l.qty_received::text AS qty_received, l.over_receipt_tolerance_percent::text AS tolerance, l.expense_category`;

interface OrderRow {
  id: string;
  order_no: string | null;
  status: OrderStatus;
  supplier_id: string;
  deliver_to_location_id: string;
  order_date: string;
  expected_on: string | null;
  tax_inclusive: boolean;
  tax_scheme_version_id: string;
  net: string;
  tax: string;
  gross: string;
  threshold: string | null;
  approval_request_id: string | null;
  sent_at: Date | null;
  branch_id: string;
  version: number;
  created_at: Date;
  created_by: string;
}

interface LineRow {
  id: string;
  purchase_order_id: string;
  line_no: number;
  product_id: string;
  description: string | null;
  uom: string;
  qty_ordered: string;
  qty_ordered_base: string;
  unit_price: string;
  line_net: string;
  tax_category_id: string;
  tax: string;
  qty_received: string;
  tolerance: string;
  expense_category: string | null;
}

function orderLine(r: LineRow): OrderLineRecord & { purchaseOrderId: string } {
  return {
    id: r.id,
    purchaseOrderId: r.purchase_order_id,
    lineNo: r.line_no,
    productId: r.product_id,
    description: r.description,
    uom: r.uom,
    qtyOrdered: r.qty_ordered,
    qtyOrderedBase: r.qty_ordered_base,
    unitPricePesewas: BigInt(r.unit_price),
    lineNetPesewas: BigInt(r.line_net),
    taxCategoryId: r.tax_category_id,
    taxPesewas: BigInt(r.tax),
    qtyReceived: r.qty_received,
    tolerancePercent: r.tolerance,
    expenseCategory: r.expense_category,
  };
}

const INVOICE_COLUMNS = `i.id, i.kind, i.status, i.supplier_id, i.supplier_invoice_no, i.invoice_date::text AS invoice_date, i.due_date::text AS due_date,
  i.purchase_order_id, i.original_invoice_id, i.net_pesewas::text AS net, i.tax_pesewas::text AS tax, i.gross_pesewas::text AS gross,
  i.stated_gross_pesewas::text AS stated, i.paid_pesewas::text AS paid, i.match_status, i.file_id, i.tax_scheme_version_id, i.branch_id,
  i.version, i.created_at, i.created_by`;

interface InvoiceRow {
  id: string;
  kind: 'INVOICE' | 'CREDIT_NOTE';
  status: InvoiceStatus;
  supplier_id: string;
  supplier_invoice_no: string;
  invoice_date: string;
  due_date: string;
  purchase_order_id: string | null;
  original_invoice_id: string | null;
  net: string;
  tax: string;
  gross: string;
  stated: string | null;
  paid: string;
  match_status: MatchStatus;
  file_id: string | null;
  tax_scheme_version_id: string;
  branch_id: string;
  version: number;
  created_at: Date;
  created_by: string;
}

interface InvoiceLineRow {
  id: string;
  supplier_invoice_id: string;
  line_no: number;
  product_id: string | null;
  description: string;
  purchase_order_line_id: string | null;
  goods_receipt_line_id: string | null;
  uom: string | null;
  qty: string;
  qty_base: string | null;
  unit_price: string;
  line_net: string;
  tax_category_id: string;
  expense_category: string | null;
  qty_variance: string | null;
  price_variance: string | null;
  price_variance_direction: 'OVER' | 'UNDER' | null;
  match_status: MatchStatus;
  match_reasons: MatchReason[];
}

interface LevyRow {
  supplier_invoice_line_id: string;
  levy_id: string;
  levy_code: string;
  levy_name: string;
  treatment: string;
  rate_percent: string;
  base: string;
  amount: string;
  calculated: string;
  is_reclaimable: boolean;
  calc_order: number;
}

const PAYMENT_COLUMNS = `p.id, p.payment_no, p.status, p.supplier_id, p.method, p.amount_pesewas::text AS amount, p.scheduled_for::text AS scheduled_for,
  p.paid_at, p.external_reference, p.approval_request_id, p.branch_id, p.version, p.created_at, p.created_by, p.payout_change_id, p.payout_first_use, p.payout_first_use_change_id,
  (SELECT c.payout_masked FROM pur.supplier_payout_change c WHERE c.id = p.payout_change_id) AS payee_masked`;

interface PaymentRow {
  id: string;
  payment_no: string | null;
  status: PaymentStatus;
  supplier_id: string;
  method: PaymentMethod;
  amount: string;
  scheduled_for: string | null;
  paid_at: Date | null;
  external_reference: string | null;
  approval_request_id: string | null;
  branch_id: string;
  version: number;
  created_at: Date;
  created_by: string;
  payout_change_id: string | null;
  payout_first_use: boolean;
  payout_first_use_change_id: string | null;
  payee_masked: string | null;
}

/** `pur.*` (migration 0094), PUR's own tables, always in the caller's transaction. */
export class PgPurchasingStore implements PurchasingStore {
  // Purchase orders.

  async insertOrder(tx: Transaction, id: string, header: OrderHeader, lines: readonly OrderLineRecord[], actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO pur.purchase_order (id, supplier_id, deliver_to_location_id, order_date, expected_on, tax_inclusive, tax_scheme_version_id,
                                       net_pesewas, tax_pesewas, gross_pesewas, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'DRAFT', $11, $12, $12)`,
      [id, header.supplierId, header.deliverToLocationId, header.orderDate, header.expectedOn, header.taxInclusive, header.taxSchemeVersionId,
        header.netPesewas.toString(), header.taxPesewas.toString(), header.grossPesewas.toString(), header.branchId, actorId],
    );
    await this.insertOrderLines(tx, id, lines);
  }

  async replaceOrder(tx: Transaction, id: string, header: OrderHeader, lines: readonly OrderLineRecord[], actorId: string): Promise<void> {
    await tx.query('SELECT pur.clear_purchase_order_lines($1)', [id]);
    await tx.query(
      `UPDATE pur.purchase_order SET version = version + 1, expected_on = $2, tax_scheme_version_id = $3, net_pesewas = $4, tax_pesewas = $5, gross_pesewas = $6,
              updated_at = now(), updated_by = $7
        WHERE id = $1`,
      [id, header.expectedOn, header.taxSchemeVersionId, header.netPesewas.toString(), header.taxPesewas.toString(), header.grossPesewas.toString(), actorId],
    );
    await this.insertOrderLines(tx, id, lines);
  }

  private async insertOrderLines(tx: Transaction, orderId: string, lines: readonly OrderLineRecord[]): Promise<void> {
    for (const l of lines) {
      await tx.query(
        `INSERT INTO pur.purchase_order_line (id, purchase_order_id, line_no, product_id, description, uom, qty_ordered, qty_ordered_base, unit_price_pesewas,
                                              line_net_pesewas, tax_category_id, tax_pesewas, over_receipt_tolerance_percent, expense_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [l.id, orderId, l.lineNo, l.productId, l.description, l.uom, l.qtyOrdered, l.qtyOrderedBase, l.unitPricePesewas.toString(), l.lineNetPesewas.toString(),
          l.taxCategoryId, l.taxPesewas.toString(), l.tolerancePercent, l.expenseCategory],
      );
    }
  }

  async order(tx: Transaction, id: string): Promise<OrderRecord | null> {
    return (await this.ordersWhere(tx, 'o.id = $1', [id]))[0] ?? null;
  }

  async lockOrder(tx: Transaction, id: string): Promise<OrderRecord | null> {
    return (await this.ordersWhere(tx, 'o.id = $1', [id], ' FOR UPDATE OF o'))[0] ?? null;
  }

  orders(tx: Transaction, ids: readonly string[]): Promise<OrderRecord[]> {
    return this.ordersWhere(tx, 'o.id = ANY($1::uuid[])', [ids]);
  }

  listOrders(tx: Transaction, filter: OrderFilter, scopes: readonly ReadScope[], beforeId: string | null, limit: number): Promise<OrderRecord[]> {
    return this.ordersWhere(
      tx,
      `EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) AS s(branch_id, location_id)
                WHERE s.branch_id = o.branch_id AND (s.location_id IS NULL OR s.location_id = o.deliver_to_location_id))
         AND ($3::text IS NULL OR o.status = $3) AND ($4::uuid IS NULL OR o.supplier_id = $4)
         AND ($5::date IS NULL OR o.order_date >= $5) AND ($6::date IS NULL OR o.order_date <= $6) AND ($7::uuid IS NULL OR o.id < $7)`,
      [scopes.map((s) => s.branchId), scopes.map((s) => s.locationId), filter.status ?? null, filter.supplierId ?? null, filter.from ?? null, filter.to ?? null, beforeId, limit],
      ' ORDER BY o.id DESC LIMIT $8',
    );
  }

  private async ordersWhere(tx: Transaction, where: string, values: unknown[], tail = ''): Promise<OrderRecord[]> {
    const { rows } = await tx.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM pur.purchase_order o WHERE ${where}${tail}`, values);
    if (rows.length === 0) return [];
    const { rows: lineRows } = await tx.query<LineRow>(`SELECT ${LINE_COLUMNS} FROM pur.purchase_order_line l WHERE l.purchase_order_id = ANY($1::uuid[]) ORDER BY l.line_no`, [
      rows.map((r) => r.id),
    ]);
    return rows.map((r) => ({
      id: r.id,
      orderNo: r.order_no,
      status: r.status,
      supplierId: r.supplier_id,
      deliverToLocationId: r.deliver_to_location_id,
      orderDate: r.order_date,
      expectedOn: r.expected_on,
      taxInclusive: r.tax_inclusive,
      taxSchemeVersionId: r.tax_scheme_version_id,
      netPesewas: BigInt(r.net),
      taxPesewas: BigInt(r.tax),
      grossPesewas: BigInt(r.gross),
      approvalThresholdPesewas: big(r.threshold),
      approvalRequestId: r.approval_request_id,
      sentAt: r.sent_at,
      branchId: r.branch_id,
      version: r.version,
      createdAt: r.created_at,
      createdBy: r.created_by,
      lines: lineRows.filter((l) => l.purchase_order_id === r.id).map(orderLine),
    }));
  }

  async lockOrderLines(tx: Transaction, ids: readonly string[]): Promise<(OrderLineRecord & { readonly purchaseOrderId: string })[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<LineRow>(`SELECT ${LINE_COLUMNS} FROM pur.purchase_order_line l WHERE l.id = ANY($1::uuid[]) ORDER BY l.id FOR UPDATE`, [ids]);
    return rows.map(orderLine);
  }

  async setReceived(tx: Transaction, lineId: string, qtyReceived: string): Promise<void> {
    await tx.query('UPDATE pur.purchase_order_line SET qty_received = $2 WHERE id = $1', [lineId, qtyReceived]);
  }

  async markOrderJudged(
    tx: Transaction,
    id: string,
    judged: { readonly status: 'PENDING_APPROVAL' | 'APPROVED'; readonly thresholdPesewas: bigint; readonly approvalRequestId: string | null; readonly at: Date },
    actorId: string,
  ): Promise<void> {
    await tx.query(
      `UPDATE pur.purchase_order SET version = version + 1, status = $2, approval_threshold_pesewas = $3, approval_request_id = $4,
              posted_at = CASE WHEN $2 = 'APPROVED' THEN $5::timestamptz END, posted_by = CASE WHEN $2 = 'APPROVED' THEN $6::uuid END,
              updated_at = $5, updated_by = $6
        WHERE id = $1`,
      [id, judged.status, judged.thresholdPesewas.toString(), judged.approvalRequestId, judged.at, actorId],
    );
  }

  async markOrderDecided(tx: Transaction, id: string, status: 'APPROVED' | 'DRAFT', at: Date, actorId: string): Promise<void> {
    await tx.query(
      status === 'APPROVED'
        ? `UPDATE pur.purchase_order SET version = version + 1, status = 'APPROVED', posted_at = $2, posted_by = $3, updated_at = $2, updated_by = $3 WHERE id = $1`
        : `UPDATE pur.purchase_order SET version = version + 1, status = 'DRAFT', approval_threshold_pesewas = NULL, approval_request_id = NULL, updated_at = $2, updated_by = $3 WHERE id = $1`,
      [id, at, actorId],
    );
  }

  async markOrderSent(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    await tx.query(`UPDATE pur.purchase_order SET version = version + 1, status = 'SENT', sent_at = $2, sent_by = $3, updated_at = $2, updated_by = $3 WHERE id = $1`, [id, at, actorId]);
  }

  async markOrderReceived(tx: Transaction, id: string, status: 'PARTIALLY_RECEIVED' | 'RECEIVED', actorId: string): Promise<void> {
    await tx.query('UPDATE pur.purchase_order SET version = version + 1, status = $2, updated_at = now(), updated_by = $3 WHERE id = $1', [id, status, actorId]);
  }

  async markOrderEnded(tx: Transaction, id: string, status: 'CLOSED' | 'CANCELLED', reason: string, actorId: string): Promise<void> {
    await tx.query(
      status === 'CLOSED'
        ? `UPDATE pur.purchase_order SET version = version + 1, status = 'CLOSED', close_reason = $2, updated_at = now(), updated_by = $3 WHERE id = $1`
        : `UPDATE pur.purchase_order SET version = version + 1, status = 'CANCELLED', cancel_reason = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
      [id, reason, actorId],
    );
  }

  async invoicedQty(tx: Transaction, orderLineIds: readonly string[], exceptInvoiceId: string | null): Promise<ReadonlyMap<string, string>> {
    if (orderLineIds.length === 0) return new Map();
    const { rows } = await tx.query<{ line_id: string; qty: string }>(
      `SELECT l.purchase_order_line_id AS line_id, sum(l.qty_base)::text AS qty
         FROM pur.supplier_invoice_line l JOIN pur.supplier_invoice i ON i.id = l.supplier_invoice_id
        WHERE l.purchase_order_line_id = ANY($1::uuid[]) AND i.kind = 'INVOICE' AND i.status IN ('MATCHED', 'APPROVED', 'PAID')
          AND ($2::uuid IS NULL OR i.id <> $2)
        GROUP BY l.purchase_order_line_id`,
      [orderLineIds, exceptInvoiceId],
    );
    return new Map(rows.map((r) => [r.line_id, r.qty] as const));
  }

  // Supplier invoices.

  async insertInvoice(
    tx: Transaction,
    id: string,
    header: InvoiceHeader & { readonly kind: 'INVOICE'; readonly supplierId: string; readonly purchaseOrderId: string | null; readonly branchId: string },
    lines: readonly InvoiceLineRecord[],
    actorId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO pur.supplier_invoice (id, kind, supplier_id, supplier_invoice_no, invoice_date, due_date, purchase_order_id, net_pesewas, tax_pesewas,
                                         gross_pesewas, stated_gross_pesewas, file_id, tax_scheme_version_id, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'DRAFT', $14, $15, $15)`,
      [id, header.kind, header.supplierId, header.supplierInvoiceNo, header.invoiceDate, header.dueDate, header.purchaseOrderId, header.netPesewas.toString(),
        header.taxPesewas.toString(), header.grossPesewas.toString(), header.statedGrossPesewas?.toString() ?? null, header.fileId, header.taxSchemeVersionId,
        header.branchId, actorId],
    );
    await this.insertInvoiceLines(tx, id, lines);
  }

  async replaceInvoice(tx: Transaction, id: string, header: InvoiceHeader, lines: readonly InvoiceLineRecord[], actorId: string): Promise<void> {
    await tx.query(
      `UPDATE pur.supplier_invoice SET version = version + 1, status = 'DRAFT', match_status = 'UNMATCHED', matched_at = NULL WHERE id = $1 AND status <> 'DRAFT'`,
      [id],
    );
    await tx.query('SELECT pur.clear_supplier_invoice_lines($1)', [id]);
    await tx.query(
      `UPDATE pur.supplier_invoice SET version = version + 1, supplier_invoice_no = $2, invoice_date = $3, due_date = $4, file_id = $5, tax_scheme_version_id = $6,
              net_pesewas = $7, tax_pesewas = $8, gross_pesewas = $9, stated_gross_pesewas = $10, updated_at = now(), updated_by = $11
        WHERE id = $1`,
      [id, header.supplierInvoiceNo, header.invoiceDate, header.dueDate, header.fileId, header.taxSchemeVersionId, header.netPesewas.toString(),
        header.taxPesewas.toString(), header.grossPesewas.toString(), header.statedGrossPesewas?.toString() ?? null, actorId],
    );
    await this.insertInvoiceLines(tx, id, lines);
  }

  private async insertInvoiceLines(tx: Transaction, invoiceId: string, lines: readonly InvoiceLineRecord[]): Promise<void> {
    for (const l of lines) {
      await tx.query(
        `INSERT INTO pur.supplier_invoice_line (id, supplier_invoice_id, line_no, product_id, description, purchase_order_line_id, goods_receipt_line_id, uom,
                                                qty, qty_base, unit_price_pesewas, line_net_pesewas, tax_category_id, expense_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [l.id, invoiceId, l.lineNo, l.productId, l.description, l.purchaseOrderLineId, l.goodsReceiptLineId, l.uom, l.qty, l.qtyBase, l.unitPricePesewas.toString(),
          l.lineNetPesewas.toString(), l.taxCategoryId, l.expenseCategory],
      );
      for (const levy of l.levies) {
        await tx.query(
          `INSERT INTO pur.supplier_invoice_line_tax (supplier_invoice_line_id, levy_id, levy_code, levy_name, treatment, rate_percent, base_pesewas,
                                                      amount_pesewas, calculated_amount_pesewas, is_reclaimable, calc_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [l.id, levy.levyId, levy.levyCode, levy.levyName, levy.treatment, levy.ratePercent, levy.basePesewas.toString(), levy.amountPesewas.toString(),
            levy.calculatedAmountPesewas.toString(), levy.isReclaimable, levy.calcOrder],
        );
      }
    }
  }

  async invoice(tx: Transaction, id: string): Promise<InvoiceRecord | null> {
    return (await this.invoicesWhere(tx, 'i.id = $1', [id]))[0] ?? null;
  }

  async lockInvoice(tx: Transaction, id: string): Promise<InvoiceRecord | null> {
    return (await this.invoicesWhere(tx, 'i.id = $1', [id], ' FOR UPDATE OF i'))[0] ?? null;
  }

  invoices(tx: Transaction, ids: readonly string[]): Promise<InvoiceRecord[]> {
    return this.invoicesWhere(tx, 'i.id = ANY($1::uuid[])', [ids]);
  }

  listInvoices(tx: Transaction, filter: InvoiceFilter, branches: readonly string[], beforeId: string | null, limit: number): Promise<InvoiceRecord[]> {
    return this.invoicesWhere(
      tx,
      `i.branch_id = ANY($1::uuid[]) AND ($2::text IS NULL OR i.status = $2) AND ($3::uuid IS NULL OR i.supplier_id = $3)
         AND ($4::text IS NULL OR i.match_status = $4) AND ($5::date IS NULL OR i.due_date < $5)
         AND (NOT $6 OR (i.status IN ('DRAFT', 'MATCHED', 'MISMATCH', 'APPROVED') AND i.paid_pesewas < i.gross_pesewas)) AND ($7::uuid IS NULL OR i.id < $7)`,
      [branches, filter.status ?? null, filter.supplierId ?? null, filter.matchStatus ?? null, filter.dueBefore ?? null, filter.outstandingOnly, beforeId, limit],
      ' ORDER BY i.id DESC LIMIT $8',
    );
  }

  private async invoicesWhere(tx: Transaction, where: string, values: unknown[], tail = ''): Promise<InvoiceRecord[]> {
    const { rows } = await tx.query<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM pur.supplier_invoice i WHERE ${where}${tail}`, values);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const { rows: lineRows } = await tx.query<InvoiceLineRow>(
      `SELECT l.id, l.supplier_invoice_id, l.line_no, l.product_id, l.description, l.purchase_order_line_id, l.goods_receipt_line_id, l.uom,
              l.qty::text AS qty, l.qty_base::text AS qty_base, l.unit_price_pesewas::text AS unit_price, l.line_net_pesewas::text AS line_net,
              l.tax_category_id, l.expense_category, l.qty_variance::text AS qty_variance, l.price_variance_pesewas::text AS price_variance,
              l.price_variance_direction, l.match_status, l.match_reasons
         FROM pur.supplier_invoice_line l WHERE l.supplier_invoice_id = ANY($1::uuid[]) ORDER BY l.line_no`,
      [ids],
    );
    const { rows: levyRows } = await tx.query<LevyRow>(
      `SELECT t.supplier_invoice_line_id, t.levy_id, t.levy_code, t.levy_name, t.treatment, t.rate_percent::text AS rate_percent,
              t.base_pesewas::text AS base, t.amount_pesewas::text AS amount, t.calculated_amount_pesewas::text AS calculated, t.is_reclaimable, t.calc_order
         FROM pur.supplier_invoice_line_tax t JOIN pur.supplier_invoice_line l ON l.id = t.supplier_invoice_line_id
        WHERE l.supplier_invoice_id = ANY($1::uuid[]) ORDER BY t.calc_order`,
      [ids],
    );
    const levy = (r: LevyRow): LevyRecord => ({
      levyId: r.levy_id,
      levyCode: r.levy_code,
      levyName: r.levy_name,
      treatment: r.treatment,
      ratePercent: r.rate_percent,
      basePesewas: BigInt(r.base),
      amountPesewas: BigInt(r.amount),
      calculatedAmountPesewas: BigInt(r.calculated),
      isReclaimable: r.is_reclaimable,
      calcOrder: r.calc_order,
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      supplierId: r.supplier_id,
      supplierInvoiceNo: r.supplier_invoice_no,
      invoiceDate: r.invoice_date,
      dueDate: r.due_date,
      purchaseOrderId: r.purchase_order_id,
      originalInvoiceId: r.original_invoice_id,
      netPesewas: BigInt(r.net),
      taxPesewas: BigInt(r.tax),
      grossPesewas: BigInt(r.gross),
      statedGrossPesewas: big(r.stated),
      paidPesewas: BigInt(r.paid),
      matchStatus: r.match_status,
      fileId: r.file_id,
      taxSchemeVersionId: r.tax_scheme_version_id,
      branchId: r.branch_id,
      version: r.version,
      createdAt: r.created_at,
      createdBy: r.created_by,
      lines: lineRows
        .filter((l) => l.supplier_invoice_id === r.id)
        .map((l) => ({
          id: l.id,
          lineNo: l.line_no,
          productId: l.product_id,
          description: l.description,
          purchaseOrderLineId: l.purchase_order_line_id,
          goodsReceiptLineId: l.goods_receipt_line_id,
          uom: l.uom,
          qty: l.qty,
          qtyBase: l.qty_base,
          unitPricePesewas: BigInt(l.unit_price),
          lineNetPesewas: BigInt(l.line_net),
          taxCategoryId: l.tax_category_id,
          expenseCategory: l.expense_category,
          qtyVariance: l.qty_variance,
          priceVariancePesewas: big(l.price_variance),
          priceVarianceDirection: l.price_variance_direction,
          matchStatus: l.match_status,
          matchReasons: l.match_reasons,
          levies: levyRows.filter((t) => t.supplier_invoice_line_id === l.id).map(levy),
        })),
    }));
  }

  async supplierInvoiceNoTaken(tx: Transaction, supplierId: string, supplierInvoiceNo: string, exceptId: string | null): Promise<boolean> {
    const { rows } = await tx.query(
      `SELECT 1 FROM pur.supplier_invoice WHERE supplier_id = $1 AND supplier_invoice_no = $2 AND status <> 'CANCELLED' AND ($3::uuid IS NULL OR id <> $3)`,
      [supplierId, supplierInvoiceNo, exceptId],
    );
    return rows.length > 0;
  }

  async recordMatch(tx: Transaction, id: string, lines: readonly LineMatchRecord[], matchStatus: Exclude<MatchStatus, 'UNMATCHED'>, at: Date, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE pur.supplier_invoice SET version = version + 1, status = $2, match_status = $3, matched_at = $4, updated_at = $4, updated_by = $5 WHERE id = $1`,
      [id, matchStatus === 'MISMATCH' ? 'MISMATCH' : 'MATCHED', matchStatus, at, actorId],
    );
    for (const l of lines) {
      await tx.query(
        `UPDATE pur.supplier_invoice_line SET match_status = $2, match_reasons = $3, qty_variance = $4, price_variance_pesewas = $5, price_variance_direction = $6
          WHERE id = $1`,
        [l.lineId, l.matchStatus, [...l.reasons], l.qtyVariance, l.priceVariancePesewas?.toString() ?? null, l.priceVarianceDirection],
      );
    }
  }

  async markInvoiceApproved(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    await tx.query(`UPDATE pur.supplier_invoice SET version = version + 1, status = 'APPROVED', posted_at = $2, posted_by = $3, updated_at = $2, updated_by = $3 WHERE id = $1`, [id, at, actorId]);
  }

  async markInvoiceCancelled(tx: Transaction, id: string, reason: string, actorId: string): Promise<void> {
    await tx.query(`UPDATE pur.supplier_invoice SET version = version + 1, status = 'CANCELLED', cancel_reason = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [id, reason, actorId]);
  }

  async promised(tx: Transaction, invoiceIds: readonly string[]): Promise<ReadonlyMap<string, bigint>> {
    if (invoiceIds.length === 0) return new Map();
    const { rows } = await tx.query<{ invoice_id: string; amount: string }>(
      `SELECT a.supplier_invoice_id AS invoice_id, sum(a.amount_pesewas)::text AS amount
         FROM pur.supplier_payment_allocation a JOIN pur.supplier_payment p ON p.id = a.supplier_payment_id
        WHERE a.supplier_invoice_id = ANY($1::uuid[]) AND p.status NOT IN ('REJECTED', 'CANCELLED')
        GROUP BY a.supplier_invoice_id`,
      [invoiceIds],
    );
    return new Map(rows.map((r) => [r.invoice_id, BigInt(r.amount)] as const));
  }

  // Supplier payments.

  async submittedOrders(tx: Transaction, from: Date, to: Date): Promise<SubmittedOrder[]> {
    const { rows } = await tx.query<{ id: string; supplier_id: string; created_by: string; submitted_at: Date; gross: string; threshold: string }>(
      `SELECT id, supplier_id, created_by, COALESCE(posted_at, updated_at) AS submitted_at, gross_pesewas::text AS gross, approval_threshold_pesewas::text AS threshold
         FROM pur.purchase_order
        WHERE approval_threshold_pesewas IS NOT NULL AND COALESCE(posted_at, updated_at) BETWEEN $1 AND $2
        ORDER BY id`,
      [from, to],
    );
    // The order keeps the threshold it was judged by, the limit plus one pesewa (orderLimitJudgement).
    return rows.map((r) => ({ id: r.id, supplierId: r.supplier_id, makerId: r.created_by, submittedAt: r.submitted_at, grossPesewas: BigInt(r.gross), limitPesewas: BigInt(r.threshold) - 1n }));
  }

  async insertPayment(
    tx: Transaction,
    id: string,
    header: PaymentHeader,
    allocations: readonly { readonly id: string; readonly supplierInvoiceId: string; readonly amountPesewas: bigint }[],
    actorId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO pur.supplier_payment (id, supplier_id, method, amount_pesewas, scheduled_for, status, branch_id, payout_change_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, $8, $8)`,
      [id, header.supplierId, header.method, header.amountPesewas.toString(), header.scheduledFor, header.branchId, header.payoutChangeId, actorId],
    );
    for (const a of allocations) {
      await tx.query(
        `INSERT INTO pur.supplier_payment_allocation (id, supplier_payment_id, supplier_invoice_id, amount_pesewas, actor_id) VALUES ($1, $2, $3, $4, $5)`,
        [a.id, id, a.supplierInvoiceId, a.amountPesewas.toString(), actorId],
      );
    }
  }

  async payment(tx: Transaction, id: string): Promise<PaymentRecord | null> {
    return (await this.paymentsWhere(tx, 'p.id = $1', [id]))[0] ?? null;
  }

  async lockPayment(tx: Transaction, id: string): Promise<PaymentRecord | null> {
    return (await this.paymentsWhere(tx, 'p.id = $1', [id], ' FOR UPDATE OF p'))[0] ?? null;
  }

  listPayments(tx: Transaction, filter: PaymentFilter, branches: readonly string[], beforeId: string | null, limit: number): Promise<PaymentRecord[]> {
    return this.paymentsWhere(
      tx,
      `p.branch_id = ANY($1::uuid[]) AND ($2::text IS NULL OR p.status = $2) AND ($3::uuid IS NULL OR p.supplier_id = $3)
         AND ($4::date IS NULL OR p.scheduled_for < $4) AND ($5::uuid IS NULL OR p.id < $5)`,
      [branches, filter.status ?? null, filter.supplierId ?? null, filter.scheduledBefore ?? null, beforeId, limit],
      ' ORDER BY p.id DESC LIMIT $6',
    );
  }

  private async paymentsWhere(tx: Transaction, where: string, values: unknown[], tail = ''): Promise<PaymentRecord[]> {
    const { rows } = await tx.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM pur.supplier_payment p WHERE ${where}${tail}`, values);
    if (rows.length === 0) return [];
    const { rows: allocations } = await tx.query<{ supplier_payment_id: string; supplier_invoice_id: string; supplier_invoice_no: string; amount: string }>(
      `SELECT a.supplier_payment_id, a.supplier_invoice_id, i.supplier_invoice_no, a.amount_pesewas::text AS amount
         FROM pur.supplier_payment_allocation a JOIN pur.supplier_invoice i ON i.id = a.supplier_invoice_id
        WHERE a.supplier_payment_id = ANY($1::uuid[]) ORDER BY a.id`,
      [rows.map((r) => r.id)],
    );
    return rows.map((r) => ({
      id: r.id,
      paymentNo: r.payment_no,
      status: r.status,
      supplierId: r.supplier_id,
      method: r.method,
      amountPesewas: BigInt(r.amount),
      scheduledFor: r.scheduled_for,
      paidAt: r.paid_at,
      externalReference: r.external_reference,
      approvalRequestId: r.approval_request_id,
      branchId: r.branch_id,
      version: r.version,
      createdAt: r.created_at,
      createdBy: r.created_by,
      payoutChangeId: r.payout_change_id,
      payoutFirstUse: r.payout_first_use,
      payoutFirstUseChangeId: r.payout_first_use_change_id,
      payeeMasked: r.payee_masked,
      allocations: allocations
        .filter((a) => a.supplier_payment_id === r.id)
        .map((a) => ({ supplierInvoiceId: a.supplier_invoice_id, supplierInvoiceNo: a.supplier_invoice_no, amountPesewas: BigInt(a.amount) })),
    }));
  }

  async markPaymentPending(tx: Transaction, id: string, approvalRequestId: string, actorId: string): Promise<void> {
    await tx.query(`UPDATE pur.supplier_payment SET version = version + 1, status = 'PENDING_APPROVAL', approval_request_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [
      id,
      approvalRequestId,
      actorId,
    ]);
  }

  async markPaymentDecided(tx: Transaction, id: string, status: 'APPROVED' | 'REJECTED' | 'CANCELLED', reason: string | null, actorId: string): Promise<void> {
    await tx.query(`UPDATE pur.supplier_payment SET version = version + 1, status = $2, cancel_reason = $3, updated_at = now(), updated_by = $4 WHERE id = $1`, [id, status, reason, actorId]);
  }

  async markPaymentPaid(tx: Transaction, id: string, paidAt: Date, externalReference: string, at: Date, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE pur.supplier_payment SET version = version + 1, status = 'PAID', paid_at = $2, external_reference = $3, posted_at = $4, posted_by = $5, updated_at = $4, updated_by = $5
        WHERE id = $1`,
      [id, paidAt, externalReference, at, actorId],
    );
  }
}
