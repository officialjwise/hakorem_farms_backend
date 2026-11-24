import { createHash } from 'node:crypto';
import { createUuidV7Generator, formatCedis, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { BankAccounts, Journals, Periods } from '../../fin';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { formatUnits, heldOn, judgeWithdrawal, sharePercent, unitsFor, type UnitMovement } from '../domain/distribution';
import type { CapitalMoved } from '../events';
import { byInvestorNo, probe } from './counting';
import type { CapitalTransactionRecord, CapStore, HoldingRecord, InvestorRecord, WithdrawalRequestRecord } from './cap-store';
import { CapitalTransactionInvalidError, InvestorInvalidError, MakerCannotCheckError, type CapRule } from './errors';
import type { InvestorProfiles, ProfileRequest } from './investor-profiles';
import type { InvestorPayout } from '../domain/investor/payout';

export const INVESTOR_READ = 'cap.investor.read';
export const INVESTOR_MANAGE = 'cap.investor.manage';
export const CAPITAL_READ = 'cap.capital.read';
export const CAPITAL_RECORD = 'cap.capital.record';
export const CAPITAL_TRANSACTION = 'CAPITAL_TRANSACTION';
export const CAPITAL_WITHDRAWAL = 'CAPITAL_WITHDRAWAL';
/** ◆ CAP's ledger events (ADR-0003, migration 0354). */
export const CAPITAL_CONTRIBUTED = 'cap.CapitalContributed';
export const CAPITAL_WITHDRAWN = 'cap.CapitalWithdrawn';
/** The unit price when none is given: GHS 100.00 (UAT section 3.5, the contract's default; A-380). */
export const DEFAULT_UNIT_PRICE_PESEWAS = 10_000n;

export interface Page<T> {
  readonly data: T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

export interface InvestorRefView {
  readonly id: string;
  readonly investorNo: string;
  readonly name: string;
}

/** The contract's `Investor`. */
export interface InvestorView {
  readonly id: string;
  readonly investorNo: string;
  readonly kind: InvestorRecord['kind'];
  readonly legalName: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly hasPortalLogin: boolean;
  readonly idNumberMasked: string | null;
  readonly payoutMethod: InvestorRecord['payoutMethod'];
  readonly payoutDetailsMasked: string | null;
  /** The approval a change of the payout details waits for (FR-CAP-002), or null. */
  readonly pendingPayoutApprovalRequestId: string | null;
  readonly joinedOn: string;
  readonly status: InvestorRecord['status'];
  readonly units: string;
  readonly sharePercent: string;
  readonly contributedPesewas: number;
  readonly withdrawnPesewas: number;
  readonly currency: 'GHS';
  readonly version: number;
}

/** The contract's `CapitalTransaction`. */
export interface CapitalTransactionView {
  readonly id: string;
  readonly transactionNo: string;
  readonly investor: InvestorRefView;
  readonly kind: CapitalTransactionRecord['kind'];
  readonly amountPesewas: number;
  readonly valueDate: string;
  readonly unitPricePesewas: number;
  readonly units: string;
  readonly bankAccount: { readonly id: string; readonly name: string; readonly kind: 'BANK' | 'MOBILE_MONEY'; readonly last4: string };
  readonly externalReference: string | null;
  readonly reversesTransactionId: string | null;
  readonly recordedAt: string;
  readonly actor: { readonly id: string; readonly displayName: string };
  readonly currency: 'GHS';
}

/** The contract's `ApprovalPending`. */
export interface ApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: string;
  readonly subject: { readonly id: string; readonly docType: string; readonly number: string | null };
  readonly summary: string;
  readonly requestedAt: string;
}

/** The contract's `CapitalRegister`: each investor's holding on a date. */
export interface CapitalRegisterView extends Page<{
  readonly investor: InvestorRefView;
  readonly units: string;
  readonly sharePercent: string;
  readonly contributedPesewas: number;
  readonly withdrawnPesewas: number;
  readonly netCapitalPesewas: number;
}> {
  readonly asOf: string;
  readonly totalUnits: string;
  readonly totalNetCapitalPesewas: number;
  readonly currency: 'GHS';
}

export interface InvestorCreate {
  readonly kind: InvestorRecord['kind'];
  readonly legalName: string;
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
  readonly joinedOn: string;
  readonly idNumber?: string | undefined;
  readonly payout?: unknown;
  readonly agreementFileId?: string | undefined;
  readonly createPortalLogin?: boolean | undefined;
}

export interface InvestorUpdate {
  readonly version: number;
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
  readonly status?: InvestorRecord['status'] | undefined;
  readonly payout?: unknown;
  readonly idNumber?: string | undefined;
  readonly createPortalLogin?: boolean | undefined;
}

/** The sealed and linked fields, handed to `InvestorProfiles` once it is attached (B12 continued, FR-CAP-002). */
const profileFields = (request: InvestorCreate | InvestorUpdate): ProfileRequest => {
  const r = request as InvestorCreate;
  return { idNumber: r.idNumber, payout: r.payout as InvestorPayout | undefined, agreementFileId: r.agreementFileId, createPortalLogin: r.createPortalLogin };
};

export interface CapitalTransactionCreate {
  readonly kind: CapitalTransactionRecord['kind'];
  readonly investorId: string;
  readonly amountPesewas: bigint;
  readonly valueDate: string;
  readonly unitPricePesewas?: bigint | undefined;
  readonly bankAccountId: string;
  readonly externalReference?: string | undefined;
}

const json = (n: bigint): number => Money.ofPesewas(n).toJsonInteger();
export const investorRef = (i: InvestorRecord): InvestorRefView => ({ id: i.id, investorNo: i.investorNo, name: i.legalName });
export const movementOf = (t: CapitalTransactionRecord): UnitMovement => ({ investorId: t.investorId, kind: t.kind === 'CONTRIBUTION' ? 'ISSUE' : 'REDEEM', unitsE4: t.unitsE4, effectiveOn: t.valueDate });

const withdrawalHash = (w: { readonly id: string; readonly investorId: string; readonly amountPesewas: bigint; readonly valueDate: string; readonly unitPricePesewas: bigint; readonly bankAccountId: string }) =>
  createHash('sha256')
    .update(
      canonicalJson({ id: w.id, investorId: w.investorId, amountPesewas: w.amountPesewas.toString(), valueDate: w.valueDate, unitPricePesewas: w.unitPricePesewas.toString(), bankAccountId: w.bankAccountId }),
      'utf8',
    )
    .digest('hex');

/**
 * The investor register and capital (FR-CAP-001, FR-CAP-003 to FR-CAP-005, ADR-0028). The investor books are kept at
 * the head office branch: every command and read authorises its permission there, deny by default, so a grant at
 * another branch reads nothing (A-381). A contribution issues units at its value date (the amount over the unit price,
 * exactly) and posts ◆ `cap.CapitalContributed` (Dr 1100 or 1110, Cr 3000 against the investor) in the same
 * transaction; capital arrives through CAP to the farm's bank or mobile money account, never as cash (A-212 (a)). A
 * withdrawal is asked for (202) and nothing moves until someone else holding `cap.capital.approve` approves it with
 * step-up; then the units are redeemed from its value date and ◆ `cap.CapitalWithdrawn` posts (Dr 3000, Cr the bank),
 * the database refusing more units than are held that day or any day after. Every change is audited.
 */
export class Capital {
  private readonly nextId: () => string;
  private profiles: InvestorProfiles | null = null;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: CapStore,
    private readonly refs: MasterDataRefs,
    private readonly bankAccounts: BankAccounts,
    private readonly periods: Periods,
    private readonly journals: Journals,
    private readonly registry: DocumentRegistry,
    private readonly numbers: NumberSeries,
    private readonly approvals: Approvals,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly names: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** The sealed and linked particulars (B12 continued), attached once both exist: they authorise through this class. */
  attachProfiles(profiles: InvestorProfiles): void {
    this.profiles = profiles;
  }

  private profilesOf(): InvestorProfiles {
    if (this.profiles === null) throw new Error('the investor profiles are not attached');
    return this.profiles;
  }

  /** The head office branch, where the investor books are kept and every CAP permission is checked. */
  async booksBranchIn(tx: Transaction): Promise<string> {
    const branchId = await this.refs.headOfficeBranchIn(tx);
    if (branchId === null) throw new Error('no head office branch keeps the investor books');
    return branchId;
  }

  /** Authorises a CAP permission at the head office branch and answers it. */
  async authoriseIn(tx: Transaction, actor: Actor | undefined, permission: string): Promise<string> {
    const branchId = await this.booksBranchIn(tx);
    await this.authoriser.authorise(tx, actor, permission, { branchId });
    return branchId;
  }

  listInvestors(actor: Actor | undefined, filter: { readonly status: InvestorRecord['status'] | null }, cursor: string | undefined, limit: number): Promise<Page<InvestorView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriseIn(tx, actor, INVESTOR_READ);
      const binding = { operationId: 'listInvestors', principalId: actor!.principalId, filters: filter };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['investorNo'] ?? null);
      const found = await this.store.investors(tx, filter, after, probe(limit));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      return { data: await this.investorViews(tx, rows), page: { nextCursor: hasMore ? this.cursors.encode(binding, { investorNo: rows.at(-1)!.investorNo }) : null, limit, hasMore } };
    });
  }

  getInvestor(actor: Actor | undefined, id: string): Promise<InvestorView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriseIn(tx, actor, INVESTOR_READ);
      const investor = await this.store.investor(tx, id, false);
      if (investor === null) throw new NotFoundError(`no investor ${id}`);
      return (await this.investorViews(tx, [investor]))[0]!;
    });
  }

  /** createInvestor (FR-CAP-001): numbered INV-001, INV-002 in order, never reused. */
  createInvestor(actor: Actor | undefined, request: InvestorCreate, key: string): Promise<StoredResponse<InvestorView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const branchId = await this.authoriseIn(tx, actor, INVESTOR_MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: 'createInvestor', principalId: actor!.principalId, key, request });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<InvestorView>;
      const record: InvestorRecord = {
        id: this.nextId(),
        investorNo: await this.store.nextInvestorNo(tx),
        kind: request.kind,
        legalName: request.legalName.trim(),
        phone: request.phone ?? null,
        email: request.email ?? null,
        principalId: null,
        payoutMethod: null,
        payoutLast4: null,
        payoutMasked: null,
        idNumberMasked: null,
        hasIdNumber: false,
        joinedOn: request.joinedOn,
        status: 'ACTIVE',
        version: 1,
      };
      await this.store.insertInvestor(tx, record, actor!.principalId, this.clock.now());
      await this.profilesOf().applyIn(tx, actor!, branchId, record, profileFields(request));
      const view = (await this.investorViews(tx, [(await this.store.investor(tx, record.id, false))!]))[0]!;
      await this.audit.record(tx, { module: 'cap', action: 'CREATE', entityType: 'Investor', entityId: record.id, branchId, before: null, after: { ...view } });
      const response: StoredResponse<InvestorView> = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** updateInvestor (FR-CAP-001): contact details and status at the version read; an investor holding units cannot exit. */
  updateInvestor(actor: Actor | undefined, id: string, request: InvestorUpdate, key: string): Promise<StoredResponse<InvestorView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const branchId = await this.authoriseIn(tx, actor, INVESTOR_MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: 'updateInvestor', principalId: actor!.principalId, key, request: { id, ...request } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<InvestorView>;
      const investor = await this.store.investor(tx, id, true);
      if (investor === null) throw new NotFoundError(`no investor ${id}`);
      if (investor.version !== request.version) throw new VersionConflictError(`investor ${id} is at version ${investor.version}`);
      const status = request.status ?? investor.status;
      if (status === 'EXITED' && investor.status !== 'EXITED') {
        const holding = (await this.store.holdingsIn(tx, [id])).get(id);
        if (holding !== undefined && holding.unitsE4 > 0n) throw new InvestorInvalidError([{ field: '/status', rule: 'INVESTOR_HAS_UNITS' }]);
      }
      const before = (await this.investorViews(tx, [investor]))[0]!;
      await this.store.updateInvestor(tx, id, { phone: request.phone ?? investor.phone, email: request.email ?? investor.email, status }, actor!.principalId, this.clock.now());
      await this.profilesOf().applyIn(tx, actor!, branchId, (await this.store.investor(tx, id, true))!, profileFields(request));
      const view = (await this.investorViews(tx, [(await this.store.investor(tx, id, false))!]))[0]!;
      await this.audit.record(tx, { module: 'cap', action: 'UPDATE', entityType: 'Investor', entityId: id, branchId, before: { ...before }, after: { ...view } });
      const response: StoredResponse<InvestorView> = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * recordCapitalTransaction: a contribution is written and posted (201); a withdrawal waits for approval (202). Both
   * name the farm's own active bank or mobile money account the money arrived in or leaves from.
   */
  record(actor: Actor | undefined, request: CapitalTransactionCreate, key: string): Promise<StoredResponse<CapitalTransactionView | ApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const branchId = await this.authoriseIn(tx, actor, CAPITAL_RECORD);
      const claim = await this.idempotency.claim(tx, {
        operationId: 'recordCapitalTransaction',
        principalId: actor!.principalId,
        key,
        request: { ...request, amountPesewas: request.amountPesewas.toString(), unitPricePesewas: request.unitPricePesewas?.toString() },
      });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<CapitalTransactionView | ApprovalPendingView>;
      const unitPrice = request.unitPricePesewas ?? DEFAULT_UNIT_PRICE_PESEWAS;
      const { investor, units, postingDate } = await this.checkIn(tx, request, unitPrice);
      const response =
        request.kind === 'CONTRIBUTION'
          ? await this.contributeIn(tx, actor!, branchId, investor, request, unitPrice, units, postingDate)
          : await this.askWithdrawalIn(tx, actor!, branchId, investor, request, unitPrice, units);
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  getTransaction(actor: Actor | undefined, id: string): Promise<CapitalTransactionView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriseIn(tx, actor, CAPITAL_READ);
      const record = await this.store.transaction(tx, id);
      if (record === null) throw new NotFoundError(`no capital transaction ${id}`);
      return (await this.transactionViews(tx, [record]))[0]!;
    });
  }

  listTransactions(
    actor: Actor | undefined,
    filter: { readonly investorId: string | null; readonly kind: CapitalTransactionRecord['kind'] | null; readonly from: string | null; readonly to: string | null },
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<CapitalTransactionView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriseIn(tx, actor, CAPITAL_READ);
      const binding = { operationId: 'listCapitalTransactions', principalId: actor!.principalId, filters: filter };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after = position === null ? null : { key: position['valueDate']!, id: position['id']! };
      const found = await this.store.transactions(tx, filter, after, probe(limit));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      const last = rows.at(-1);
      return { data: await this.transactionViews(tx, rows), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { valueDate: last.valueDate, id: last.id }) : null, limit, hasMore } };
    });
  }

  /** One investor's capital transactions, a page, for the portal (the investor is the signed-in one, never a request's id). */
  async transactionPageIn(tx: Transaction, actor: Actor, operationId: string, investorId: string, cursor: string | undefined, limit: number): Promise<Page<CapitalTransactionView>> {
    const filter = { investorId, kind: null, from: null, to: null };
    const binding = { operationId, principalId: actor.principalId, filters: filter };
    const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
    const after = position === null ? null : { key: position['valueDate']!, id: position['id']! };
    const found = await this.store.transactions(tx, filter, after, probe(limit));
    const rows = found.slice(0, limit);
    const hasMore = found.length > limit;
    const last = rows.at(-1);
    return { data: await this.transactionViews(tx, rows), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { valueDate: last.valueDate, id: last.id }) : null, limit, hasMore } };
  }

  /**
   * getCapitalRegister (FR-CAP-005): each investor's units on the date (issues on or before it, less redemptions on or
   * before it), their share of the units in issue that day to four places, and what they had paid in and taken out by
   * then; totals over every investor, not the page. Today when no date is given.
   */
  register(actor: Actor | undefined, asOfDate: string | null, cursor: string | undefined, limit: number): Promise<CapitalRegisterView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriseIn(tx, actor, CAPITAL_READ);
      const asOf = asOfDate ?? toBusinessDate(this.clock.now());
      const transactions = await this.store.transactionsUpTo(tx, asOf);
      const held = heldOn(transactions.map(movementOf), asOf);
      const money = new Map<string, { contributed: bigint; withdrawn: bigint }>();
      for (const t of transactions) {
        const m = money.get(t.investorId) ?? { contributed: 0n, withdrawn: 0n };
        if (t.kind === 'CONTRIBUTION') m.contributed += t.amountPesewas;
        else m.withdrawn += t.amountPesewas;
        money.set(t.investorId, m);
      }
      const total = [...held.values()].reduce((a, b) => a + b, 0n);
      const investors = [...(await this.store.investorsIn(tx, [...held.keys()])).values()].sort(byInvestorNo);
      const binding = { operationId: 'getCapitalRegister', principalId: actor!.principalId, filters: { asOf } };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['investorNo'] ?? null);
      const listed = after === null ? investors : investors.filter((i) => i.investorNo.length > after.length || (i.investorNo.length === after.length && i.investorNo > after));
      const rows = listed.slice(0, limit);
      const hasMore = listed.length > limit;
      const net = (id: string) => (money.get(id)?.contributed ?? 0n) - (money.get(id)?.withdrawn ?? 0n);
      return {
        data: rows.map((i) => ({
          investor: investorRef(i),
          units: formatUnits(held.get(i.id) ?? 0n),
          sharePercent: sharePercent(held.get(i.id) ?? 0n, total),
          contributedPesewas: json(money.get(i.id)?.contributed ?? 0n),
          withdrawnPesewas: json(money.get(i.id)?.withdrawn ?? 0n),
          netCapitalPesewas: json(net(i.id) > 0n ? net(i.id) : 0n),
        })),
        page: { nextCursor: hasMore ? this.cursors.encode(binding, { investorNo: rows.at(-1)!.investorNo }) : null, limit, hasMore },
        asOf,
        totalUnits: formatUnits(total),
        totalNetCapitalPesewas: json(investors.reduce((sum, i) => sum + (net(i.id) > 0n ? net(i.id) : 0n), 0n)),
        currency: 'GHS',
      };
    });
  }

  /** IAM's `CAPITAL_WITHDRAWAL` handler: on approval the units are redeemed and the money posted, in the approving transaction. */
  readonly withdrawalHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, id) => {
      const request = await this.store.withdrawalRequest(tx, id);
      if (request === null) throw new NotFoundError(`no capital withdrawal ${id}`);
      return withdrawalHash(request);
    },
    onApproved: async (tx: Transaction, approval: ApprovalRecord) => {
      const request = await this.store.withdrawalByApproval(tx, approval.id);
      if (request === null || request.status !== 'PENDING_APPROVAL') throw new NotFoundError(`no capital withdrawal waiting under approval ${approval.id}`);
      // ADR-0017 here as well as in IAM and the database: the maker never checks.
      if (approval.decidedBy === null || approval.decidedBy === request.createdBy) throw new MakerCannotCheckError('the person who asked for this withdrawal cannot approve it');
      await this.withdrawIn(tx, request, approval.decidedBy);
    },
    onRejected: async (tx: Transaction, approval: ApprovalRecord) => {
      const request = await this.store.withdrawalByApproval(tx, approval.id);
      if (request === null || request.status !== 'PENDING_APPROVAL') return;
      await this.store.decideWithdrawal(tx, request.id, { status: approval.status === 'CANCELLED' ? 'CANCELLED' : 'REJECTED', by: approval.decidedBy ?? approval.requestedBy, at: this.clock.now() });
    },
  };

  /** The rules both kinds share, then the kind's own: the investor, the account, the units, the date and its period. */
  private async checkIn(tx: Transaction, request: CapitalTransactionCreate, unitPrice: bigint): Promise<{ investor: InvestorRecord; units: bigint; postingDate: string }> {
    const broken: CapRule[] = [];
    const investor = await this.store.investor(tx, request.investorId, false);
    if (investor === null) broken.push({ field: '/investorId', rule: 'INVESTOR_UNKNOWN' });
    else if (investor.status === 'EXITED' && request.kind === 'CONTRIBUTION') broken.push({ field: '/investorId', rule: 'INVESTOR_EXITED' });
    const account = (await this.bankAccounts.payoutAccountsIn(tx, [request.bankAccountId])).get(request.bankAccountId);
    if (account === undefined) broken.push({ field: '/bankAccountId', rule: 'BANK_ACCOUNT_UNKNOWN' });
    else if (!account.isActive) broken.push({ field: '/bankAccountId', rule: 'BANK_ACCOUNT_INACTIVE' });
    const units = unitsFor(Money.ofPesewas(request.amountPesewas), Money.ofPesewas(unitPrice));
    if (!units.ok) broken.push({ field: '/amountPesewas', rule: units.error });
    const today = toBusinessDate(this.clock.now());
    let postingDate = request.valueDate;
    if (request.valueDate > today) broken.push({ field: '/valueDate', rule: 'VALUE_DATE_IN_FUTURE' });
    else {
      const periods = await this.periods.allIn(tx);
      const first = periods[0];
      // Before the books begin, the money is brought in on the ledger's first day; the units still count from the value date (A-380).
      if (first !== undefined && request.valueDate < first.startDate) postingDate = first.startDate;
      const period = periods.find((p) => p.startDate <= postingDate && postingDate <= p.endDate);
      if (period === undefined || period.status !== 'OPEN') broken.push({ field: '/valueDate', rule: 'PERIOD_NOT_OPEN' });
    }
    if (broken.length > 0) throw new CapitalTransactionInvalidError(broken);
    return { investor: investor!, units: (units as { value: bigint }).value, postingDate };
  }

  private async contributeIn(
    tx: Transaction,
    actor: Actor,
    branchId: string,
    investor: InvestorRecord,
    request: CapitalTransactionCreate,
    unitPrice: bigint,
    units: bigint,
    postingDate: string,
  ): Promise<StoredResponse<CapitalTransactionView>> {
    const record = await this.writeIn(tx, actor.principalId, branchId, investor, {
      kind: 'CONTRIBUTION',
      amountPesewas: request.amountPesewas,
      valueDate: request.valueDate,
      postingDate,
      unitPricePesewas: unitPrice,
      unitsE4: units,
      bankAccountId: request.bankAccountId,
      externalReference: request.externalReference ?? null,
      approvalRequestId: null,
      withdrawalRequestId: null,
      requestedBy: null,
    });
    return { status: 201, body: (await this.transactionViews(tx, [record]))[0]! };
  }

  private async askWithdrawalIn(
    tx: Transaction,
    actor: Actor,
    branchId: string,
    investor: InvestorRecord,
    request: CapitalTransactionCreate,
    unitPrice: bigint,
    units: bigint,
  ): Promise<StoredResponse<ApprovalPendingView>> {
    const movements = (await this.store.transactionsOfLocked(tx, investor.id)).map(movementOf);
    const broken = judgeWithdrawal(movements, investor.id, units, request.valueDate);
    if (broken.length > 0) throw new CapitalTransactionInvalidError(broken.map((rule) => ({ field: '/amountPesewas', rule })));
    const id = this.nextId();
    const at = this.clock.now();
    const base = { id, investorId: investor.id, amountPesewas: request.amountPesewas, valueDate: request.valueDate, unitPricePesewas: unitPrice, bankAccountId: request.bankAccountId };
    const summary = `Pay ${formatCedis(request.amountPesewas)} of capital back to ${investor.legalName} (${investor.investorNo}), redeeming ${formatUnits(units)} units from ${request.valueDate}`;
    await this.registry.register(tx, { id, docType: CAPITAL_WITHDRAWAL, ownerModule: 'cap', branchId, actorId: actor.principalId });
    const approval = await this.approvals.request(tx, actor, { kind: CAPITAL_WITHDRAWAL, branchId, subjectDocumentId: id, payloadHash: withdrawalHash(base), amountPesewas: request.amountPesewas, summary });
    const withdrawal: WithdrawalRequestRecord = {
      ...base,
      branchId,
      unitsE4: units,
      externalReference: request.externalReference ?? null,
      approvalRequestId: approval.id,
      status: 'PENDING_APPROVAL',
      createdBy: actor.principalId,
      createdAt: at,
    };
    await this.store.insertWithdrawalRequest(tx, withdrawal);
    await this.audit.record(tx, {
      module: 'cap',
      action: 'ASK_WITHDRAWAL',
      entityType: 'CapitalWithdrawal',
      entityId: id,
      branchId,
      before: null,
      after: { investorId: investor.id, amountPesewas: json(request.amountPesewas), units: formatUnits(units), valueDate: request.valueDate, approvalRequestId: approval.id },
    });
    return {
      status: 202,
      body: { status: 'PENDING_APPROVAL', approvalRequestId: approval.id, kind: CAPITAL_WITHDRAWAL, subject: { id, docType: CAPITAL_WITHDRAWAL, number: null }, summary, requestedAt: approval.requestedAt.toISOString() },
    };
  }

  private async withdrawIn(tx: Transaction, request: WithdrawalRequestRecord, approvedBy: string): Promise<void> {
    const investor = (await this.store.investor(tx, request.investorId, false))!;
    const movements = (await this.store.transactionsOfLocked(tx, investor.id)).map(movementOf);
    if (judgeWithdrawal(movements, investor.id, request.unitsE4, request.valueDate).length > 0) {
      throw new CapitalTransactionInvalidError([{ field: '/amountPesewas', rule: 'MORE_THAN_HELD' }]);
    }
    const periods = await this.periods.allIn(tx);
    const period = periods.find((p) => p.startDate <= request.valueDate && request.valueDate <= p.endDate);
    if (period === undefined || period.status !== 'OPEN') throw new CapitalTransactionInvalidError([{ field: '/valueDate', rule: 'PERIOD_NOT_OPEN' }]);
    await this.store.decideWithdrawal(tx, request.id, { status: 'APPLIED', by: approvedBy, at: this.clock.now() });
    await this.writeIn(tx, approvedBy, request.branchId, investor, {
      kind: 'WITHDRAWAL',
      amountPesewas: request.amountPesewas,
      valueDate: request.valueDate,
      postingDate: request.valueDate,
      unitPricePesewas: request.unitPricePesewas,
      unitsE4: request.unitsE4,
      bankAccountId: request.bankAccountId,
      externalReference: request.externalReference,
      approvalRequestId: request.approvalRequestId,
      withdrawalRequestId: request.id,
      requestedBy: request.createdBy,
    });
  }

  /** Numbers, posts and writes one capital transaction, and audits it. */
  private async writeIn(
    tx: Transaction,
    actorId: string,
    branchId: string,
    investor: InvestorRecord,
    t: Omit<CapitalTransactionRecord, 'id' | 'transactionNo' | 'investorId' | 'branchId' | 'journalEntryId' | 'recordedAt' | 'actorId'> & { readonly requestedBy: string | null },
  ): Promise<CapitalTransactionRecord> {
    const id = this.nextId();
    const at = this.clock.now();
    const branch = (await this.refs.branchesIn(tx, [branchId])).get(branchId)!;
    await this.registry.register(tx, { id, docType: CAPITAL_TRANSACTION, ownerModule: 'cap', branchId, actorId });
    const transactionNo = await this.numbers.allocateIn(tx, { docType: CAPITAL_TRANSACTION, fiscalYear: Number(t.postingDate.slice(0, 4)), branchId, branchCode: branch.code, documentId: id });
    const type = t.kind === 'CONTRIBUTION' ? CAPITAL_CONTRIBUTED : CAPITAL_WITHDRAWN;
    const payload: CapitalMoved = {
      transactionId: id,
      transactionNo,
      investorId: investor.id,
      investorName: investor.legalName,
      kind: t.kind,
      bankAccountId: t.bankAccountId,
      branchId,
      amountPesewas: json(t.amountPesewas),
      units: formatUnits(t.unitsE4),
      valueDate: t.valueDate,
      postingDate: t.postingDate,
      requestedBy: t.requestedBy,
      approvedBy: t.kind === 'WITHDRAWAL' ? actorId : null,
    };
    await this.events.publish(tx, { type, subjectType: 'CapitalTransaction', subjectId: id, branchId, payload: { ...payload }, occurredAt: at });
    const entry = await this.journals.entryForSubjectIn(tx, type, id);
    if (entry === null) throw new Error(`capital transaction ${id}: the ledger posted no entry`);
    const { requestedBy: _requestedBy, ...fields } = t;
    const record: CapitalTransactionRecord = { ...fields, id, transactionNo, investorId: investor.id, branchId, journalEntryId: entry.id, recordedAt: at, actorId };
    await this.store.insertTransaction(tx, record);
    await this.audit.record(tx, {
      module: 'cap',
      action: t.kind === 'CONTRIBUTION' ? 'CONTRIBUTE' : 'WITHDRAW',
      entityType: 'CapitalTransaction',
      entityId: id,
      branchId,
      before: null,
      after: { ...payload, journalEntryId: entry.id, journalEntryNo: entry.entryNo },
    });
    return record;
  }

  async investorViews(tx: Transaction, rows: readonly InvestorRecord[]): Promise<InvestorView[]> {
    const holdings = await this.store.holdingsIn(tx, rows.map((r) => r.id));
    const total = await this.store.unitsInIssue(tx);
    const none: HoldingRecord = { investorId: '', unitsE4: 0n, contributedPesewas: 0n, withdrawnPesewas: 0n };
    const pending = await this.profilesOf().pendingApprovalsIn(tx, rows.map((r) => r.id));
    return rows.map((r) => {
      const h = holdings.get(r.id) ?? none;
      return {
        id: r.id,
        investorNo: r.investorNo,
        kind: r.kind,
        legalName: r.legalName,
        phone: r.phone,
        email: r.email,
        hasPortalLogin: r.principalId !== null,
        idNumberMasked: r.idNumberMasked,
        payoutMethod: r.payoutMethod,
        payoutDetailsMasked: r.payoutMasked,
        pendingPayoutApprovalRequestId: pending.get(r.id) ?? null,
        joinedOn: r.joinedOn,
        status: r.status,
        units: formatUnits(h.unitsE4),
        sharePercent: sharePercent(h.unitsE4, total),
        contributedPesewas: json(h.contributedPesewas),
        withdrawnPesewas: json(h.withdrawnPesewas),
        currency: 'GHS',
        version: r.version,
      };
    });
  }

  private async transactionViews(tx: Transaction, rows: readonly CapitalTransactionRecord[]): Promise<CapitalTransactionView[]> {
    const investors = await this.store.investorsIn(tx, rows.map((r) => r.investorId));
    const accounts = await this.bankAccounts.payoutAccountsIn(tx, rows.map((r) => r.bankAccountId));
    const people = await this.names.refs(tx, rows.map((r) => r.actorId));
    return rows.map((r) => {
      const account = accounts.get(r.bankAccountId)!;
      return {
        id: r.id,
        transactionNo: r.transactionNo,
        investor: investorRef(investors.get(r.investorId)!),
        kind: r.kind,
        amountPesewas: json(r.amountPesewas),
        valueDate: r.valueDate,
        unitPricePesewas: json(r.unitPricePesewas),
        units: formatUnits(r.unitsE4),
        bankAccount: { id: account.id, name: account.name, kind: account.kind, last4: account.last4 },
        externalReference: r.externalReference,
        reversesTransactionId: null,
        recordedAt: r.recordedAt.toISOString(),
        actor: people.get(r.actorId) ?? { id: r.actorId, displayName: 'Unknown' },
        currency: 'GHS',
      };
    });
  }
}
