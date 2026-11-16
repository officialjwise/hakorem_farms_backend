import { createHash } from 'node:crypto';
import { createUuidV7Generator, formatCedis, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { judgeResolution, type ResolvableBreak, type ResolutionPosting } from '../domain/reconciliation';
import { jsonPesewas as json } from '../domain/tender';
import type { BreakResolutionRequested, UnidentifiedReceiptHeld } from '../events';
import { ReconciliationInvalidError } from './errors';
import { UNIDENTIFIED_RECEIPT_HELD, type Page } from './payments';
import type { BreakRecord, ReconciliationStore, ResolutionRecord } from './reconciliation-store';
import type { ApprovalPendingView } from './refunds';

export const RECONCILIATION_BREAK_KIND = 'RECONCILIATION_BREAK';
export const BREAK_RESOLUTION_REQUESTED = 'pay.BreakResolutionRequested';
const READ = 'pay.reconciliation.read';
const MANAGE = 'pay.reconciliation.manage';
const SYSTEM_ACTOR_ID = '01900000-0000-7000-8000-000000000001';

/** The contract's `ReconciliationBreak`. */
export interface ReconciliationBreakView {
  readonly id: string;
  readonly kind: string;
  readonly branchId: string;
  readonly payment: { readonly id: string; readonly paymentNo: string | null } | null;
  readonly sourceDocument: { readonly id: string; readonly docType: string; readonly number: string | null } | null;
  readonly amountPesewas: number | null;
  readonly currency: 'GHS';
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly raisedAt: string;
  readonly status: 'OPEN' | 'RESOLVED';
  readonly resolvedBy: { readonly id: string; readonly displayName: string } | null;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
}

/**
 * The reconciliation break queue (FR-PAY-017, ADR-0065): every break is listed with its kind, the records on each side
 * and its age, and is resolved only through a second person: a resolution is asked for with a note (and, for money
 * from a payer nobody can name, the posting that holds it in 2290), and takes effect only when a different holder of
 * `pay.reconciliation.approve` approves it with a fresh step-up. A break never resolves itself; a failed refund's break
 * closes when its refund is paid (ADR-0063).
 */
export class BreakQueue {
  private readonly nextId: () => string;

  constructor(
    private readonly store: ReconciliationStore,
    private readonly refs: MasterDataRefs,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly uow: UnitOfWork,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly approvals: Approvals,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, query: { readonly status: 'OPEN' | 'RESOLVED' | null; readonly kind: string | null }, cursor: string | undefined, limit: number): Promise<Page<ReconciliationBreakView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: 'listReconciliationBreaks', principalId: actor!.principalId, filters: query };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after = position === null ? null : { raisedAt: new Date(position['raisedAt'] as string), id: position['id'] as string };
      const headOffice = await this.refs.headOfficeBranchIn(tx);
      const found = await this.store.breaks(tx, { ...query, branchIds: await this.branches(tx, actor!), headOfficeBranchId: headOffice }, after, limit + 1);
      const rows = found.slice(0, limit);
      const last = rows.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.views(tx, rows, headOffice), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { raisedAt: last.raisedAt.toISOString(), id: last.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<ReconciliationBreakView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const found = await this.store.break(tx, id, false);
      const headOffice = await this.refs.headOfficeBranchIn(tx);
      if (found === null || !(await this.branches(tx, actor!)).includes(found.branchId ?? headOffice ?? '')) throw new NotFoundError('no such reconciliation break');
      return (await this.views(tx, [found], headOffice))[0]!;
    });
  }

  /**
   * `resolveReconciliationBreak`: always 202. The resolution waits for a different holder of
   * `pay.reconciliation.approve` with a fresh step-up (`RECONCILIATION_BREAK`, threshold 0); approved, the break is
   * RESOLVED with the note, by its approver, and an `UNIDENTIFIED_RECEIPT` posts ◆ `pay.UnidentifiedReceiptHeld`.
   */
  resolve(actor: Actor | undefined, id: string, body: { readonly note: string; readonly posting: ResolutionPosting }, key: string): Promise<StoredResponse<ApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: 'resolveReconciliationBreak', principalId: actor!.principalId, key, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ApprovalPendingView>;
      const found = await this.store.break(tx, id, true);
      const headOffice = await this.refs.headOfficeBranchIn(tx);
      if (found === null) throw new NotFoundError('no such reconciliation break');
      const branchId = found.branchId ?? headOffice!;
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId });
      const judged = judgeResolution(await this.resolvable(tx, found), body.posting, body.note);
      const broken: { field: string; rule: string }[] = judged.ok ? [] : judged.error.map((rule) => ({ field: rule === 'NOTE_REQUIRED' ? '/note' : rule === 'BREAK_NOT_OPEN' ? '' : '/posting', rule }));
      if ((await this.store.openResolutionOf(tx, id)) !== null) broken.push({ field: '', rule: 'RESOLUTION_PENDING' });
      if (broken.length > 0) throw new ReconciliationInvalidError(broken);

      const resolutionId = this.nextId();
      const note = body.note.trim();
      await this.documents.register(tx, { id: resolutionId, docType: 'BREAK_RESOLUTION', ownerModule: 'pay', branchId, actorId: actor!.principalId });
      await this.store.insertResolution(tx, { id: resolutionId, breakId: id, posting: body.posting, note, branchId, createdBy: actor!.principalId });
      const resolution = (await this.store.openResolutionOf(tx, id))!;
      const summary = `Resolve ${found.kind.toLowerCase().replaceAll('_', ' ')}${found.amountPesewas === null ? '' : ` of ${formatCedis(found.amountPesewas)}`}${body.posting === 'UNIDENTIFIED_RECEIPT' ? ', held in suspense' : ''}`;
      const approval = await this.approvals.request(tx, actor, { kind: RECONCILIATION_BREAK_KIND, branchId, subjectDocumentId: resolutionId, payloadHash: resolutionHash(found, resolution), amountPesewas: found.amountPesewas ?? 0n, summary });
      await this.store.updateResolution(tx, resolutionId, { approvalRequestId: approval.id }, actor!.principalId);
      const requested: BreakResolutionRequested = {
        resolutionId,
        breakId: id,
        kind: found.kind,
        branchId,
        posting: body.posting,
        amountPesewas: found.amountPesewas === null ? null : json(found.amountPesewas),
        approvalRequestId: approval.id,
        requestedBy: actor!.principalId,
      };
      await this.events.publish(tx, { type: BREAK_RESOLUTION_REQUESTED, subjectType: 'ReconciliationBreak', subjectId: id, branchId, payload: requested });
      await this.audit.record(tx, { module: 'pay', action: 'SUBMIT', entityType: 'BreakResolution', entityId: resolutionId, branchId, before: null, after: { breakId: id, posting: body.posting, note, approvalRequestId: approval.id } });
      const response = {
        status: 202,
        body: { status: 'PENDING_APPROVAL' as const, approvalRequestId: approval.id, kind: RECONCILIATION_BREAK_KIND, subject: { id: resolutionId, docType: 'BREAK_RESOLUTION', number: null }, summary, requestedAt: approval.requestedAt.toISOString() },
      };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** IAM's handler for `RECONCILIATION_BREAK`: the approved resolution takes effect in the approval's transaction. */
  readonly approvalHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, subjectDocumentId) => {
      const resolution = await this.store.resolution(tx, subjectDocumentId);
      const found = resolution === null ? null : await this.store.break(tx, resolution.breakId, false);
      if (resolution === null || found === null) throw new NotFoundError('no such break resolution');
      return resolutionHash(found, resolution);
    },
    onApproved: async (tx: Transaction, request: ApprovalRecord) => {
      const resolution = await this.store.resolutionByApproval(tx, request.id);
      if (resolution?.status !== 'PENDING_APPROVAL') throw new NotFoundError('no such break resolution');
      const found = (await this.store.break(tx, resolution.breakId, true))!;
      const judged = judgeResolution(await this.resolvable(tx, found), resolution.posting, resolution.note);
      if (!judged.ok) throw new ReconciliationInvalidError(judged.error.map((rule) => ({ field: '', rule })));
      const decider = request.decidedBy ?? SYSTEM_ACTOR_ID;
      await this.store.updateResolution(tx, resolution.id, { status: 'APPROVED' }, decider);
      if (resolution.posting === 'UNIDENTIFIED_RECEIPT') await this.holdInSuspense(tx, found, resolution, request.id);
      await this.store.resolveBreak(tx, found.id, resolution.note, this.clock.now(), decider);
      await this.audit.record(tx, { module: 'pay', action: 'RESOLVE', entityType: 'ReconciliationBreak', entityId: found.id, branchId: resolution.branchId, before: { status: 'OPEN' }, after: { status: 'RESOLVED', posting: resolution.posting, note: resolution.note, approvalRequestId: request.id } });
    },
    onRejected: async (tx: Transaction, request: ApprovalRecord) => {
      const resolution = await this.store.resolutionByApproval(tx, request.id);
      if (resolution?.status !== 'PENDING_APPROVAL') return;
      await this.store.updateResolution(tx, resolution.id, { status: 'REJECTED' }, request.decidedBy ?? SYSTEM_ACTOR_ID);
      await this.audit.record(tx, { module: 'pay', action: 'REJECT', entityType: 'BreakResolution', entityId: resolution.id, branchId: resolution.branchId, before: { status: resolution.status }, after: { status: 'REJECTED', approvalRequestId: request.id } });
    },
  };

  /** ◆ `pay.UnidentifiedReceiptHeld`: what reached the bank from the line, its provider fee, and the whole in 2290. */
  private async holdInSuspense(tx: Transaction, found: BreakRecord, resolution: ResolutionRecord, approvalRequestId: string): Promise<void> {
    if (found.settlementLineId !== null) {
      const line = (await this.store.settlementLine(tx, found.settlementLineId))!;
      const report = (await this.store.settlement(tx, line.settlementReportId, false))!;
      await this.publishHeld(tx, { breakId: found.id, lineId: line.id, sourceDocumentId: report.id, branchId: resolution.branchId, bankAccountId: report.bankAccountId, amountPesewas: json(line.amountPesewas), feePesewas: json(line.feePesewas), approvalRequestId });
      return;
    }
    const line = (await this.store.statementLine(tx, found.bankStatementLineId!, false))!;
    await this.publishHeld(tx, { breakId: found.id, lineId: line.id, sourceDocumentId: line.bankStatementId, branchId: resolution.branchId, bankAccountId: line.bankAccountId, amountPesewas: json(line.amountPesewas), feePesewas: 0, approvalRequestId });
  }

  private async publishHeld(tx: Transaction, payload: UnidentifiedReceiptHeld): Promise<void> {
    await this.events.publish(tx, { type: UNIDENTIFIED_RECEIPT_HELD, subjectType: 'ReconciliationBreak', subjectId: payload.breakId, branchId: payload.branchId, payload });
  }

  /** A break with the line it was raised for, as its resolution is judged on. */
  private async resolvable(tx: Transaction, b: BreakRecord): Promise<ResolvableBreak> {
    if (b.settlementLineId !== null) {
      const line = (await this.store.settlementLine(tx, b.settlementLineId))!;
      return { status: b.status, kind: b.kind, line: { source: 'SETTLEMENT', reason: line.matchReason, direction: 'IN', matched: line.matchStatus === 'MATCHED' } };
    }
    if (b.bankStatementLineId !== null) {
      const line = (await this.store.statementLine(tx, b.bankStatementLineId, false))!;
      return { status: b.status, kind: b.kind, line: { source: 'BANK', reason: null, direction: line.direction, matched: line.matchStatus === 'MATCHED' } };
    }
    return { status: b.status, kind: b.kind, line: null };
  }

  private async branches(tx: Transaction, actor: Actor): Promise<string[]> {
    return [...new Set((await this.authoriser.scopes(tx, actor, READ)).map((s) => s.branchId))];
  }

  private async views(tx: Transaction, rows: readonly BreakRecord[], headOffice: string | null): Promise<ReconciliationBreakView[]> {
    const sources = await this.documents.numberedRefs(tx, rows.flatMap((r) => (r.sourceDocumentId === null ? [] : [r.sourceDocumentId])));
    const names = await this.principals.refs(tx, rows.flatMap((r) => (r.resolvedBy === null ? [] : [r.resolvedBy])));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      branchId: r.branchId ?? headOffice!,
      payment: r.paymentId === null ? null : { id: r.paymentId, paymentNo: r.paymentNo },
      sourceDocument: r.sourceDocumentId === null ? null : (sources.get(r.sourceDocumentId) ?? { id: r.sourceDocumentId, docType: 'UNKNOWN', number: null }),
      amountPesewas: r.amountPesewas === null ? null : json(r.amountPesewas),
      currency: 'GHS',
      summary: summaryOf(r),
      details: r.details,
      raisedAt: r.raisedAt.toISOString(),
      status: r.status,
      resolvedBy: r.resolvedBy === null ? null : (names.get(r.resolvedBy) ?? { id: r.resolvedBy, displayName: r.resolvedBy }),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolutionNote: r.resolutionNote,
    }));
  }
}

const SUMMARIES: Readonly<Record<string, string>> = {
  UNMATCHED_PAYMENT: 'Money received with no order or customer to apply it to',
  UNVERIFIED_PAYMENT: 'An offline mobile money tender not yet confirmed by the provider',
  PROVIDER_AMOUNT_DIFFERS: 'The provider holds a different amount than was asked for',
  PROVIDER_REFERENCE_UNKNOWN: 'The provider holds a payment under a reference this system never created',
  PROVIDER_PAYMENT_MISSING: 'A charge the provider has no record of',
  SETTLEMENT_AMOUNT_DIFFERS: 'Settled by the provider at a different amount than the payment recorded',
  SETTLEMENT_NOT_FOUND: 'Settled by the provider but no cleared payment of ours carries the reference',
  BANK_LINE_UNMATCHED: 'A bank statement line nothing in the system matches',
  LEDGER_CASH_DIFFERS: 'Cash per the ledger differs from a count or a statement',
  REFUND_FAILED: 'A refund the provider did not complete',
};

function summaryOf(r: BreakRecord): string {
  const base = SUMMARIES[r.kind] ?? r.kind;
  return r.reference === null ? base : `${base} (${r.provider === null ? '' : `${r.provider} `}${r.reference})`;
}

/** What a resolution's approval binds to: the break as it stands and what was asked; a change in between voids it. */
function resolutionHash(b: BreakRecord, r: ResolutionRecord): string {
  return createHash('sha256')
    .update(canonicalJson({ resolutionId: r.id, breakId: b.id, status: b.status, kind: b.kind, amountPesewas: b.amountPesewas?.toString() ?? null, posting: r.posting, note: r.note }), 'utf8')
    .digest('hex');
}
