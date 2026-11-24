import { createHash } from 'node:crypto';
import { createUuidV7Generator, formatCedis, Money, Rate, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { AsyncConsumer, DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { DOCUMENT_ARCHIVED, DocumentNotArchivedError, type DocumentArchived, type Documents } from '../../doc';
import type { BankAccounts, FinancialStatements, Journals, Periods } from '../../fin';
import type { ApprovalHandler, ApprovalRecord, Approvals } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import {
  DAY_COUNT_CONVENTION,
  allocateDistribution,
  daysInPeriod,
  distributableProfit,
  formatUnits,
  judgeDistributionPayment,
  judgeRunAction,
  unitDaysByInvestor,
  type RunAction,
  type RunStatus,
} from '../domain/distribution';
import type { DistributionDeclared, DistributionPaid } from '../events';
import { daysCovered, nextComputation, probe } from './counting';
import type { CapStore, InvestorRecord, LineRecord, RunFigures, RunRecord } from './cap-store';
import { investorRef, movementOf, type ApprovalPendingView, type Capital, type InvestorRefView, type Page } from './capital';
import { DistributionPaymentInvalidError, DistributionRunInvalidError, MakerCannotCheckError, PaymentReferenceTakenError, type CapRule } from './errors';

export const DISTRIBUTION_READ = 'cap.distribution.read';
export const DISTRIBUTION_CREATE = 'cap.distribution.create';
export const DISTRIBUTION_POST = 'cap.distribution.post';
export const DISTRIBUTION_PAY = 'cap.distribution.pay';
export const DISTRIBUTION_RUN = 'DISTRIBUTION_RUN';
export const INVESTOR_DISTRIBUTION = 'INVESTOR_DISTRIBUTION';
/** ◆ CAP's ledger events (ADR-0003, migration 0354). */
export const DISTRIBUTION_DECLARED = 'cap.DistributionDeclared';
export const DISTRIBUTION_PAID = 'cap.DistributionPaid';
/** The owner's retention rate when a run names none (ADR-0028: 40 percent, snapshotted on the run). */
export const DEFAULT_RETENTION_PERCENT = '40';
/** Tax withheld on distributions: zero until the accountant confirms a rate (A-030). */
export const WITHHOLDING_PERCENT = '0';

/** The contract's `DistributionLine`. */
export interface DistributionLineView {
  readonly id: string;
  readonly investor: InvestorRefView;
  readonly unitDays: string;
  readonly allocatedPesewas: number;
  readonly receivedExtraPesewa: boolean;
  readonly withheldPesewas: number;
  readonly netPayablePesewas: number;
  readonly paidPesewas: number;
}

/** The contract's `DistributionRun`. */
export interface DistributionRunView {
  readonly id: string;
  readonly runNo: string;
  readonly status: RunStatus;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly daysInPeriod: number;
  readonly netProfitPesewas: number;
  readonly isLoss: boolean;
  readonly retentionRatePercent: string;
  readonly retainedPesewas: number;
  readonly distributablePesewas: number;
  readonly allocationMethod: 'UNIT_DAYS';
  readonly dayCountConvention: string;
  readonly totalUnitDays: string;
  readonly withholdingRatePercent: string;
  readonly approvalRequestId: string | null;
  readonly scheduleDocumentId: string | null;
  readonly lines: DistributionLineView[];
  readonly paidPesewas: number;
  readonly currency: 'GHS';
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
}

export interface DistributionPaymentCreate {
  readonly amountPesewas: bigint;
  readonly bankAccountId: string;
  readonly externalReference?: string | undefined;
  readonly paidAt?: string | undefined;
}

const json = (n: bigint): number => Money.ofPesewas(n).toJsonInteger();
/** A percentage as the run keeps it, at least two places ("40.00"). */
const percentText = (rate: Rate): string => {
  const [whole, fraction = ''] = rate.toPercentString().split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
};

/** What the approver approves: the run and every line of its computation, so anything else voids the approval. */
const runHash = (run: RunRecord, lines: readonly LineRecord[]) =>
  createHash('sha256')
    .update(
      canonicalJson({
        id: run.id,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        computationNo: run.computationNo,
        distributablePesewas: run.distributablePesewas.toString(),
        lines: lines.map((l) => ({ investorId: l.investorId, unitDays: formatUnits(l.unitDaysE4), allocated: l.allocatedPesewas.toString(), netPayable: l.netPayablePesewas.toString() })),
      }),
      'utf8',
    )
    .digest('hex');

/**
 * Profit distribution runs (FR-CAP-006 to FR-CAP-012, ADR-0028). A run covers only locked or closed accounting periods;
 * its net profit is the ledger's for the period; the retention rate (40 percent unless the run names another) is
 * snapshotted and `half_up` once; the rest is allocated by unit-days with largest remainder through the kernel's
 * `allocate`, ties to the lower investor number, and no unit-days at all is refused (never an equal split). Draft
 * (recomputed in place), submitted for approval with its schedule rendered and archived by DOC after commit, approved by
 * someone other than its maker holding `cap.distribution.approve` with step-up (IAM's `INVESTOR_DISTRIBUTION`; a
 * submitted run is never edited, A-382), posted once (◆ `cap.DistributionDeclared`: Dr 3300 and Cr 2300 per investor,
 * Cr 2310 withheld), then paid line by line (◆ `cap.DistributionPaid`: Dr 2300, Cr the bank), never above net payable.
 * The database holds the lifecycle, the checker, the allocation's sum and the payment cap as well. Kept at the head
 * office branch like the rest of the investor books; every step is audited.
 */
export class Distributions {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: CapStore,
    private readonly capital: Capital,
    private readonly statements: FinancialStatements,
    private readonly periods: Periods,
    private readonly journals: Journals,
    private readonly bankAccounts: BankAccounts,
    private readonly archive: Documents,
    private readonly refs: MasterDataRefs,
    private readonly registry: DocumentRegistry,
    private readonly numbers: NumberSeries,
    private readonly approvals: Approvals,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filter: { readonly status: RunStatus | null }, cursor: string | undefined, limit: number): Promise<Page<DistributionRunView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const branchId = await this.capital.authoriseIn(tx, actor, DISTRIBUTION_READ);
      const binding = { operationId: 'listDistributionRuns', principalId: actor!.principalId, filters: filter };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after = position === null ? null : { key: position['periodStart']!, id: position['id']! };
      const found = await this.store.runs(tx, { status: filter.status, branchIds: [branchId] }, after, probe(limit));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      const last = rows.at(-1);
      return { data: await this.views(tx, rows), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { periodStart: last.periodStart, id: last.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<DistributionRunView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const run = await this.authorisedRunIn(tx, actor, DISTRIBUTION_READ, id, false);
      return (await this.views(tx, [run]))[0]!;
    });
  }

  /** createDistributionRun: a numbered draft for a period of locked or closed accounting periods, computed now. */
  create(actor: Actor | undefined, request: { readonly periodStart: string; readonly periodEnd: string; readonly retentionRatePercent?: string | undefined }, key: string): Promise<StoredResponse<DistributionRunView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const branchId = await this.capital.authoriseIn(tx, actor, DISTRIBUTION_CREATE);
      const claim = await this.idempotency.claim(tx, { operationId: 'createDistributionRun', principalId: actor!.principalId, key, request });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<DistributionRunView>;
      const period = { start: request.periodStart, end: request.periodEnd };
      await this.checkPeriodIn(tx, period, null);
      const retention = Rate.parsePercent(request.retentionRatePercent ?? DEFAULT_RETENTION_PERCENT);
      const id = this.nextId();
      const at = this.clock.now();
      const { figures, lines } = await this.computeIn(tx, id, period, retention, 1, at);
      const branch = (await this.refs.branchesIn(tx, [branchId])).get(branchId)!;
      await this.registry.register(tx, { id, docType: DISTRIBUTION_RUN, ownerModule: 'cap', branchId, actorId: actor!.principalId });
      const runNo = await this.numbers.allocateIn(tx, { docType: DISTRIBUTION_RUN, fiscalYear: Number(toBusinessDate(at).slice(0, 4)), branchId, branchCode: branch.code, documentId: id });
      const run: RunRecord = {
        ...figures,
        id,
        runNo,
        periodStart: period.start,
        periodEnd: period.end,
        daysInPeriod: daysInPeriod(period),
        dayCountConvention: DAY_COUNT_CONVENTION,
        approvalRequestId: null,
        approvedBy: null,
        approvedAt: null,
        scheduleDocumentId: null,
        journalEntryId: null,
        paidPesewas: 0n,
        status: 'DRAFT',
        branchId,
        version: 1,
        createdAt: at,
        createdBy: actor!.principalId,
        postedBy: null,
      };
      await this.store.insertRun(tx, run);
      await this.store.insertLines(tx, lines, at);
      const view = (await this.views(tx, [run]))[0]!;
      await this.audit.record(tx, { module: 'cap', action: 'CREATE', entityType: 'DistributionRun', entityId: id, branchId, before: null, after: { ...view } });
      const response: StoredResponse<DistributionRunView> = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** recomputeDistributionRun: a draft's figures and lines from the ledger and the register as they stand now (a new computation; the old is kept). */
  recompute(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<DistributionRunView>> {
    return this.step(actor, 'recomputeDistributionRun', DISTRIBUTION_CREATE, 'RECOMPUTE', id, key, async (tx, run) => {
      const period = { start: run.periodStart, end: run.periodEnd };
      await this.checkPeriodIn(tx, period, run.id);
      const { figures, lines } = await this.computeIn(tx, run.id, period, Rate.parsePercent(run.retentionRatePercent), nextComputation(run.computationNo), this.clock.now());
      await this.store.recomputeRun(tx, run.id, figures, actor!.principalId);
      await this.store.insertLines(tx, lines, figures.computedAt);
      return 200;
    });
  }

  /**
   * submitDistributionRun: 202 with the approval it waits for; the schedule is rendered and archived after commit. The
   * maker's own approval is refused by IAM (and by the database); the approver needs a fresh step-up.
   */
  submit(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<ApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.capital.authoriseIn(tx, actor, DISTRIBUTION_CREATE);
      const claim = await this.idempotency.claim(tx, { operationId: 'submitDistributionRun', principalId: actor!.principalId, key, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ApprovalPendingView>;
      const run = await this.authorisedRunIn(tx, actor, DISTRIBUTION_CREATE, id, true);
      this.judge('SUBMIT', run);
      const lines = (await this.store.linesOf(tx, [id])).get(id)!;
      const summary = `Distribute ${formatCedis(run.distributablePesewas)} of the profit for ${run.periodStart} to ${run.periodEnd} to ${lines.length} investors (${run.runNo})`;
      const approval = await this.approvals.request(tx, actor, {
        kind: INVESTOR_DISTRIBUTION,
        branchId: run.branchId,
        subjectDocumentId: run.id,
        payloadHash: runHash(run, lines),
        amountPesewas: run.distributablePesewas,
        summary,
      });
      await this.store.submitRun(tx, id, approval.id, actor!.principalId);
      const investors = await this.store.investorsIn(tx, lines.map((l) => l.investorId));
      const branch = (await this.refs.branchesIn(tx, [run.branchId])).get(run.branchId)!;
      await this.archive.requestRenderIn(tx, {
        businessDocumentId: run.id,
        docType: DISTRIBUTION_RUN,
        documentNo: run.runNo,
        branchId: run.branchId,
        renderData: {
          title: 'Distribution schedule',
          runNo: run.runNo,
          branch: { code: branch.code, name: branch.name },
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          daysInPeriod: run.daysInPeriod,
          submittedOn: toBusinessDate(this.clock.now()),
          netProfit: formatCedis(run.netProfitPesewas),
          retentionRate: run.retentionRatePercent,
          retained: formatCedis(run.retainedPesewas),
          distributable: formatCedis(run.distributablePesewas),
          totalUnitDays: formatUnits(run.totalUnitDaysE4),
          withholdingRate: run.withholdingRatePercent,
          convention: run.dayCountConvention,
          allocatedTotal: formatCedis(lines.reduce((sum, l) => sum + l.allocatedPesewas, 0n)),
          lines: lines.map((l) => ({
            investorNo: investors.get(l.investorId)!.investorNo,
            name: investors.get(l.investorId)!.legalName,
            unitDays: formatUnits(l.unitDaysE4),
            allocated: formatCedis(l.allocatedPesewas),
            extra: l.receivedExtraPesewa ? 'yes' : '',
            withheld: formatCedis(l.withheldPesewas),
            netPayable: formatCedis(l.netPayablePesewas),
          })),
        },
      });
      await this.audit.record(tx, {
        module: 'cap',
        action: 'SUBMIT',
        entityType: 'DistributionRun',
        entityId: id,
        branchId: run.branchId,
        before: { status: run.status, version: run.version },
        after: { status: 'PENDING_APPROVAL', approvalRequestId: approval.id },
      });
      const response: StoredResponse<ApprovalPendingView> = {
        status: 202,
        body: { status: 'PENDING_APPROVAL', approvalRequestId: approval.id, kind: INVESTOR_DISTRIBUTION, subject: { id, docType: DISTRIBUTION_RUN, number: run.runNo }, summary, requestedAt: approval.requestedAt.toISOString() },
      };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** IAM's `INVESTOR_DISTRIBUTION` handler: approved by someone other than the maker, or rejected; the run is then never edited. */
  readonly approvalHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, id) => {
      const run = await this.store.run(tx, id, false);
      if (run === null) throw new NotFoundError(`no distribution run ${id}`);
      return runHash(run, (await this.store.linesOf(tx, [id])).get(id)!);
    },
    onApproved: async (tx: Transaction, approval: ApprovalRecord) => {
      const run = await this.store.runByApproval(tx, approval.id);
      if (run === null || run.status !== 'PENDING_APPROVAL') throw new NotFoundError(`no distribution run waiting under approval ${approval.id}`);
      // ADR-0017 here as well as in IAM and the database: the maker never checks.
      if (approval.decidedBy === null || approval.decidedBy === run.createdBy) throw new MakerCannotCheckError('the person who drafted this run cannot approve it');
      await this.store.decideRun(tx, run.id, { status: 'APPROVED', by: approval.decidedBy, at: this.clock.now() });
      await this.audit.record(tx, { module: 'cap', action: 'APPROVE', entityType: 'DistributionRun', entityId: run.id, branchId: run.branchId, before: { status: run.status }, after: { status: 'APPROVED', approvedBy: approval.decidedBy } });
    },
    onRejected: async (tx: Transaction, approval: ApprovalRecord) => {
      const run = await this.store.runByApproval(tx, approval.id);
      if (run === null || run.status !== 'PENDING_APPROVAL') return;
      const by = approval.decidedBy ?? approval.requestedBy;
      await this.store.decideRun(tx, run.id, { status: 'REJECTED', by, at: this.clock.now() });
      await this.audit.record(tx, { module: 'cap', action: 'REJECT', entityType: 'DistributionRun', entityId: run.id, branchId: run.branchId, before: { status: run.status }, after: { status: 'REJECTED', by } });
    },
  };

  /** postDistributionRun: an approved run posted to the ledger, once (◆ `cap.DistributionDeclared`); its journal is named on it. */
  post(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<DistributionRunView>> {
    return this.step(actor, 'postDistributionRun', DISTRIBUTION_POST, 'POST', id, key, async (tx, run) => {
      const lines = (await this.store.linesOf(tx, [id])).get(id)!;
      const investors = await this.store.investorsIn(tx, lines.map((l) => l.investorId));
      const payload: DistributionDeclared = {
        runId: run.id,
        runNo: run.runNo,
        branchId: run.branchId,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        distributablePesewas: json(run.distributablePesewas),
        draftedBy: run.createdBy,
        approvedBy: run.approvedBy!,
        lines: lines.map((l) => ({
          lineId: l.id,
          investorId: l.investorId,
          investorName: investors.get(l.investorId)!.legalName,
          unitDays: formatUnits(l.unitDaysE4),
          allocatedPesewas: json(l.allocatedPesewas),
          withheldPesewas: json(l.withheldPesewas),
          netPayablePesewas: json(l.netPayablePesewas),
        })),
      };
      const at = this.clock.now();
      await this.events.publish(tx, { type: DISTRIBUTION_DECLARED, subjectType: 'DistributionRun', subjectId: run.id, branchId: run.branchId, payload: { ...payload }, occurredAt: at });
      const entry = await this.journals.entryForSubjectIn(tx, DISTRIBUTION_DECLARED, run.id);
      if (entry === null) throw new Error(`distribution run ${run.id}: the ledger posted no entry`);
      await this.store.postRun(tx, run.id, entry.id, actor!.principalId, at);
      return 200;
    });
  }

  /** recordDistributionPayment: money paid to an investor against a line of a posted run, never above net payable. */
  pay(actor: Actor | undefined, lineId: string, request: DistributionPaymentCreate, key: string): Promise<StoredResponse<DistributionLineView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.capital.authoriseIn(tx, actor, DISTRIBUTION_PAY);
      const claim = await this.idempotency.claim(tx, { operationId: 'recordDistributionPayment', principalId: actor!.principalId, key, request: { lineId, ...request, amountPesewas: request.amountPesewas.toString() } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<DistributionLineView>;
      const line = await this.store.line(tx, lineId, true);
      if (line === null) throw new NotFoundError(`no distribution line ${lineId}`);
      const run = await this.authorisedRunIn(tx, actor, DISTRIBUTION_PAY, line.runId, true);
      const broken: CapRule[] = [];
      if (judgeRunAction('PAY', run.status, run.distributablePesewas) !== null || run.computationNo !== line.computationNo) broken.push({ field: null, rule: 'RUN_NOT_POSTED' });
      const judged = judgeDistributionPayment({ netPayable: line.netPayablePesewas, paid: line.paidPesewas }, request.amountPesewas);
      if (!judged.ok) broken.push({ field: '/amountPesewas', rule: judged.error });
      const account = (await this.bankAccounts.payoutAccountsIn(tx, [request.bankAccountId])).get(request.bankAccountId);
      if (account === undefined) broken.push({ field: '/bankAccountId', rule: 'BANK_ACCOUNT_UNKNOWN' });
      else if (!account.isActive) broken.push({ field: '/bankAccountId', rule: 'BANK_ACCOUNT_INACTIVE' });
      if (broken.length > 0) throw new DistributionPaymentInvalidError(broken);
      const reference = request.externalReference ?? null;
      if (reference !== null && (await this.store.paymentByReference(tx, reference)) !== null) throw new PaymentReferenceTakenError(`reference ${reference} is already recorded`);
      const investor = (await this.store.investorsIn(tx, [line.investorId])).get(line.investorId)!;
      const id = this.nextId();
      const at = this.clock.now();
      const paidAt = request.paidAt === undefined ? at : new Date(request.paidAt);
      const payload: DistributionPaid = {
        paymentId: id,
        runId: run.id,
        runNo: run.runNo,
        lineId,
        investorId: investor.id,
        investorName: investor.legalName,
        bankAccountId: request.bankAccountId,
        branchId: run.branchId,
        amountPesewas: json(request.amountPesewas),
        externalReference: reference,
      };
      await this.events.publish(tx, { type: DISTRIBUTION_PAID, subjectType: 'DistributionPayment', subjectId: id, branchId: run.branchId, payload: { ...payload }, occurredAt: paidAt });
      const entry = await this.journals.entryForSubjectIn(tx, DISTRIBUTION_PAID, id);
      if (entry === null) throw new Error(`distribution payment ${id}: the ledger posted no entry`);
      await this.store.insertPayment(tx, { id, lineId, amountPesewas: request.amountPesewas, bankAccountId: request.bankAccountId, externalReference: reference, paidAt, journalEntryId: entry.id, recordedAt: at, actorId: actor!.principalId });
      const lines = (await this.store.linesOf(tx, [run.id])).get(run.id)!;
      if (lines.every((l) => l.paidPesewas === l.netPayablePesewas)) await this.store.markRunPaid(tx, run.id, actor!.principalId);
      const view = (await this.lineViews(tx, lines.filter((l) => l.id === lineId)))[0]!;
      await this.audit.record(tx, {
        module: 'cap',
        action: 'PAY',
        entityType: 'DistributionLine',
        entityId: lineId,
        branchId: run.branchId,
        before: { paidPesewas: json(line.paidPesewas) },
        after: { ...payload, paidPesewas: view.paidPesewas, journalEntryId: entry.id },
      });
      const response: StoredResponse<DistributionLineView> = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** getDistributionSchedule: a signed link to the schedule archived at submission; 409 while it is still rendering. */
  schedule(actor: Actor | undefined, id: string): Promise<{ readonly url: string; readonly expiresAt: string }> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const run = await this.authorisedRunIn(tx, actor, DISTRIBUTION_READ, id, false);
      const link = run.scheduleDocumentId === null ? null : await this.archive.signedUrlIn(tx, run.scheduleDocumentId, 'cap.distribution.schedule', actor!.principalId);
      if (link === null) throw new DocumentNotArchivedError(run.scheduleDocumentId === null ? 'RENDERING' : 'NOT_SCANNED');
      return link;
    });
  }

  /** CAP's consumer of `doc.DocumentArchived` (ADR-0061): a submitted run learns its archived schedule, once. */
  readonly archiveLinks: AsyncConsumer = {
    name: 'cap.distribution-schedule-link',
    eventTypes: [DOCUMENT_ARCHIVED],
    isolation: 'serializable',
    handle: async (tx, event) => {
      const archived = event.payload as unknown as DocumentArchived;
      if (archived.docType !== DISTRIBUTION_RUN) return;
      await this.store.linkSchedule(tx, archived.businessDocumentId, archived.archivedDocumentId, event.actorId);
    },
  };

  /** A run the caller may act on: the permission at the books' branch, which is the run's own; none is 404. */
  private async authorisedRunIn(tx: Transaction, actor: Actor | undefined, permission: string, id: string, forUpdate: boolean): Promise<RunRecord> {
    const branchId = await this.capital.authoriseIn(tx, actor, permission);
    const run = await this.store.run(tx, id, forUpdate);
    if (run === null || run.branchId !== branchId) throw new NotFoundError(`no distribution run ${id}`);
    return run;
  }

  private judge(action: RunAction, run: RunRecord): void {
    const refusal = judgeRunAction(action, run.status, run.distributablePesewas);
    if (refusal !== null) throw new DistributionRunInvalidError([{ field: null, rule: refusal }]);
  }

  /** One lifecycle step on a run: authorised, replayed by its key, judged, done, audited, answered with the run. */
  private step(
    actor: Actor | undefined,
    operationId: string,
    permission: string,
    action: RunAction,
    id: string,
    key: string,
    work: (tx: Transaction, run: RunRecord) => Promise<number>,
  ): Promise<StoredResponse<DistributionRunView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.capital.authoriseIn(tx, actor, permission);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<DistributionRunView>;
      const run = await this.authorisedRunIn(tx, actor, permission, id, true);
      this.judge(action, run);
      const before = (await this.views(tx, [run]))[0]!;
      const status = await work(tx, run);
      const view = (await this.views(tx, [(await this.store.run(tx, id, false))!]))[0]!;
      await this.audit.record(tx, { module: 'cap', action, entityType: 'DistributionRun', entityId: id, branchId: run.branchId, before: { ...before }, after: { ...view } });
      const response: StoredResponse<DistributionRunView> = { status, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * The period's rules: in order, at most a year, ended, every day in an accounting period and every one of those
   * locked or closed, and no other run that was not rejected covering a day of it (the database's exclusion holds it too).
   */
  private async checkPeriodIn(tx: Transaction, period: { readonly start: string; readonly end: string }, self: string | null): Promise<void> {
    const broken: CapRule[] = [];
    if (period.end < period.start) broken.push({ field: '/periodEnd', rule: 'PERIOD_REVERSED' });
    else if (period.end >= toBusinessDate(this.clock.now())) broken.push({ field: '/periodEnd', rule: 'PERIOD_NOT_ENDED' });
    else {
      const touched = (await this.periods.allIn(tx)).filter((p) => p.endDate >= period.start && p.startDate <= period.end);
      if (daysCovered(period, touched) < daysInPeriod(period)) broken.push({ field: '/periodStart', rule: 'PERIOD_NOT_IN_LEDGER' });
      else if (touched.some((p) => p.status !== 'LOCKED' && p.status !== 'CLOSED')) broken.push({ field: '/periodEnd', rule: 'PERIOD_NOT_LOCKED' });
      const others = await this.store.runs(tx, { status: null, branchIds: [await this.capital.booksBranchIn(tx)] }, null, 1_000);
      if (others.some((r) => r.id !== self && r.status !== 'REJECTED' && r.periodStart <= period.end && r.periodEnd >= period.start)) broken.push({ field: '/periodStart', rule: 'PERIOD_ALREADY_DISTRIBUTED' });
    }
    if (broken.length > 0) throw new DistributionRunInvalidError(broken);
  }

  /** The run's figures and lines from the ledger and the capital transactions as they stand, for one computation. */
  private async computeIn(
    tx: Transaction,
    runId: string,
    period: { readonly start: string; readonly end: string },
    retention: Rate,
    computationNo: number,
    at: Date,
  ): Promise<{ figures: RunFigures; lines: LineRecord[] }> {
    const profit = distributableProfit(await this.statements.netProfitIn(tx, period.start, period.end), retention);
    const unitDays = unitDaysByInvestor((await this.store.transactionsUpTo(tx, period.end)).map(movementOf), period);
    const investors = await this.store.investorsIn(tx, [...unitDays.keys()]);
    const withholding = Rate.parsePercent(WITHHOLDING_PERCENT);
    const weighted = [...unitDays].map(([investorId, unitDaysE4]) => ({ investorId, investorNo: investors.get(investorId)!.investorNo, unitDaysE4 }));
    const allocated = allocateDistribution(profit.distributable, weighted, withholding);
    if (!allocated.ok) throw new DistributionRunInvalidError([{ field: '/periodStart', rule: allocated.error }]);
    const lines: LineRecord[] = allocated.value.map((l) => ({
      id: this.nextId(),
      runId,
      computationNo,
      investorId: l.investorId,
      unitDaysE4: l.unitDaysE4,
      allocatedPesewas: l.allocated.pesewas,
      receivedExtraPesewa: l.receivedExtraPesewa,
      withheldPesewas: l.withheld.pesewas,
      netPayablePesewas: l.netPayable.pesewas,
      paidPesewas: 0n,
    }));
    return {
      figures: {
        netProfitPesewas: profit.netProfit.pesewas,
        isLoss: profit.isLoss,
        retentionRatePercent: percentText(retention),
        retainedPesewas: profit.retained.pesewas,
        distributablePesewas: profit.distributable.pesewas,
        totalUnitDaysE4: lines.reduce((sum, l) => sum + l.unitDaysE4, 0n),
        withholdingRatePercent: percentText(withholding),
        computationNo,
        computedAt: at,
      },
      lines,
    };
  }

  private async lineViews(tx: Transaction, lines: readonly LineRecord[]): Promise<DistributionLineView[]> {
    const investors: ReadonlyMap<string, InvestorRecord> = await this.store.investorsIn(tx, lines.map((l) => l.investorId));
    return lines.map((l) => ({
      id: l.id,
      investor: investorRef(investors.get(l.investorId)!),
      unitDays: formatUnits(l.unitDaysE4),
      allocatedPesewas: json(l.allocatedPesewas),
      receivedExtraPesewa: l.receivedExtraPesewa,
      withheldPesewas: json(l.withheldPesewas),
      netPayablePesewas: json(l.netPayablePesewas),
      paidPesewas: json(l.paidPesewas),
    }));
  }

  private async views(tx: Transaction, runs: readonly RunRecord[]): Promise<DistributionRunView[]> {
    const lines = await this.store.linesOf(tx, runs.map((r) => r.id));
    const views: DistributionRunView[] = [];
    for (const r of runs) {
      views.push({
        id: r.id,
        runNo: r.runNo,
        status: r.status,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        daysInPeriod: r.daysInPeriod,
        netProfitPesewas: json(r.netProfitPesewas),
        isLoss: r.isLoss,
        retentionRatePercent: r.retentionRatePercent,
        retainedPesewas: json(r.retainedPesewas),
        distributablePesewas: json(r.distributablePesewas),
        allocationMethod: 'UNIT_DAYS',
        dayCountConvention: r.dayCountConvention,
        totalUnitDays: formatUnits(r.totalUnitDaysE4),
        withholdingRatePercent: r.withholdingRatePercent,
        approvalRequestId: r.approvalRequestId,
        scheduleDocumentId: r.scheduleDocumentId,
        lines: await this.lineViews(tx, lines.get(r.id) ?? []),
        paidPesewas: json(r.paidPesewas),
        currency: 'GHS',
        branchId: r.branchId,
        version: r.version,
        createdAt: r.createdAt.toISOString(),
      });
    }
    return views;
  }
}
