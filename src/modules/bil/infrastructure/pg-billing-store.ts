import type { Transaction } from '../../../platform/database/unit-of-work';
import type { BillingStore, DocumentFilter, DocumentRecord, DraftHeader, LevyRecord, LineRecord, OpenItemFilter, OpenItemRecord, ReprintRecord, SettlementRecord } from '../application/billing-store';

interface HeaderRow {
  id: string;
  kind: DocumentRecord['kind'];
  status: DocumentRecord['status'];
  branch_id: string;
  document_no: string | null;
  provisional_ref: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_tin: string | null;
  billing_address: string | null;
  order_document_id: string | null;
  original_document_id: string | null;
  issue_date: string;
  due_date: string | null;
  tax_inclusive: boolean;
  tax_scheme_version_id: string;
  net_pesewas: string;
  tax_pesewas: string;
  gross_pesewas: string;
  credited_pesewas: string;
  certified_tax_pesewas: string | null;
  certified_gross_pesewas: string | null;
  certification_ref: string | null;
  reason_code: string | null;
  note: string | null;
  approval_request_id: string | null;
  content_hash: Buffer | null;
  archived_document_id: string | null;
  issued_at: Date | null;
  occurred_at: Date | null;
  created_by: string;
  version: number;
}

interface LineRow {
  id: string;
  billing_document_id: string;
  line_no: number;
  line_kind: LineRecord['lineKind'];
  product_id: string | null;
  description: string;
  stock_unit_id: string | null;
  stock_unit_identifier: string | null;
  stock_unit_tracking: 'SERIAL' | 'LOT' | null;
  order_line_ref: string | null;
  credits_line_id: string | null;
  qty: string;
  uom: string;
  weight_kg: string | null;
  unit_price_pesewas: string;
  resolved_unit_price_pesewas: string;
  discount_pesewas: string;
  tax_category_id: string;
  line_net_pesewas: string;
  line_tax_pesewas: string;
  line_gross_pesewas: string;
  gl_group: string;
}

interface TaxRow {
  billing_document_line_id: string;
  levy_id: string;
  levy_code: string;
  levy_name: string;
  treatment: LevyRecord['treatment'];
  rate_percent: string;
  base_pesewas: string;
  amount_pesewas: string;
  calc_order: number;
}

/** BIL's tables (bil.md). Parameterised SQL only; money read as text and carried as bigint. */
export class PgBillingStore implements BillingStore {
  async insertDraft(tx: Transaction, h: DraftHeader, lines: readonly LineRecord[]): Promise<void> {
    await tx.query(
      `INSERT INTO bil.billing_document (id, kind, status, branch_id, provisional_ref, customer_id, customer_name, customer_tin, billing_address,
                                         order_document_id, original_document_id, issue_date, due_date, tax_inclusive, tax_scheme_version_id,
                                         reason_code, note, occurred_at, created_by, updated_by)
       VALUES ($1, $2, 'DRAFT', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)`,
      [h.id, h.kind, h.branchId, h.provisionalRef, h.customerId, h.customerName, h.customerTin, h.billingAddress, h.orderDocumentId, h.originalDocumentId,
        h.issueDate, h.dueDate, h.taxInclusive, h.taxSchemeVersionId, h.reasonCode, h.note, h.occurredAt, h.actorId],
    );
    for (const l of lines) {
      await tx.query(
        `INSERT INTO bil.billing_document_line (id, billing_document_id, line_no, line_kind, product_id, description, stock_unit_id, stock_unit_identifier,
                                                stock_unit_tracking, order_line_ref, credits_line_id, qty, uom, weight_kg, unit_price_pesewas,
                                                resolved_unit_price_pesewas, discount_pesewas, tax_category_id, line_net_pesewas, line_tax_pesewas,
                                                line_gross_pesewas, gl_group)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
        [l.id, h.id, l.lineNo, l.lineKind, l.productId, l.description, l.stockUnit?.id ?? null, l.stockUnit?.identifier ?? null, l.stockUnit?.tracking ?? null,
          l.orderLineRef, l.creditsLineId, l.qty, l.uom, l.weightKg, l.unitPricePesewas.toString(), l.resolvedUnitPricePesewas.toString(),
          l.discountPesewas.toString(), l.taxCategoryId, l.lineNetPesewas.toString(), l.lineTaxPesewas.toString(), l.lineGrossPesewas.toString(), l.glGroup],
      );
      for (const t of l.levies) {
        await tx.query(
          `INSERT INTO bil.billing_document_line_tax (billing_document_line_id, levy_id, levy_code, levy_name, treatment, rate_percent, base_pesewas, amount_pesewas, calc_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [l.id, t.levyId, t.levyCode, t.levyName, t.treatment, t.ratePercent, t.basePesewas.toString(), t.amountPesewas.toString(), t.calcOrder],
        );
      }
    }
  }

  async issue(tx: Transaction, id: string, issue: { documentNo: string; netPesewas: bigint; taxPesewas: bigint; grossPesewas: bigint; issueDate: string; issuedAt: Date; actorId: string }): Promise<void> {
    await tx.query(
      `UPDATE bil.billing_document SET status = 'ISSUED', document_no = $2, net_pesewas = $3, tax_pesewas = $4, gross_pesewas = $5,
              issued_at = $6, issued_by = $7, updated_at = $6, updated_by = $7, issue_date = $8
        WHERE id = $1 AND status = 'DRAFT'`,
      [id, issue.documentNo, issue.netPesewas.toString(), issue.taxPesewas.toString(), issue.grossPesewas.toString(), issue.issuedAt, issue.actorId, issue.issueDate],
    );
  }

  async markPending(tx: Transaction, id: string, approvalRequestId: string, actorId: string): Promise<void> {
    await tx.query('UPDATE bil.billing_document SET approval_request_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1 AND status = $4', [id, approvalRequestId, actorId, 'DRAFT']);
  }

  async documents(tx: Transaction, ids: readonly string[], forUpdate = false): Promise<DocumentRecord[]> {
    if (ids.length === 0) return [];
    const headers = await tx.query<HeaderRow>(
      `SELECT id, kind, status, branch_id, document_no, provisional_ref, customer_id, customer_name, customer_tin, billing_address, order_document_id,
              original_document_id, issue_date::text AS issue_date, due_date::text AS due_date, tax_inclusive, tax_scheme_version_id,
              net_pesewas::text, tax_pesewas::text, gross_pesewas::text, credited_pesewas::text, certified_tax_pesewas::text, certified_gross_pesewas::text,
              certification_ref, reason_code, note, approval_request_id, content_hash, archived_document_id, issued_at, occurred_at, created_by, version
         FROM bil.billing_document WHERE id = ANY($1::uuid[])${forUpdate ? ' FOR UPDATE' : ''}`,
      [ids],
    );
    const lines = await tx.query<LineRow>(
      `SELECT id, billing_document_id, line_no, line_kind, product_id, description, stock_unit_id, stock_unit_identifier, stock_unit_tracking, order_line_ref,
              credits_line_id, qty::text, uom, weight_kg::text, unit_price_pesewas::text, resolved_unit_price_pesewas::text, discount_pesewas::text,
              tax_category_id, line_net_pesewas::text, line_tax_pesewas::text, line_gross_pesewas::text, gl_group
         FROM bil.billing_document_line WHERE billing_document_id = ANY($1::uuid[]) ORDER BY billing_document_id, line_no`,
      [ids],
    );
    const taxes = await tx.query<TaxRow>(
      `SELECT t.billing_document_line_id, t.levy_id, t.levy_code, t.levy_name, t.treatment, CASE WHEN scale(trim_scale(t.rate_percent)) < 2 THEN round(t.rate_percent, 2)::text ELSE trim_scale(t.rate_percent)::text END AS rate_percent, t.base_pesewas::text, t.amount_pesewas::text, t.calc_order
         FROM bil.billing_document_line_tax t JOIN bil.billing_document_line l ON l.id = t.billing_document_line_id
        WHERE l.billing_document_id = ANY($1::uuid[]) ORDER BY t.billing_document_line_id, t.calc_order, t.levy_code`,
      [ids],
    );
    const leviesOf = new Map<string, LevyRecord[]>();
    for (const t of taxes.rows) {
      const list = leviesOf.get(t.billing_document_line_id) ?? [];
      list.push({
        levyId: t.levy_id,
        levyCode: t.levy_code,
        levyName: t.levy_name,
        treatment: t.treatment,
        ratePercent: t.rate_percent,
        basePesewas: BigInt(t.base_pesewas),
        amountPesewas: BigInt(t.amount_pesewas),
        calcOrder: t.calc_order,
      });
      leviesOf.set(t.billing_document_line_id, list);
    }
    const linesOf = new Map<string, LineRecord[]>();
    for (const l of lines.rows) {
      const list = linesOf.get(l.billing_document_id) ?? [];
      list.push({
        id: l.id,
        lineNo: l.line_no,
        lineKind: l.line_kind,
        productId: l.product_id,
        description: l.description,
        stockUnit: l.stock_unit_id === null ? null : { id: l.stock_unit_id, identifier: l.stock_unit_identifier!, tracking: l.stock_unit_tracking! },
        orderLineRef: l.order_line_ref,
        creditsLineId: l.credits_line_id,
        qty: l.qty,
        uom: l.uom,
        weightKg: l.weight_kg,
        unitPricePesewas: BigInt(l.unit_price_pesewas),
        resolvedUnitPricePesewas: BigInt(l.resolved_unit_price_pesewas),
        discountPesewas: BigInt(l.discount_pesewas),
        taxCategoryId: l.tax_category_id,
        lineNetPesewas: BigInt(l.line_net_pesewas),
        lineTaxPesewas: BigInt(l.line_tax_pesewas),
        lineGrossPesewas: BigInt(l.line_gross_pesewas),
        glGroup: l.gl_group,
        levies: leviesOf.get(l.id) ?? [],
      });
      linesOf.set(l.billing_document_id, list);
    }
    const byId = new Map(
      headers.rows.map((h): [string, DocumentRecord] => [
        h.id,
        {
          id: h.id,
          kind: h.kind,
          status: h.status,
          branchId: h.branch_id,
          documentNo: h.document_no,
          provisionalRef: h.provisional_ref,
          customerId: h.customer_id,
          customerName: h.customer_name,
          customerTin: h.customer_tin,
          billingAddress: h.billing_address,
          orderDocumentId: h.order_document_id,
          originalDocumentId: h.original_document_id,
          issueDate: h.issue_date,
          dueDate: h.due_date,
          taxInclusive: h.tax_inclusive,
          taxSchemeVersionId: h.tax_scheme_version_id,
          reasonCode: h.reason_code,
          note: h.note,
          occurredAt: h.occurred_at,
          netPesewas: BigInt(h.net_pesewas),
          taxPesewas: BigInt(h.tax_pesewas),
          grossPesewas: BigInt(h.gross_pesewas),
          creditedPesewas: BigInt(h.credited_pesewas),
          certification:
            h.certified_gross_pesewas === null ? null : { taxPesewas: BigInt(h.certified_tax_pesewas!), grossPesewas: BigInt(h.certified_gross_pesewas), reference: h.certification_ref! },
          approvalRequestId: h.approval_request_id,
          contentHash: h.content_hash,
          archivedDocumentId: h.archived_document_id,
          issuedAt: h.issued_at,
          createdBy: h.created_by,
          version: h.version,
          lines: linesOf.get(h.id) ?? [],
        },
      ]),
    );
    return ids.flatMap((id) => {
      const record = byId.get(id);
      return record === undefined ? [] : [record];
    });
  }

  async creditedAnchors(tx: Transaction, originalLineIds: readonly string[], taxInclusive: boolean): Promise<ReadonlyMap<string, bigint>> {
    if (originalLineIds.length === 0) return new Map();
    const { rows } = await tx.query<{ credits_line_id: string; anchor: string }>(
      `SELECT l.credits_line_id, sum(CASE WHEN $2 THEN l.line_gross_pesewas ELSE l.line_net_pesewas END)::text AS anchor
         FROM bil.billing_document_line l JOIN bil.billing_document d ON d.id = l.billing_document_id
        WHERE l.credits_line_id = ANY($1::uuid[]) AND d.kind = 'CREDIT_NOTE' AND d.status = 'ISSUED'
        GROUP BY l.credits_line_id`,
      [originalLineIds, taxInclusive],
    );
    return new Map(rows.map((r) => [r.credits_line_id, BigInt(r.anchor)] as const));
  }

  async openItems(tx: Transaction, f: OpenItemFilter, beforeId: string | null, limit: number): Promise<{ readonly rows: OpenItemRecord[]; readonly totalOutstandingPesewas: bigint }> {
    const where = `d.status = 'ISSUED' AND d.kind IN ('INVOICE', 'RECEIPT', 'DEBIT_NOTE') AND s.outstanding_pesewas > 0 AND d.branch_id = ANY($1::uuid[])
          AND ($2::uuid IS NULL OR d.customer_id = $2) AND ($3::date IS NULL OR d.due_date < $3)`;
    const { rows } = await tx.query<{ id: string; kind: string; document_no: string | null; customer_id: string | null; customer_name: string | null; issue_date: string; due_date: string | null; gross: string; credited: string; allocated: string; outstanding: string }>(
      `SELECT d.id, d.kind, d.document_no, d.customer_id, d.customer_name, d.issue_date::text, d.due_date::text, d.gross_pesewas::text AS gross,
              s.credited_pesewas::text AS credited, s.allocated_pesewas::text AS allocated, s.outstanding_pesewas::text AS outstanding
         FROM bil.billing_document d JOIN bil.document_settlement s ON s.billing_document_id = d.id
        WHERE ${where} AND ($4::uuid IS NULL OR d.id < $4) ORDER BY d.id DESC LIMIT $5`,
      [f.branchIds, f.customerId, f.overdueBefore, beforeId, limit],
    );
    const total = await tx.query<{ total: string }>(
      `SELECT COALESCE(sum(s.outstanding_pesewas), 0)::text AS total FROM bil.billing_document d JOIN bil.document_settlement s ON s.billing_document_id = d.id WHERE ${where}`,
      [f.branchIds, f.customerId, f.overdueBefore],
    );
    return {
      rows: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        documentNo: r.document_no,
        customerId: r.customer_id,
        customerName: r.customer_name,
        issueDate: r.issue_date,
        dueDate: r.due_date,
        grossPesewas: BigInt(r.gross),
        creditedPesewas: BigInt(r.credited),
        allocatedPesewas: BigInt(r.allocated),
        outstandingPesewas: BigInt(r.outstanding),
      })),
      totalOutstandingPesewas: BigInt(total.rows[0]!.total),
    };
  }

  async settlements(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, SettlementRecord>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<{
      billing_document_id: string;
      allocated_pesewas: string;
      credited_pesewas: string;
      outstanding_pesewas: string;
      payment_status: SettlementRecord['paymentStatus'];
      settled_at: Date | null;
      as_of: Date;
    }>(
      `SELECT billing_document_id, allocated_pesewas::text, credited_pesewas::text, outstanding_pesewas::text, payment_status, settled_at, as_of
         FROM bil.document_settlement WHERE billing_document_id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(
      rows.map((r) => [
        r.billing_document_id,
        {
          allocatedPesewas: BigInt(r.allocated_pesewas),
          creditedPesewas: BigInt(r.credited_pesewas),
          outstandingPesewas: BigInt(r.outstanding_pesewas),
          paymentStatus: r.payment_status,
          settledAt: r.settled_at,
          asOf: r.as_of,
        },
      ]),
    );
  }

  async list(tx: Transaction, f: DocumentFilter, afterId: string | null, limit: number): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT d.id FROM bil.billing_document d LEFT JOIN bil.document_settlement s ON s.billing_document_id = d.id
        WHERE d.branch_id = ANY($1::uuid[])
          AND ($2::text IS NULL OR d.kind = $2) AND ($3::uuid IS NULL OR d.customer_id = $3) AND ($4::uuid IS NULL OR d.order_document_id = $4)
          AND ($5::text IS NULL OR d.document_no = $5 OR d.provisional_ref = $5)
          AND ($6::date IS NULL OR d.issue_date >= $6) AND ($7::date IS NULL OR d.issue_date <= $7)
          AND ($8::text IS NULL OR s.payment_status = $8) AND ($9::uuid IS NULL OR d.id < $9)
        ORDER BY d.id DESC LIMIT $10`,
      [f.branchIds, f.kind, f.customerId, f.orderId, f.documentNo, f.from, f.to, f.paymentStatus, afterId, limit],
    );
    return rows.map((r) => r.id);
  }
  async linkArchive(tx: Transaction, id: string, archivedDocumentId: string, contentHash: Buffer): Promise<boolean> {
    const result = await tx.query(
      `UPDATE bil.billing_document SET archived_document_id = $2, content_hash = $3, updated_at = now()
        WHERE id = $1 AND status = 'ISSUED' AND archived_document_id IS NULL`,
      [id, archivedDocumentId, contentHash],
    );
    return result.rowCount === 1;
  }

  async reprintCounts(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<{ id: string; n: number }>('SELECT billing_document_id AS id, count(*)::int AS n FROM bil.reprint_log WHERE billing_document_id = ANY($1::uuid[]) GROUP BY billing_document_id', [ids]);
    return new Map(rows.map((r) => [r.id, r.n] as const));
  }

  async appendReprint(tx: Transaction, r: { readonly id: string; readonly billingDocumentId: string; readonly channel: ReprintRecord['channel']; readonly actorId: string; readonly at: Date }): Promise<number> {
    const { rows } = await tx.query<{ copy_no: number }>(
      `INSERT INTO bil.reprint_log (id, billing_document_id, copy_no, channel, recorded_at, actor_id)
       SELECT $1, $2, COALESCE(max(copy_no), 0) + 1, $3, $4, $5 FROM bil.reprint_log WHERE billing_document_id = $2
       RETURNING copy_no`,
      [r.id, r.billingDocumentId, r.channel, r.at, r.actorId],
    );
    return rows[0]!.copy_no;
  }

  async reprints(tx: Transaction, billingDocumentId: string, afterCopyNo: number | null, limit: number): Promise<ReprintRecord[]> {
    const { rows } = await tx.query<{ copy_no: number; channel: ReprintRecord['channel']; actor_id: string; recorded_at: Date }>(
      `SELECT copy_no, channel, actor_id, recorded_at FROM bil.reprint_log
        WHERE billing_document_id = $1 AND ($2::int IS NULL OR copy_no > $2) ORDER BY copy_no LIMIT $3`,
      [billingDocumentId, afterCopyNo, limit],
    );
    return rows.map((row) => ({ copyNo: row.copy_no, channel: row.channel, actorId: row.actor_id, recordedAt: row.recorded_at }));
  }

  async issuedForAudit(tx: Transaction): Promise<{ readonly id: string; readonly documentNo: string; readonly contentHash: Buffer | null; readonly archivedDocumentId: string | null; readonly issuedAt: Date }[]> {
    const { rows } = await tx.query<{ id: string; document_no: string; content_hash: Buffer | null; archived_document_id: string | null; issued_at: Date }>(
      "SELECT id, document_no, content_hash, archived_document_id, issued_at FROM bil.billing_document WHERE status = 'ISSUED' ORDER BY id",
    );
    return rows.map((r) => ({ id: r.id, documentNo: r.document_no, contentHash: r.content_hash, archivedDocumentId: r.archived_document_id, issuedAt: r.issued_at }));
  }
}
