import { createHash } from 'node:crypto';
import { createUuidV7Generator, formatCedis, Money, Rate, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { FinancingAccrualBlocked } from '../events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { FileStore } from '../../../platform/storage/file-store';
import type { BankAccounts, Journals, Periods } from '../../fin';
import type { ApprovalHandler, ApprovalRecord, Approvals } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { completeMonths, equalMonthlyParts, instalmentsPaid, interestOfMonth, judgeRepayment, scheduleOf, type Month } from '../domain/financing';
import type { AccrualRecord, CapBooksStore, FinancingRecord, RepaymentRecord } from './cap-books-store';
import type { CapStore } from './cap-store';
import { investorRef, type Capital, type InvestorRefView, type Page } from './capital';
import { plusOne, probe } from './counting';
import { FinancingInvalidError, MakerCannotCheckError, PaymentReferenceTakenError, RepaymentInvalidError, type CapRule } from './errors';

export const FINANCING_READ = 'cap.financing.read';
export const FINANCING_MANAGE = 'cap.financing.manage';
export const FINANCING = 'FINANCING';
/** ◆ CAP's loan and grant events (ADR-0003, ADR-0101, migration 0360). */
export const LOAN_DRAWN = 'cap.LoanDrawn';
export const GRANT_RECEIVED = 'cap.GrantReceived';
export const INTEREST_ACCRUED = 'cap.InterestAccrued';
export const GRANT_RECOGNISED = 'cap.GrantRecognised';
export const LOAN_REPAID = 'cap.LoanRepaid';
/** The daily accrual job found a finished month it could not accrue (abuse case 71, B12 continued 3). */
export const FINANCING_ACCRUAL_BLOCKED = 'cap.FinancingAccrualBlocked';
export const FINANCING_LEDGER_EVENTS = [LOAN_DRAWN, GRANT_RECEIVED, INTEREST_ACCRUED, GRANT_RECOGNISED, LOAN_REPAID] as const;

const json = (n: bigint): number => Money.ofPesewas(n).toJsonInteger();

/** The contract's `Financing`, with the interest accrued and not yet paid and the approval it waits for (additive). */
export interface FinancingView {
  readonly id: string;
  readonly financingNo: string;
  readonly status: FinancingRecord['status'];
  readonly kind: FinancingRecord['kind'];
  readonly lenderInvestor: InvestorRefView | null;
  readonly lenderName: string;
  readonly principalPesewas: number;
  readonly annualRatePercent: string;
  readonly interestBasis: 'ACTUAL_365';
  readonly startDate: string;
  readonly termMonths: number | null;
  readonly outstandingPesewas: number;
  readonly accruedInterestPesewas: number;
  readonly approvalRequestId: string;
  readonly schedule: readonly { readonly instalmentNo: number; readonly dueDate: string; readonly principalDuePesewas: number; readonly interestDuePesewas: number; readonly paidPesewas: number }[];
  readonly currency: 'GHS';
  readonly version: number;
}

export interface FinancingCreate {
  readonly kind: FinancingRecord['kind'];
  readonly lenderInvestorId?: string | undefined;
  readonly lenderName: string;
  readonly principalPesewas: bigint;
  readonly annualRatePercent?: string | undefined;
  readonly interestBasis?: 'ACTUAL_365' | 'FLAT' | undefined;
  readonly startDate: string;
  readonly termMonths?: number | undefined;
  readonly bankAccountId: string;
  readonly agreementFileId?: string | undefined;
}

export interface RepaymentCreate {
  readonly principalPesewas: bigint;
  readonly interestPesewas: bigint;
  readonly bankAccountId: string;
  readonly externalReference?: string | undefined;
  readonly paidAt: string;
}

const financingHash = (f: FinancingRecord): string =>
  createHash('sha256')
    .update(
      canonicalJson({
        id: f.id,
        kind: f.kind,
        lenderInvestorId: f.lenderInvestorId,
        lenderName: f.lenderName,
        principalPesewas: f.principalPesewas.toString(),
        annualRatePercent: f.annualRatePercent,
        startDate: f.startDate,
        termMonths: f.termMonths,
        bankAccountId: f.bankAccountId,
      }),
      'utf8',
    )
    .digest('hex');

/** What a financing owes, from its rows: principal, interest accrued and repaid, what a grant has recognised. */
interface Owed {
  readonly principalRepaid: bigint;
  readonly interestAccrued: bigint;
  readonly interestRepaid: bigint;
  readonly recognised: bigint;
  readonly lastAccrued: string | null;
}

function owedOf(accruals: readonly AccrualRecord[], repayments: readonly RepaymentRecord[]): Owed {
  return {
    principalRepaid: repayments.reduce((t, r) => t + r.principalPesewas, 0n),
    interestAccrued: accruals.filter((a) => a.kind === 'INTEREST').reduce((t, a) => t + a.amountPesewas, 0n),
    interestRepaid: repayments.reduce((t, r) => t + r.interestPesewas, 0n),
    recognised: accruals.filter((a) => a.kind === 'RECOGNITION').reduce((t, a) => t + a.amountPesewas, 0n),
    lastAccrued: accruals.at(-1)?.monthEnd ?? null,
  };
}

/**
 * Loans and grants (FR-CAP-015, ADR-0003, ADR-0101). A loan or grant is recorded as a numbered DRAFT and waits for a
 * different person holding `cap.financing.approve` (`FINANCING`, step-up); on approval the money is posted in on its
 * start date (◆ `cap.LoanDrawn` Dr 1100 or 1110, Cr 2400 against the lender; ◆ `cap.GrantReceived` Cr 2450). Each
 * finished calendar month a loan accrues its simple interest, actual/365, half-up once for the month (◆
 * `cap.InterestAccrued` Dr 6930, Cr 2410) and a grant recognises its equal part (◆ `cap.GrantRecognised` Dr 2450,
 * Cr 4910), on the month's last day, by the daily job and before any repayment. A repayment goes to accrued interest
 * first, then principal (◆ `cap.LoanRepaid`), never above what is owed (the database too). Kept at the head office
 * branch; the Owner and the Accountant only (A-381).
 */
export class Financing {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: CapStore,
    private readonly books: CapBooksStore,
    private readonly capital: Capital,
    private readonly refs: MasterDataRefs,
    private readonly bankAccounts: BankAccounts,
    private readonly periods: Periods,
    private readonly journals: Journals,
    private readonly files: FileStore,
    private readonly registry: DocumentRegistry,
    private readonly numbers: NumberSeries,
    private readonly approvals: Approvals,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filter: { readonly kind: FinancingRecord['kind'] | null; readonly status: FinancingRecord['status'] | null }, cursor: string | undefined, limit: number): Promise<Page<FinancingView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.capital.authoriseIn(tx, actor, FINANCING_READ);
      const binding = { operationId: 'listFinancing', principalId: actor!.principalId, filters: filter };
      const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.books.financings(tx, filter, before, probe(limit));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      const data: FinancingView[] = [];
      for (const row of rows) data.push(await this.viewIn(tx, row));
      return { data, page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: rows.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<FinancingView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.capital.authoriseIn(tx, actor, FINANCING_READ);
      const financing = await this.books.financing(tx, id, false);
      if (financing === null) throw new NotFoundError(`no financing ${id}`);
      return this.viewIn(tx, financing);
    });
  }

  /** createFinancing: a numbered DRAFT with its schedule, waiting for a different person's approval (201). */
  create(actor: Actor | undefined, request: FinancingCreate, key: string): Promise<StoredResponse<FinancingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const branchId = await this.capital.authoriseIn(tx, actor, FINANCING_MANAGE);
      const claim = await this.idempotency.claim(tx, {
        operationId: 'createFinancing',
        principalId: actor!.principalId,
        key,
        request: { ...request, principalPesewas: request.principalPesewas.toString() },
      });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<FinancingView>;
      const rate = request.annualRatePercent ?? '0';
      const broken: CapRule[] = [];
      let lenderName = request.lenderName.trim();
      if (request.lenderInvestorId !== undefined) {
        const lender = await this.store.investor(tx, request.lenderInvestorId, false);
        if (lender === null) broken.push({ field: '/lenderInvestorId', rule: 'LENDER_UNKNOWN' });
        else lenderName = lender.legalName;
      }
      if (request.interestBasis === 'FLAT') broken.push({ field: '/interestBasis', rule: 'INTEREST_BASIS_NOT_SUPPORTED' });
      if (request.kind === 'GRANT' && !Rate.parsePercent(rate).isZero()) broken.push({ field: '/annualRatePercent', rule: 'GRANT_HAS_NO_INTEREST' });
      if (request.kind === 'GRANT' && request.termMonths === undefined) broken.push({ field: '/termMonths', rule: 'TERM_REQUIRED' });
      broken.push(...(await this.accountRules(tx, request.bankAccountId)));
      broken.push(...(await this.dateRules(tx, request.startDate, '/startDate', 'START_DATE_IN_FUTURE')));
      if (request.agreementFileId !== undefined) {
        const file = await this.files.find(tx, request.agreementFileId);
        if (file === null || file.scanStatus !== 'CLEAN' || !['AGREEMENT', 'INVESTOR_DOCUMENT'].includes(file.purpose)) broken.push({ field: '/agreementFileId', rule: 'FILE_NOT_USABLE' });
      }
      if (broken.length > 0) throw new FinancingInvalidError(broken);
      const id = this.nextId();
      const at = this.clock.now();
      const branch = (await this.refs.branchesIn(tx, [branchId])).get(branchId)!;
      await this.registry.register(tx, { id, docType: FINANCING, ownerModule: 'cap', branchId, actorId: actor!.principalId });
      const financingNo = await this.numbers.allocateIn(tx, { docType: FINANCING, fiscalYear: Number(request.startDate.slice(0, 4)), branchId, branchCode: branch.code, documentId: id });
      const draft: FinancingRecord = {
        id,
        financingNo,
        kind: request.kind,
        lenderInvestorId: request.lenderInvestorId ?? null,
        lenderName,
        principalPesewas: request.principalPesewas,
        annualRatePercent: Rate.parsePercent(rate).toPercentString(),
        startDate: request.startDate,
        termMonths: request.termMonths ?? null,
        bankAccountId: request.bankAccountId,
        agreementFileId: request.agreementFileId ?? null,
        approvalRequestId: '',
        journalEntryId: null,
        status: 'DRAFT',
        branchId,
        version: 1,
        createdBy: actor!.principalId,
        createdAt: at,
      };
      const what = request.kind === 'LOAN' ? `a loan of ${formatCedis(request.principalPesewas)} from ${lenderName} at ${draft.annualRatePercent} percent` : `a grant of ${formatCedis(request.principalPesewas)} from ${lenderName}`;
      const approval = await this.approvals.request(tx, actor, {
        kind: FINANCING,
        branchId,
        subjectDocumentId: id,
        payloadHash: financingHash(draft),
        amountPesewas: request.principalPesewas,
        summary: `Draw ${what} (${financingNo}) into the bank from ${request.startDate}`,
      });
      const record = { ...draft, approvalRequestId: approval.id };
      const schedule = request.kind === 'LOAN' ? scheduleOf(request.principalPesewas, Rate.parsePercent(rate), request.startDate, record.termMonths) : [];
      await this.books.insertFinancing(tx, record, schedule.map((line) => ({ financingId: id, ...line })));
      const view = await this.viewIn(tx, record);
      await this.audit.record(tx, { module: 'cap', action: 'CREATE', entityType: 'Financing', entityId: id, branchId, before: null, after: { ...view, schedule: view.schedule.length } });
      const response: StoredResponse<FinancingView> = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** recordRepayment: interest accrued for every finished month first, then the repayment, interest before principal. */
  repay(actor: Actor | undefined, id: string, request: RepaymentCreate, key: string): Promise<StoredResponse<FinancingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const branchId = await this.capital.authoriseIn(tx, actor, FINANCING_MANAGE);
      const claim = await this.idempotency.claim(tx, {
        operationId: 'recordRepayment',
        principalId: actor!.principalId,
        key,
        request: { id, ...request, principalPesewas: request.principalPesewas.toString(), interestPesewas: request.interestPesewas.toString() },
      });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<FinancingView>;
      const financing = await this.books.financing(tx, id, true);
      if (financing === null) throw new NotFoundError(`no financing ${id}`);
      if (financing.kind !== 'LOAN') throw new RepaymentInvalidError([{ field: null, rule: 'NOT_A_LOAN' }]);
      if (financing.status !== 'ACTIVE') throw new RepaymentInvalidError([{ field: null, rule: 'NOT_ACTIVE' }]);
      const blocked = await this.accrueIn(tx, financing, actor!.principalId);
      if (blocked !== null) throw new RepaymentInvalidError([{ field: null, rule: 'INTEREST_NOT_ACCRUED' }]);
      const owed = owedOf(await this.books.accrualsOf(tx, id), await this.books.repaymentsOf(tx, id));
      const valueDate = toBusinessDate(new Date(request.paidAt));
      const broken: CapRule[] = judgeRepayment(request, {
        accruedInterestPesewas: owed.interestAccrued - owed.interestRepaid,
        outstandingPrincipalPesewas: financing.principalPesewas - owed.principalRepaid,
      }).map((r) => ({ field: r.field, rule: r.rule }));
      broken.push(...(await this.accountRules(tx, request.bankAccountId)));
      broken.push(...(await this.dateRules(tx, valueDate, '/paidAt', 'VALUE_DATE_IN_FUTURE')));
      if (valueDate < financing.startDate || (owed.lastAccrued !== null && valueDate <= owed.lastAccrued)) broken.push({ field: '/paidAt', rule: 'VALUE_DATE_BEFORE_ACCRUAL' });
      if (broken.length > 0) throw new RepaymentInvalidError(broken);
      if (request.externalReference !== undefined && (await this.books.repaymentByReference(tx, request.externalReference)) !== null) {
        throw new PaymentReferenceTakenError(`reference ${request.externalReference} is already recorded`);
      }
      const repaymentId = this.nextId();
      const at = this.clock.now();
      await this.events.publish(tx, {
        type: LOAN_REPAID,
        subjectType: 'FinancingRepayment',
        subjectId: repaymentId,
        branchId,
        payload: {
          repaymentId,
          financingId: id,
          financingNo: financing.financingNo,
          lenderPartyId: financing.lenderInvestorId ?? financing.id,
          lenderName: financing.lenderName,
          bankAccountId: request.bankAccountId,
          branchId,
          principalPesewas: json(request.principalPesewas),
          interestPesewas: json(request.interestPesewas),
          postingDate: valueDate,
          recordedBy: actor!.principalId,
        },
        occurredAt: at,
      });
      const entry = await this.journals.entryForSubjectIn(tx, LOAN_REPAID, repaymentId);
      if (entry === null) throw new Error(`repayment ${repaymentId}: the ledger posted no entry`);
      await this.books.insertRepayment(tx, {
        id: repaymentId,
        financingId: id,
        principalPesewas: request.principalPesewas,
        interestPesewas: request.interestPesewas,
        bankAccountId: request.bankAccountId,
        externalReference: request.externalReference ?? null,
        paidAt: new Date(request.paidAt),
        valueDate,
        journalEntryId: entry.id,
        recordedAt: at,
        actorId: actor!.principalId,
      });
      const settled = financing.principalPesewas - owed.principalRepaid - request.principalPesewas === 0n && owed.interestAccrued - owed.interestRepaid - request.interestPesewas === 0n;
      if (settled) await this.books.settleFinancing(tx, id, actor!.principalId, at);
      await this.audit.record(tx, {
        module: 'cap',
        action: 'REPAY',
        entityType: 'Financing',
        entityId: id,
        branchId,
        after: { repaymentId, principalPesewas: json(request.principalPesewas), interestPesewas: json(request.interestPesewas), valueDate, journalEntryNo: entry.entryNo, settled },
      });
      const response: StoredResponse<FinancingView> = { status: 201, body: await this.viewIn(tx, (await this.books.financing(tx, id, false))!) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** The daily job: every active loan's and grant's finished months accrued, each financing in its own transaction. */
  async accrueAll(system: { readonly principalId: string }): Promise<{ readonly financings: number; readonly blocked: number }> {
    const ids = await this.uow.run({ isolation: 'read committed' }, (tx) => this.books.activeFinancingIds(tx));
    let blocked = 0;
    for (const id of ids) {
      const stopped = await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        const financing = await this.books.financing(tx, id, true);
        if (financing === null || financing.status !== 'ACTIVE') return null;
        const month = await this.accrueIn(tx, financing, system.principalId);
        if (month !== null) {
          const payload: FinancingAccrualBlocked = { financingId: financing.id, financingNo: financing.financingNo, branchId: financing.branchId, monthEnd: month };
          await this.events.publish(tx, { type: FINANCING_ACCRUAL_BLOCKED, subjectType: 'Financing', subjectId: financing.id, branchId: financing.branchId, payload: { ...payload } });
        }
        return month;
      });
      if (stopped !== null) {
        blocked = plusOne(blocked);
        this.logger.error({ financingId: id, month: stopped }, 'a finished month of a loan or grant could not be accrued: its period is not open');
      }
    }
    return { financings: ids.length, blocked };
  }

  /** IAM's `FINANCING` handler: on approval the money is posted in on the start date, in the approving transaction. */
  readonly approvalHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, id) => {
      const financing = await this.books.financing(tx, id, false);
      if (financing === null) throw new NotFoundError(`no financing ${id}`);
      return financingHash(financing);
    },
    onApproved: async (tx: Transaction, approval: ApprovalRecord) => {
      const financing = await this.books.financingByApproval(tx, approval.id);
      if (financing === null || financing.status !== 'DRAFT') throw new NotFoundError(`no loan or grant waiting under approval ${approval.id}`);
      if (approval.decidedBy === null || approval.decidedBy === financing.createdBy) throw new MakerCannotCheckError('the person who recorded this loan or grant cannot approve it');
      const broken = [...(await this.accountRules(tx, financing.bankAccountId)), ...(await this.dateRules(tx, financing.startDate, '/startDate', 'START_DATE_IN_FUTURE'))];
      if (broken.length > 0) throw new FinancingInvalidError(broken);
      const type = financing.kind === 'LOAN' ? LOAN_DRAWN : GRANT_RECEIVED;
      const at = this.clock.now();
      await this.events.publish(tx, {
        type,
        subjectType: 'Financing',
        subjectId: financing.id,
        branchId: financing.branchId,
        payload: {
          financingId: financing.id,
          financingNo: financing.financingNo,
          kind: financing.kind,
          lenderPartyId: financing.lenderInvestorId ?? financing.id,
          lenderName: financing.lenderName,
          bankAccountId: financing.bankAccountId,
          branchId: financing.branchId,
          amountPesewas: json(financing.principalPesewas),
          postingDate: financing.startDate,
          recordedBy: financing.createdBy,
          approvedBy: approval.decidedBy,
        },
        occurredAt: at,
      });
      const entry = await this.journals.entryForSubjectIn(tx, type, financing.id);
      if (entry === null) throw new Error(`financing ${financing.id}: the ledger posted no entry`);
      await this.books.decideFinancing(tx, financing.id, { status: 'ACTIVE', journalEntryId: entry.id, by: approval.decidedBy, at });
      await this.audit.record(tx, { module: 'cap', action: 'DRAW', entityType: 'Financing', entityId: financing.id, branchId: financing.branchId, metadata: { approvalRequestId: approval.id, journalEntryNo: entry.entryNo } });
    },
    onRejected: async (tx: Transaction, approval: ApprovalRecord) => {
      const financing = await this.books.financingByApproval(tx, approval.id);
      if (financing === null || financing.status !== 'DRAFT') return;
      await this.books.decideFinancing(tx, financing.id, { status: 'CANCELLED', journalEntryId: null, by: approval.decidedBy ?? approval.requestedBy, at: this.clock.now() });
    },
  };

  /**
   * Accrues every finished month not yet accrued, in order, each on its last day. Answers the month it stopped at when
   * that month's accounting period is not open (nothing is posted into a locked month), else null.
   */
  private async accrueIn(tx: Transaction, financing: FinancingRecord, actorId: string): Promise<string | null> {
    const today = toBusinessDate(this.clock.now());
    const accruals = await this.books.accrualsOf(tx, financing.id);
    const done = new Set(accruals.map((a) => a.monthEnd));
    const repayments = await this.books.repaymentsOf(tx, financing.id);
    const months = completeMonths(financing.startDate, today);
    const parts = financing.kind === 'GRANT' ? equalMonthlyParts(financing.principalPesewas, financing.termMonths!) : [];
    const periods = await this.periods.allIn(tx);
    let recognised = accruals.filter((a) => a.kind === 'RECOGNITION').length;
    for (const [index, month] of months.entries()) {
      if (done.has(month.end)) continue;
      if (financing.kind === 'GRANT' && index >= parts.length) break;
      const period = periods.find((p) => p.startDate <= month.end && month.end <= p.endDate);
      if (period === undefined || period.status !== 'OPEN') return month.end;
      const amount = financing.kind === 'GRANT' ? parts[index]! : this.interestOf(financing, month, repayments);
      await this.postAccrualIn(tx, financing, month, amount, actorId);
      if (financing.kind === 'GRANT') recognised = plusOne(recognised);
    }
    if (financing.kind === 'GRANT' && recognised >= parts.length) await this.books.settleFinancing(tx, financing.id, actorId, this.clock.now());
    return null;
  }

  private interestOf(financing: FinancingRecord, month: Month, repayments: readonly RepaymentRecord[]): bigint {
    const before = repayments.filter((r) => r.valueDate <= month.start).reduce((t, r) => t + r.principalPesewas, 0n);
    const within = repayments.filter((r) => r.valueDate > month.start && r.valueDate <= month.end && r.principalPesewas > 0n).map((r) => ({ date: r.valueDate, pesewas: r.principalPesewas }));
    return interestOfMonth(financing.principalPesewas - before, Rate.parsePercent(financing.annualRatePercent), month, within);
  }

  private async postAccrualIn(tx: Transaction, financing: FinancingRecord, month: Month, amount: bigint, actorId: string): Promise<void> {
    const id = this.nextId();
    const at = this.clock.now();
    const kind = financing.kind === 'LOAN' ? 'INTEREST' : 'RECOGNITION';
    let journalEntryId: string | null = null;
    if (amount > 0n) {
      const type = kind === 'INTEREST' ? INTEREST_ACCRUED : GRANT_RECOGNISED;
      await this.events.publish(tx, {
        type,
        subjectType: 'FinancingAccrual',
        subjectId: id,
        branchId: financing.branchId,
        payload: { accrualId: id, financingId: financing.id, financingNo: financing.financingNo, branchId: financing.branchId, amountPesewas: json(amount), monthStart: month.start, postingDate: month.end },
        occurredAt: at,
      });
      const entry = await this.journals.entryForSubjectIn(tx, type, id);
      if (entry === null) throw new Error(`accrual ${id}: the ledger posted no entry`);
      journalEntryId = entry.id;
    }
    await this.books.insertAccrual(tx, { id, financingId: financing.id, kind, monthStart: month.start, monthEnd: month.end, amountPesewas: amount, journalEntryId, recordedAt: at, actorId });
  }

  private async accountRules(tx: Transaction, bankAccountId: string): Promise<CapRule[]> {
    const account = (await this.bankAccounts.payoutAccountsIn(tx, [bankAccountId])).get(bankAccountId);
    if (account === undefined) return [{ field: '/bankAccountId', rule: 'BANK_ACCOUNT_UNKNOWN' }];
    return account.isActive ? [] : [{ field: '/bankAccountId', rule: 'BANK_ACCOUNT_INACTIVE' }];
  }

  private async dateRules(tx: Transaction, date: string, field: string, futureRule: string): Promise<CapRule[]> {
    if (date > toBusinessDate(this.clock.now())) return [{ field, rule: futureRule }];
    const period = (await this.periods.allIn(tx)).find((p) => p.startDate <= date && date <= p.endDate);
    return period === undefined || period.status !== 'OPEN' ? [{ field, rule: 'PERIOD_NOT_OPEN' }] : [];
  }

  private async viewIn(tx: Transaction, f: FinancingRecord): Promise<FinancingView> {
    const owed = owedOf(await this.books.accrualsOf(tx, f.id), await this.books.repaymentsOf(tx, f.id));
    const schedule = await this.books.scheduleOf(tx, f.id);
    const paid = instalmentsPaid(schedule, owed.principalRepaid + owed.interestRepaid);
    const lender = f.lenderInvestorId === null ? null : await this.store.investor(tx, f.lenderInvestorId, false);
    return {
      id: f.id,
      financingNo: f.financingNo,
      status: f.status,
      kind: f.kind,
      lenderInvestor: lender === null ? null : investorRef(lender),
      lenderName: f.lenderName,
      principalPesewas: json(f.principalPesewas),
      annualRatePercent: f.annualRatePercent,
      interestBasis: 'ACTUAL_365',
      startDate: f.startDate,
      termMonths: f.termMonths,
      outstandingPesewas: json(f.principalPesewas - (f.kind === 'LOAN' ? owed.principalRepaid : owed.recognised)),
      accruedInterestPesewas: json(owed.interestAccrued - owed.interestRepaid),
      approvalRequestId: f.approvalRequestId,
      schedule: schedule.map((line, i) => ({
        instalmentNo: line.instalmentNo,
        dueDate: line.dueDate,
        principalDuePesewas: json(line.principalDuePesewas),
        interestDuePesewas: json(line.interestDuePesewas),
        paidPesewas: json(paid[i]!),
      })),
      currency: 'GHS',
      version: f.version,
    };
  }
}
