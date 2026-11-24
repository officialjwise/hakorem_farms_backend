import type { Transaction } from '../../../platform/database/unit-of-work';
import type { BreakRow } from '../domain/classify';
import type { ExceptionKind, Severity } from '../domain/exception-kinds';
import type { StockExceptionRow } from '../domain/sweep';
import type { ApprovalFactRecord, BreakState, ExceptionItemRecord, ExceptionStore, ItemFilter, ItemScope, PayoutChangeRecord, StoredDraft } from '../application/exception-store';

interface ItemRow {
  id: string;
  exception_date: string;
  branch_id: string | null;
  kind: ExceptionKind;
  source_kind: string | null;
  abuse_cases: number[];
  severity: Severity;
  actor_ref: string | null;
  subject_document_ref: string | null;
  subject_doc_type: string | null;
  amount: string | null;
  summary: string;
  details: Record<string, unknown>;
  raised_at: Date;
  restricted_to: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  note: string | null;
}

const ITEM_COLUMNS = `i.id, i.exception_date::text AS exception_date, i.branch_id, i.kind, i.source_kind, i.abuse_cases, i.severity, i.actor_ref,
  i.subject_document_ref, i.subject_doc_type, i.amount_pesewas::text AS amount, i.summary, i.details, i.raised_at, i.restricted_to,
  r.actor_id AS reviewed_by, r.recorded_at AS reviewed_at, r.note`;

function toItem(r: ItemRow): ExceptionItemRecord {
  return {
    id: r.id,
    exceptionDate: r.exception_date,
    branchId: r.branch_id,
    kind: r.kind,
    sourceKind: r.source_kind,
    severity: r.severity,
    abuseCases: r.abuse_cases,
    actorId: r.actor_ref,
    subjectId: r.subject_document_ref,
    subjectDocType: r.subject_doc_type,
    amountPesewas: r.amount === null ? null : BigInt(r.amount),
    summary: r.summary,
    details: r.details,
    raisedAt: r.raised_at,
    restrictedTo: r.restricted_to,
    review: r.reviewed_by === null ? null : { reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at!, note: r.note! },
  };
}

/**
 * The filter in SQL from parameter `$start` on: the date range, the reader's branches, the investor books' branches
 * for a restricted item, and the optional kind, severity, actor, branch and reviewed state.
 */
function where(filter: ItemFilter, scope: ItemScope, start: number): { readonly sql: string; readonly params: unknown[] } {
  const params: unknown[] = [filter.from, filter.to, [...scope.branchIds], [...scope.investorBranchIds]];
  const at = (n: number) => `$${start + n}`;
  const clauses = [
    `i.exception_date BETWEEN ${at(0)}::date AND ${at(1)}::date`,
    `i.branch_id = ANY(${at(2)}::uuid[])`,
    `(i.restricted_to IS NULL OR i.branch_id = ANY(${at(3)}::uuid[]))`,
  ];
  const add = (sql: (p: string) => string, value: unknown) => {
    params.push(value);
    clauses.push(sql(at(params.length - 1)));
  };
  if (filter.branchId !== undefined) add((p) => `i.branch_id = ${p}::uuid`, filter.branchId);
  if (filter.kind !== undefined) add((p) => `i.kind = ${p}`, filter.kind);
  if (filter.severity !== undefined) add((p) => `i.severity = ${p}`, filter.severity);
  if (filter.actorId !== undefined) add((p) => `i.actor_ref = ${p}::uuid`, filter.actorId);
  if (filter.reviewed !== undefined) clauses.push(filter.reviewed ? 'r.id IS NOT NULL' : 'r.id IS NULL');
  return { sql: clauses.join(' AND '), params };
}

/** RPT's exception tables, and the published views and outbox it reads, in plain SQL (ADR-0011, ADR-0023, ADR-0103). */
export class PgExceptionStore implements ExceptionStore {
  async putItems(tx: Transaction, items: readonly StoredDraft[], replace: boolean): Promise<number> {
    if (items.length === 0) return 0;
    const rows = items.map((i) => ({
      sourceKey: i.sourceKey,
      eventRef: i.eventRef,
      exceptionDate: i.exceptionDate,
      branchId: i.branchId,
      kind: i.kind,
      sourceKind: i.sourceKind,
      abuseCases: i.abuseCases,
      severity: i.severity,
      actorId: i.actorId,
      subjectId: i.subject?.id ?? null,
      subjectDocType: i.subject?.docType ?? null,
      amountPesewas: i.amountPesewas === null ? null : i.amountPesewas.toString(),
      summary: i.summary,
      details: i.details,
      raisedAt: i.raisedAt.toISOString(),
      restrictedTo: i.restrictedTo,
    }));
    const { rows: out } = await tx.query<{ n: number }>('SELECT rpt.put_exception_items($1::jsonb, $2) AS n', [JSON.stringify(rows), replace]);
    return out[0]!.n;
  }

  async checkpoint(tx: Transaction, projector: string, message: { readonly id: string; readonly recordedAt: Date } | null, at: Date, rebuilt: boolean): Promise<void> {
    await tx.query(
      `INSERT INTO rpt.projection_checkpoint (projector, last_message_id, last_processed_at, last_recorded_at, rebuilt_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN $3::timestamptz END)
       ON CONFLICT (projector) DO UPDATE
          SET last_message_id = COALESCE(EXCLUDED.last_message_id, rpt.projection_checkpoint.last_message_id),
              last_processed_at = EXCLUDED.last_processed_at,
              last_recorded_at = GREATEST(EXCLUDED.last_recorded_at, rpt.projection_checkpoint.last_recorded_at),
              rebuilt_at = COALESCE(EXCLUDED.rebuilt_at, rpt.projection_checkpoint.rebuilt_at)`,
      [projector, message?.id ?? null, at, message?.recordedAt ?? null, rebuilt],
    );
  }

  async checkpointOf(tx: Transaction, projector: string): Promise<{ readonly lastProcessedAt: Date | null; readonly lastRecordedAt: Date | null; readonly rebuiltAt: Date | null } | null> {
    const { rows } = await tx.query<{ last_processed_at: Date | null; last_recorded_at: Date | null; rebuilt_at: Date | null }>(
      'SELECT last_processed_at, last_recorded_at, rebuilt_at FROM rpt.projection_checkpoint WHERE projector = $1',
      [projector],
    );
    const r = rows[0];
    return r === undefined ? null : { lastProcessedAt: r.last_processed_at, lastRecordedAt: r.last_recorded_at, rebuiltAt: r.rebuilt_at };
  }

  async clearProjections(tx: Transaction): Promise<void> {
    await tx.query('SELECT rpt.clear_exception_projections()');
  }

  async countItems(tx: Transaction): Promise<number> {
    return (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM rpt.exception_item')).rows[0]!.n;
  }

  async putApproval(tx: Transaction, f: { readonly eventId: string; readonly at: Date; readonly date: string; readonly branchId: string | null; readonly kind: string; readonly decision: string; readonly makerId: string; readonly checkerId: string; readonly amountPesewas: bigint | null }): Promise<void> {
    await tx.query('SELECT rpt.put_approval_fact($1, $2, $3::date, $4, $5, $6, $7, $8, $9)', [f.eventId, f.at, f.date, f.branchId, f.kind, f.decision, f.makerId, f.checkerId, f.amountPesewas?.toString() ?? null]);
  }

  async approvalsOn(tx: Transaction, date: string, branchIds: readonly string[]): Promise<ApprovalFactRecord[]> {
    const { rows } = await tx.query<{ maker_ref: string; checker_ref: string; amount: string | null }>(
      'SELECT maker_ref, checker_ref, amount_pesewas::text AS amount FROM rpt.approval_fact WHERE decided_date = $1::date AND branch_id = ANY($2::uuid[]) ORDER BY decided_at, event_ref',
      [date, [...branchIds]],
    );
    return rows.map((r) => ({ makerId: r.maker_ref, checkerId: r.checker_ref, amountPesewas: r.amount === null ? null : BigInt(r.amount) }));
  }

  async putCheckout(tx: Transaction, checkoutId: string, addressHash: string | null, at: Date, date: string, outcome: 'STARTED' | 'EXPIRED' | 'CANCELLED' | 'COMPLETED'): Promise<void> {
    await tx.query('SELECT rpt.put_checkout_fact($1, $2, $3, $4::date, $5)', [checkoutId, addressHash, at, date, outcome]);
  }

  async checkoutsOf(tx: Transaction, checkoutId: string): Promise<{ readonly addressHash: string | null; readonly date: string } | null> {
    const { rows } = await tx.query<{ address_hash: string | null; started_date: string }>('SELECT address_hash, started_date::text AS started_date FROM rpt.checkout_fact WHERE checkout_ref = $1', [checkoutId]);
    const r = rows[0];
    return r === undefined ? null : { addressHash: r.address_hash, date: r.started_date };
  }

  async checkoutCounts(tx: Transaction, addressHash: string, date: string): Promise<{ readonly started: number; readonly unpaid: number; readonly completed: number }> {
    const { rows } = await tx.query<{ started: number; unpaid: number; completed: number }>(
      `SELECT count(*)::int AS started, count(*) FILTER (WHERE outcome IN ('EXPIRED', 'CANCELLED'))::int AS unpaid,
              count(*) FILTER (WHERE outcome = 'COMPLETED')::int AS completed
         FROM rpt.checkout_fact WHERE address_hash = $1 AND started_date = $2::date`,
      [addressHash, date],
    );
    return rows[0]!;
  }

  async putPayoutChange(tx: Transaction, c: { readonly eventId: string; readonly partyKind: 'SUPPLIER' | 'INVESTOR'; readonly partyId: string; readonly changeId: string; readonly at: Date; readonly requestedBy: string | null; readonly approvedBy: string | null }): Promise<void> {
    await tx.query('SELECT rpt.put_payout_change($1, $2, $3, $4, $5, $6, $7)', [c.eventId, c.partyKind, c.partyId, c.changeId, c.at, c.requestedBy, c.approvedBy]);
  }

  async payoutChangesWithin(tx: Transaction, partyKind: 'SUPPLIER' | 'INVESTOR', partyId: string, from: Date, to: Date): Promise<PayoutChangeRecord[]> {
    const { rows } = await tx.query<{ change_ref: string; changed_at: Date; requested_by: string | null; approved_by: string | null }>(
      `SELECT change_ref, changed_at, requested_by, approved_by FROM rpt.payout_change_fact
        WHERE party_kind = $1 AND party_ref = $2 AND changed_at >= $3 AND changed_at <= $4 ORDER BY changed_at, event_ref`,
      [partyKind, partyId, from, to],
    );
    return rows.map((r) => ({ changeId: r.change_ref, changedAt: r.changed_at, requestedBy: r.requested_by, approvedBy: r.approved_by }));
  }

  async stockExceptionsBetween(tx: Transaction, from: Date, to: Date): Promise<StockExceptionRow[]> {
    const { rows } = await tx.query<{
      id: string;
      kind: string;
      branch_id: string;
      product_id: string;
      stock_unit_id: string | null;
      location_id: string | null;
      movement_id: string | null;
      source_document_id: string | null;
      qty: string | null;
      raised_at: Date;
      status: string;
      actor_id: string | null;
    }>(
      `SELECT id, kind, branch_id, product_id, stock_unit_id, location_id, movement_id, source_document_id, qty::text AS qty, raised_at, status, actor_id
         FROM inv.pub_stock_exception WHERE raised_at >= $1 AND raised_at < $2 ORDER BY raised_at, id`,
      [from, to],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      branchId: r.branch_id,
      productId: r.product_id,
      stockUnitId: r.stock_unit_id,
      locationId: r.location_id,
      movementId: r.movement_id,
      sourceDocumentId: r.source_document_id,
      qty: r.qty,
      raisedAt: r.raised_at,
      status: r.status,
      actorId: r.actor_id,
    }));
  }

  async breaksBetween(tx: Transaction, from: Date, to: Date): Promise<BreakRow[]> {
    const { rows } = await tx.query<{
      id: string;
      kind: string;
      branch_id: string | null;
      payment_id: string | null;
      refund_id: string | null;
      reference: string | null;
      source_document_id: string | null;
      amount: string | null;
      raised_at: Date;
    }>(
      `SELECT id, kind, branch_id, payment_id, refund_id, reference, source_document_id, amount_pesewas::text AS amount, raised_at
         FROM pay.pub_reconciliation_break WHERE raised_at >= $1 AND raised_at < $2 ORDER BY raised_at, id`,
      [from, to],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      branchId: r.branch_id,
      paymentId: r.payment_id,
      refundId: r.refund_id,
      reference: r.reference,
      sourceDocumentId: r.source_document_id,
      amountPesewas: r.amount === null ? null : BigInt(r.amount),
      raisedAt: r.raised_at,
    }));
  }

  async breakStates(tx: Transaction, ids: readonly string[]): Promise<Map<string, BreakState>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<{ id: string; status: string; raised_at: Date; resolved_at: Date | null }>(
      'SELECT id, status, raised_at, resolved_at FROM pay.pub_reconciliation_break WHERE id = ANY($1::uuid[])',
      [[...ids]],
    );
    return new Map(rows.map((r) => [r.id, { id: r.id, status: r.status, raisedAt: r.raised_at, resolvedAt: r.resolved_at }]));
  }

  async completedSalesBySalesperson(tx: Transaction, date: string, branchIds: readonly string[]): Promise<Map<string, number>> {
    const { rows } = await tx.query<{ salesperson_id: string; n: number }>(
      `SELECT o.salesperson_id, count(*)::int AS n
         FROM ord.pub_completed_sale s
         JOIN ord.pub_sale_order o ON o.order_id = s.order_id
        WHERE s.business_date = $1::date AND s.branch_id = ANY($2::uuid[]) AND s.channel = 'POS' AND o.salesperson_id IS NOT NULL
        GROUP BY o.salesperson_id`,
      [date, [...branchIds]],
    );
    return new Map(rows.map((r) => [r.salesperson_id, r.n]));
  }

  async itemsOn(tx: Transaction, filter: ItemFilter, scope: ItemScope): Promise<ExceptionItemRecord[]> {
    const w = where(filter, scope, 1);
    const { rows } = await tx.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM rpt.exception_item i LEFT JOIN rpt.exception_review r ON r.exception_item_id = i.id
        WHERE ${w.sql}
        ORDER BY CASE i.severity WHEN 'URGENT' THEN 0 WHEN 'REVIEW' THEN 1 ELSE 2 END, i.raised_at, i.id`,
      w.params,
    );
    return rows.map(toItem);
  }

  async listItems(tx: Transaction, filter: ItemFilter, scope: ItemScope, after: { readonly raisedAt: string; readonly id: string } | null, limit: number): Promise<ExceptionItemRecord[]> {
    const w = where(filter, scope, 1);
    const n = w.params.length;
    const { rows } = await tx.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM rpt.exception_item i LEFT JOIN rpt.exception_review r ON r.exception_item_id = i.id
        WHERE ${w.sql} AND ($${n + 1}::timestamptz IS NULL OR (i.raised_at, i.id) < ($${n + 1}::timestamptz, $${n + 2}::uuid))
        ORDER BY i.raised_at DESC, i.id DESC
        LIMIT $${n + 3}`,
      [...w.params, after?.raisedAt ?? null, after?.id ?? null, limit],
    );
    return rows.map(toItem);
  }

  async item(tx: Transaction, id: string): Promise<ExceptionItemRecord | null> {
    const { rows } = await tx.query<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM rpt.exception_item i LEFT JOIN rpt.exception_review r ON r.exception_item_id = i.id WHERE i.id = $1`, [id]);
    return rows.length === 0 ? null : toItem(rows[0]!);
  }

  async insertReview(tx: Transaction, v: { readonly id: string; readonly itemId: string; readonly branchId: string | null; readonly itemActorId: string | null; readonly note: string; readonly at: Date; readonly actorId: string }): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO rpt.exception_review (id, exception_item_id, branch_id, item_actor_ref, note, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (exception_item_id) DO NOTHING`,
      [v.id, v.itemId, v.branchId, v.itemActorId, v.note, v.at, v.actorId],
    );
    return (rowCount ?? 0) === 1;
  }
}
