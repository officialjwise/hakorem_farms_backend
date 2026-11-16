import { createHash } from 'node:crypto';
import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import type { PeriodFacts } from '../domain/period';
import { judgeClose, judgeLock, judgeReopen } from '../domain/period-lifecycle';
import type { ChartStore, PeriodRow, ReopenRow } from './chart-store';
import { PeriodStateError } from './errors';
import { LAST_PERIOD_NO, type YearClose } from './year-close';

export const LOCK_ACCOUNTING_PERIOD = 'lockAccountingPeriod';
export const CLOSE_ACCOUNTING_PERIOD = 'closeAccountingPeriod';
export const REOPEN_ACCOUNTING_PERIOD = 'reopenAccountingPeriod';
export const PERIOD_REOPEN = 'PERIOD_REOPEN';
const READ = 'fin.period.read';
const LOCK = 'fin.period.lock';
const CLOSE = 'fin.period.close';
const REOPEN = 'fin.period.reopen';

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/** The contract's `AccountingPeriod`. */
export interface AccountingPeriodView {
  readonly id: string;
  readonly fiscalYear: number;
  readonly periodNo: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: PeriodFacts['status'];
  readonly lockedAt: string | null;
  readonly lockedBy: PrincipalRef | null;
  readonly closedAt: string | null;
  readonly closedBy: PrincipalRef | null;
  readonly version: number;
}

/** The contract's `ApprovalPending`, for a reopen waiting on its checker. */
export interface ReopenPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: typeof PERIOD_REOPEN;
  readonly subject: { readonly id: string; readonly docType: 'PERIOD_REOPEN'; readonly number: null };
  readonly summary: string;
  readonly requestedAt: string;
}

/**
 * Accounting periods (FR-FIN-009, FR-FIN-010, A-188): an open period is locked against posting, a locked one that has
 * ended is closed for good once every earlier one is, and a locked one is reopened only when the Owner asks with a
 * reason and a different person approves (PERIOD_REOPEN, ADR-0017). Lock and close run at serializable isolation and
 * write the period row every posting reads FOR SHARE, so a posting racing them fails and retries into the new state
 * (ADR-0005). The database holds the lifecycle and the close order too (0126). Every change is audited.
 */
export class Periods implements ApprovalHandler {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ChartStore,
    private readonly authoriser: Authoriser,
    private readonly approvals: Approvals,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly documents: DocumentRegistry,
    private readonly refs: MasterDataRefs,
    private readonly names: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly yearClose: YearClose,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, query: { readonly fiscalYear?: number | undefined; readonly status?: PeriodFacts['status'] | undefined }, cursor: string | undefined, limit: number): Promise<Page<AccountingPeriodView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const filters = { fiscalYear: query.fiscalYear ?? null, status: query.status ?? null };
      const binding = { operationId: 'listAccountingPeriods', principalId: actor!.principalId, filters };
      const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['startDate'] ?? null);
      const found = await this.store.periods(tx, filters, before, limit + 1);
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      return { data: await this.views(tx, rows), page: { nextCursor: hasMore ? this.cursors.encode(binding, { startDate: rows.at(-1)!.startDate }) : null, limit, hasMore } };
    });
  }

  lock(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<AccountingPeriodView>> {
    return this.change(actor, LOCK, LOCK_ACCOUNTING_PERIOD, 'LOCK', id, idempotencyKey, async (tx, period) => {
      const verdict = judgeLock(period);
      if (!verdict.ok) throw new PeriodStateError('lock', verdict.error);
      await this.store.lockPeriod(tx, id, actor!.principalId, this.clock.now());
    });
  }

  close(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<AccountingPeriodView>> {
    return this.change(actor, CLOSE, CLOSE_ACCOUNTING_PERIOD, 'CLOSE', id, idempotencyKey, async (tx, period) => {
      const verdict = judgeClose(period, await this.store.allPeriods(tx), toBusinessDate(this.clock.now()));
      if (!verdict.ok) throw new PeriodStateError('close', verdict.error);
      // The last period closes the year (FR-FIN-010): its CLOSING entries post while it is still LOCKED, then it closes.
      if (period.periodNo === LAST_PERIOD_NO) await this.yearClose.closeIn(tx, period, actor!.principalId);
      await this.store.closePeriod(tx, id, actor!.principalId, this.clock.now());
    });
  }

  /** The Owner asks to reopen a locked period, with a reason: 202, and nothing changes until someone else approves. */
  requestReopen(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<ReopenPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, REOPEN);
      const claim = await this.idempotency.claim(tx, { operationId: REOPEN_ACCOUNTING_PERIOD, principalId: actor!.principalId, key: idempotencyKey, request: { id, reason } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ReopenPendingView>;
      const period = await this.store.period(tx, id, true);
      if (period === null) throw new NotFoundError(`no accounting period ${id}`);
      const verdict = judgeReopen(period);
      if (!verdict.ok) throw new PeriodStateError('reopen', verdict.error);
      if ((await this.store.pendingReopenOf(tx, id)) !== null) throw new PeriodStateError('reopen', 'REOPEN_PENDING');
      const branchId = await this.refs.headOfficeBranchIn(tx);
      if (branchId === null) throw new Error('no active branch to hold the reopen request');
      const reopenId = this.nextId();
      await this.documents.register(tx, { id: reopenId, docType: PERIOD_REOPEN, ownerModule: 'fin', branchId, actorId: actor!.principalId });
      const summary = `Reopen accounting period ${label(period)}: ${reason.trim()}`;
      const request = await this.approvals.request(tx, actor, { kind: PERIOD_REOPEN, branchId, subjectDocumentId: reopenId, payloadHash: reopenHash(period, reason.trim()), summary });
      await this.store.insertReopen(tx, { id: reopenId, periodId: id, branchId, reason: reason.trim(), status: 'PENDING_APPROVAL', approvalRequestId: request.id, createdBy: actor!.principalId, version: 1 });
      await this.audit.record(tx, {
        module: 'fin',
        action: 'REQUEST_REOPEN',
        entityType: 'AccountingPeriod',
        entityId: id,
        branchId,
        before: { status: period.status, version: period.version },
        after: { status: period.status, reopenRequestId: reopenId, approvalRequestId: request.id, reason: reason.trim() },
      });
      const body: ReopenPendingView = {
        status: 'PENDING_APPROVAL',
        approvalRequestId: request.id,
        kind: PERIOD_REOPEN,
        subject: { id: reopenId, docType: PERIOD_REOPEN, number: null },
        summary,
        requestedAt: request.requestedAt.toISOString(),
      };
      const response = { status: 202, body };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** ApprovalHandler: the reopen asked for and the period as it stands; a period that moved since voids the approval. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const reopen = await this.reopenOf(tx, subjectDocumentId, false);
    const period = (await this.store.period(tx, reopen.periodId, false))!;
    return reopenHash(period, reopen.reason);
  }

  /** ApprovalHandler: reopens the period in the approval's transaction, as the checker who let it happen. */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const reopen = await this.reopenOf(tx, request.subjectDocumentId, true);
    const period = (await this.store.period(tx, reopen.periodId, true))!;
    const verdict = judgeReopen(period);
    if (!verdict.ok) throw new PeriodStateError('reopen', verdict.error);
    const now = this.clock.now();
    await this.store.reopenPeriod(tx, period.id, request.decidedBy!);
    await this.store.decideReopen(tx, reopen.id, 'POSTED', request.decidedBy!, now);
    await this.audit.record(tx, {
      module: 'fin',
      action: 'REOPEN',
      entityType: 'AccountingPeriod',
      entityId: period.id,
      branchId: reopen.branchId,
      before: { status: period.status, lockedAt: period.lockedAt?.toISOString() ?? null, lockedBy: period.lockedBy, version: period.version },
      after: { status: 'OPEN', lockedAt: null, lockedBy: null, version: period.version + 1 },
      metadata: { approvalRequestId: request.id, reopenRequestId: reopen.id, requestedBy: reopen.createdBy, reason: reopen.reason },
    });
  }

  /** ApprovalHandler: a rejected or cancelled reopen is final; the period stays locked. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const reopen = await this.reopenOf(tx, request.subjectDocumentId, true);
    const decidedBy = request.decidedBy ?? request.requestedBy;
    await this.store.decideReopen(tx, reopen.id, 'REJECTED', decidedBy, this.clock.now());
    await this.audit.record(tx, {
      module: 'fin',
      action: 'REJECT_REOPEN',
      entityType: 'AccountingPeriod',
      entityId: reopen.periodId,
      branchId: reopen.branchId,
      before: { reopenStatus: reopen.status },
      after: { reopenStatus: 'REJECTED' },
      metadata: { approvalRequestId: request.id, reopenRequestId: reopen.id },
    });
  }

  private change(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    action: 'LOCK' | 'CLOSE',
    id: string,
    idempotencyKey: string,
    apply: (tx: Transaction, period: PeriodRow) => Promise<void>,
  ): Promise<StoredResponse<AccountingPeriodView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<AccountingPeriodView>;
      const before = await this.store.period(tx, id, true);
      if (before === null) throw new NotFoundError(`no accounting period ${id}`);
      await apply(tx, before);
      const after = (await this.store.period(tx, id, false))!;
      await this.audit.record(tx, {
        module: 'fin',
        action,
        entityType: 'AccountingPeriod',
        entityId: id,
        branchId: null,
        before: { status: before.status, version: before.version },
        after: { status: after.status, version: after.version },
      });
      const [view] = await this.views(tx, [after]);
      const response = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private async reopenOf(tx: Transaction, id: string, forUpdate: boolean): Promise<ReopenRow> {
    const reopen = await this.store.reopenRequest(tx, id, forUpdate);
    if (reopen === null) throw new NotFoundError(`no period reopen request ${id}`);
    return reopen;
  }

  private async views(tx: Transaction, rows: readonly PeriodRow[]): Promise<AccountingPeriodView[]> {
    const people = await this.names.refs(tx, [...new Set(rows.flatMap((r) => [r.lockedBy, r.closedBy]).filter((p): p is string => p !== null))]);
    const person = (id: string | null): PrincipalRef | null => (id === null ? null : (people.get(id) ?? null));
    return rows.map((r) => ({
      id: r.id,
      fiscalYear: r.fiscalYear,
      periodNo: r.periodNo,
      startDate: r.startDate,
      endDate: r.endDate,
      status: r.status,
      lockedAt: r.lockedAt?.toISOString() ?? null,
      lockedBy: person(r.lockedBy),
      closedAt: r.closedAt?.toISOString() ?? null,
      closedBy: person(r.closedBy),
      version: r.version,
    }));
  }
}

function label(period: PeriodRow): string {
  return `${period.fiscalYear}-${String(period.periodNo).padStart(2, '0')}`;
}

/** What the checker approves: this period, in this state and version, reopened for this reason. */
function reopenHash(period: PeriodRow, reason: string): string {
  return createHash('sha256').update(canonicalJson({ periodId: period.id, status: period.status, version: period.version, reason })).digest('hex');
}
