import { formatCedis } from '@hakorem/kernel';
import type { ExceptionDraft } from './classify';
import type { ExceptionKind } from './exception-kinds';

/**
 * The exception items whose source is a record rather than an event (ADR-0103): the audit trail's refusals and
 * exports, the nightly audit verification's runs, inventory's stock exception queue and PUR's order splitting rule.
 * The sweep reads them for a day and raises one item per record, keyed by the record, so a second sweep changes nothing.
 */

/** An audit event the sweep reads (`platform.audit_event`): who, what, and the after image when it was not sealed. */
export interface AuditFindingRow {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorId: string | null;
  readonly branchId: string | null;
  readonly module: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
}

/** The audit actions the sweep reads. */
export const AUDIT_FINDING_ACTIONS = ['AUTHORISATION_FAILURE', 'EXPORT'] as const;

export function auditFinding(row: AuditFindingRow): ExceptionDraft | null {
  const base = { sourceKey: `audit:${row.id}`, branchId: row.branchId, actorId: row.actorId, raisedAt: row.occurredAt, restrictedTo: null } as const;
  if (row.action === 'AUTHORISATION_FAILURE') {
    const m = row.metadata ?? {};
    const permission = typeof m['permission'] === 'string' ? m['permission'] : 'a permission';
    const reason = typeof m['reason'] === 'string' ? m['reason'] : 'refused';
    return {
      ...base,
      kind: 'AUTHORISATION_FAILURE',
      sourceKind: `${row.module.toUpperCase()}_REFUSAL`,
      severity: 'REVIEW',
      abuseCases: [8],
      subject: null,
      amountPesewas: null,
      summary: `A request needing ${permission} was refused (${reason})`,
      details: { auditEventId: row.id, permission, reason, locationId: m['locationId'] ?? null },
    };
  }
  if (row.action === 'EXPORT') {
    const a = row.after ?? {};
    const rows = typeof a['rowCount'] === 'number' ? a['rowCount'] : null;
    const bulk = a['bulk'] === true;
    const what = typeof a['entity'] === 'string' ? a['entity'] : row.entityType;
    return {
      ...base,
      kind: 'BULK_EXPORT',
      sourceKind: bulk ? 'BULK' : 'SMALL',
      severity: bulk ? 'REVIEW' : 'INFO',
      abuseCases: [9],
      subject: row.entityId === null ? null : { id: row.entityId, docType: row.entityType === 'ImportJob' ? 'IMPORT_JOB' : 'REPORT_RUN' },
      amountPesewas: null,
      summary: `${String(what).toLowerCase().replaceAll('_', ' ')} exported${rows === null ? '' : `: ${rows} rows`}`,
      details: { auditEventId: row.id, module: row.module, entity: what, rowCount: rows, bulk, format: a['format'] ?? null },
    };
  }
  return null;
}

/** A run of the nightly audit verification that did not succeed (`platform.job_run`, ADR-0006). */
export interface VerificationRunRow {
  readonly id: string;
  readonly finishedAt: Date;
  readonly outcome: string;
  readonly summary: Readonly<Record<string, unknown>>;
}

export function verificationFailure(row: VerificationRunRow, headOfficeBranchId: string | null): ExceptionDraft {
  return {
    sourceKey: `job-run:${row.id}`,
    kind: 'AUDIT_INTEGRITY',
    sourceKind: `AUDIT_CHAIN_${row.outcome}`,
    severity: 'URGENT',
    abuseCases: [15],
    branchId: headOfficeBranchId,
    actorId: null,
    subject: null,
    amountPesewas: null,
    summary: `The audit chain's verification ended ${row.outcome}: the log may have been altered`,
    details: { jobRunId: row.id, outcome: row.outcome, report: row.summary },
    raisedAt: row.finishedAt,
    restrictedTo: null,
  };
}

/** A row of `inv.pub_stock_exception`: what inventory's triggers and services raised. */
export interface StockExceptionRow {
  readonly id: string;
  readonly kind: string;
  readonly branchId: string;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string | null;
  readonly movementId: string | null;
  readonly sourceDocumentId: string | null;
  readonly qty: string | null;
  readonly raisedAt: Date;
  readonly status: string;
  readonly actorId: string | null;
}

const STOCK_EXCEPTION_KIND: Readonly<Record<string, { readonly kind: ExceptionKind; readonly cases: readonly number[]; readonly severity: 'REVIEW' | 'URGENT' }>> = {
  NEGATIVE_STOCK: { kind: 'NEGATIVE_STOCK', cases: [11, 36], severity: 'REVIEW' },
  SERIAL_CONFLICT: { kind: 'STOCK_EXCEPTION', cases: [11], severity: 'URGENT' },
  HOLD_CONFLICT: { kind: 'STOCK_EXCEPTION', cases: [11, 23], severity: 'URGENT' },
  RESERVATION_CONFLICT: { kind: 'STOCK_EXCEPTION', cases: [11, 24], severity: 'REVIEW' },
  TEMPERATURE_EXCURSION: { kind: 'STOCK_EXCEPTION', cases: [25], severity: 'URGENT' },
  TRANSFER_VARIANCE: { kind: 'STOCK_EXCEPTION', cases: [20], severity: 'REVIEW' },
  BALANCE_DRIFT: { kind: 'AUDIT_INTEGRITY', cases: [15], severity: 'URGENT' },
};

export function stockException(row: StockExceptionRow): ExceptionDraft {
  const known = STOCK_EXCEPTION_KIND[row.kind] ?? { kind: 'STOCK_EXCEPTION' as const, cases: [11], severity: 'REVIEW' as const };
  return {
    sourceKey: `stock-exception:${row.id}`,
    kind: known.kind,
    sourceKind: row.kind,
    severity: known.severity,
    abuseCases: [...known.cases],
    branchId: row.branchId,
    actorId: row.actorId,
    subject: row.sourceDocumentId === null ? { id: row.id, docType: 'STOCK_EXCEPTION' } : { id: row.sourceDocumentId, docType: 'STOCK_EXCEPTION' },
    amountPesewas: null,
    summary: `${row.kind.toLowerCase().replaceAll('_', ' ')} raised${row.qty === null ? '' : ` for ${row.qty}`}${row.status === 'RESOLVED' ? ', since resolved' : ''}`,
    details: { stockExceptionId: row.id, productId: row.productId, stockUnitId: row.stockUnitId, locationId: row.locationId, movementId: row.movementId, qty: row.qty, status: row.status },
    raisedAt: row.raisedAt,
    restrictedTo: null,
  };
}

/** One run of PUR's order splitting rule (`PurchaseOrders.splitSuspectsIn`, A-168, abuse case 27). */
export interface SplitSuspectRow {
  readonly supplierId: string;
  readonly makerId: string;
  readonly orderIds: readonly string[];
  readonly totalPesewas: bigint;
  readonly firstAt: Date;
  readonly lastAt: Date;
}

export function orderSplitting(row: SplitSuspectRow, headOfficeBranchId: string | null): ExceptionDraft {
  const orders = [...row.orderIds].sort();
  return {
    sourceKey: `split:${row.makerId}:${row.supplierId}:${orders.join(',')}`,
    kind: 'ORDER_SPLITTING',
    sourceKind: null,
    severity: 'REVIEW',
    abuseCases: [27],
    branchId: headOfficeBranchId,
    actorId: row.makerId,
    subject: { id: orders[0]!, docType: 'PURCHASE_ORDER' },
    amountPesewas: row.totalPesewas,
    summary: `${orders.length} purchase orders to one supplier by one person within 7 days, each just under the approval limit, ${formatCedis(row.totalPesewas)} together`,
    details: { supplierId: row.supplierId, makerId: row.makerId, orderIds: orders, totalPesewas: Number(row.totalPesewas), firstAt: row.firstAt.toISOString(), lastAt: row.lastAt.toISOString() },
    raisedAt: row.lastAt,
    restrictedTo: null,
  };
}
