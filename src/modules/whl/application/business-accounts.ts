import { createHash } from 'node:crypto';
import { createUuidV7Generator, formatCedis, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames } from '../../iam';
import type { MasterDataRefs, PartiesAdmin } from '../../mdm';
import { availableCredit, holdTrigger } from '../domain/credit';
import { pageProbe } from '../domain/paging';
import type { AccountChangeRecord, AccountRecord, AccountStore } from './account-store';
import type { CreditControl } from './credit-control';
import { AccountExistsError, AccountInvalidError, AskerCannotApproveError } from './errors';

export const ACCOUNT_CHANGE = 'ACCOUNT_CHANGE';
export const ACCOUNT_RELEASE_KIND = 'ACCOUNT_RELEASE';
export const CREDIT_LIMIT_CHANGE_KIND = 'CREDIT_LIMIT_CHANGE';
export const ACCOUNT_HELD = 'whl.AccountHeld';
export const ACCOUNT_RELEASED = 'whl.AccountReleased';
export const CREDIT_LIMIT_CHANGED = 'whl.CreditLimitChanged';
const READ = 'whl.account.read';
const MANAGE = 'whl.account.manage';
const HOLD = 'whl.account.hold';
const RELEASE = 'whl.account.release';
/** FR-WHL-008's seed threshold (SA-05): an account is held when an invoice is more than 30 days past due. */
export const DEFAULT_OVERDUE_HOLD_DAYS = 30;
const HOLD_BATCH = 200;

type Ref = { readonly id: string; readonly displayName: string };

/** The contract's `BusinessAccount`. Every figure is the server's, as at the moment of reading. */
export interface BusinessAccountView {
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string };
  readonly branch: { readonly id: string; readonly code: string; readonly name: string };
  readonly creditLimitPesewas: number;
  readonly paymentTermsDays: number;
  readonly accountManager: Ref | null;
  readonly overdueHoldDays: number;
  readonly status: AccountRecord['status'];
  readonly holdReason: string | null;
  readonly heldAt: string | null;
  readonly exposurePesewas: number;
  readonly availableCreditPesewas: number;
  readonly overduePesewas: number;
  readonly oldestOverdueDays: number | null;
  readonly priceList: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly pendingCreditLimitPesewas: number | null;
  readonly pendingRelease: boolean;
  readonly currency: 'GHS';
  readonly version: number;
}

/** The 202 a change waiting for its second person answers. */
export interface ApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: string;
  readonly subject: { readonly id: string; readonly docType: string; readonly number: string | null };
  readonly summary: string;
  readonly requestedAt: string;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

export interface AccountCreateRequest {
  readonly customerId: string;
  readonly branchId?: string | undefined;
  readonly creditLimitPesewas: bigint;
  readonly paymentTermsDays: number;
  readonly accountManagerId?: string | undefined;
  readonly overdueHoldDays?: number | undefined;
  readonly reason?: string | undefined;
  /** Not taken: the list is set through MDM (A-314 (b)). */
  readonly priceListId?: string | undefined;
}

export interface AccountUpdateRequest {
  readonly version: number;
  readonly creditLimitPesewas?: bigint | undefined;
  readonly paymentTermsDays?: number | undefined;
  readonly accountManagerId?: string | null | undefined;
  readonly overdueHoldDays?: number | undefined;
  readonly status?: 'ACTIVE' | 'CLOSED' | undefined;
  readonly reason?: string | undefined;
  /** Not taken: the list is set through MDM (A-314 (b)). */
  readonly priceListId?: string | undefined;
}

export interface AccountQuery {
  readonly status: string | null;
  readonly accountManagerId: string | null;
  readonly overLimit: boolean | null;
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();
const changeHash = (change: { readonly id: string; readonly customerId: string; readonly kind: string; readonly creditLimitPesewas: bigint | null }) =>
  createHash('sha256')
    .update(canonicalJson({ id: change.id, customerId: change.customerId, kind: change.kind, creditLimitPesewas: change.creditLimitPesewas?.toString() ?? null }), 'utf8')
    .digest('hex');

/**
 * Business accounts (FR-WHL-001, FR-WHL-008, CR-048): a customer's credit terms at a home branch. Terms, the account
 * manager and the hold threshold change at once; every change to a credit limit, up or down, and every release of a
 * hold wait for an Owner or Manager who did not ask (`CREDIT_LIMIT_CHANGE`, `ACCOUNT_RELEASE`), held in the
 * application and by the database (migration 0259). The Accountant may put an account on hold, never release it. The
 * daily job holds an account with anything more than its threshold's days past due. Every read and write is authorised
 * at the account's branch.
 */
export class BusinessAccounts {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: AccountStore,
    private readonly credit: CreditControl,
    private readonly refs: MasterDataRefs,
    private readonly parties: PartiesAdmin,
    private readonly approvals: Approvals,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly registry: DocumentRegistry,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, query: AccountQuery, cursor: string | undefined, limit: number): Promise<Page<BusinessAccountView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = await this.wholeBranches(tx, actor!, READ);
      const binding = { operationId: 'listBusinessAccounts', principalId: actor!.principalId, filters: query };
      let after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const views: BusinessAccountView[] = [];
      // `overLimit` is a figure, not a column: read in batches and keep the matching accounts until the page is full.
      for (;;) {
        const batch = await this.store.accounts(tx, { branchIds, status: query.status, accountManagerId: query.accountManagerId }, after, pageProbe(limit));
        for (const view of await this.views(tx, batch)) {
          if (query.overLimit === null || (view.exposurePesewas > view.creditLimitPesewas) === query.overLimit) views.push(view);
        }
        if (batch.length < pageProbe(limit) || views.length > limit) break;
        after = batch.at(-1)!.customerId;
      }
      const data = views.slice(0, limit);
      const hasMore = views.length > limit;
      return { data, page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: data.at(-1)!.customer.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, customerId: string): Promise<BusinessAccountView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const account = await this.store.account(tx, customerId, false);
      if (account === null) throw new NotFoundError(`no business account for ${customerId}`);
      await this.authoriser.authorise(tx, actor, READ, { branchId: account.branchId });
      return (await this.views(tx, [account]))[0]!;
    });
  }

  /**
   * createBusinessAccount (FR-WHL-001): opens credit terms for a live customer at a branch, with a nil limit. A limit
   * asked for is a credit limit change like any other (CR-048): 202 with its approval, the account open meanwhile.
   */
  create(actor: Actor | undefined, request: AccountCreateRequest, key: string): Promise<StoredResponse<BusinessAccountView | ApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      let branchId = request.branchId;
      if (branchId === undefined) {
        const branches = await this.wholeBranches(tx, actor!, MANAGE);
        if (branches.length !== 1) throw new AccountInvalidError([{ field: '/branchId', rule: 'BRANCH_REQUIRED' }]);
        branchId = branches[0]!;
      }
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId });
      if (request.priceListId !== undefined) throw new AccountInvalidError([{ field: '/priceListId', rule: 'PRICE_LIST_THROUGH_MDM' }]);
      const claim = await this.idempotency.claim(tx, { operationId: 'createBusinessAccount', principalId: actor!.principalId, key, request: { ...request, branchId, creditLimitPesewas: request.creditLimitPesewas.toString() } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<BusinessAccountView | ApprovalPendingView>;
      const customer = (await this.refs.customersIn(tx, [request.customerId])).get(request.customerId);
      if (customer === undefined || !customer.isLive) throw new AccountInvalidError([{ field: '/customerId', rule: 'CUSTOMER_UNKNOWN' }]);
      if (request.accountManagerId !== undefined && !(await this.principals.refs(tx, [request.accountManagerId])).has(request.accountManagerId))
        throw new AccountInvalidError([{ field: '/accountManagerId', rule: 'MANAGER_UNKNOWN' }]);
      if ((await this.store.account(tx, request.customerId, true)) !== null) throw new AccountExistsError(`customer ${request.customerId} already has a business account`);
      const at = this.clock.now();
      await this.store.insertAccount(
        tx,
        { customerId: customer.id, branchId, paymentTermsDays: request.paymentTermsDays, accountManagerId: request.accountManagerId ?? null, overdueHoldDays: request.overdueHoldDays ?? DEFAULT_OVERDUE_HOLD_DAYS },
        actor!.principalId,
        at,
      );
      const opened = (await this.store.account(tx, customer.id, true))!;
      await this.audit.record(tx, { module: 'whl', action: 'OPEN_ACCOUNT', entityType: 'BusinessAccount', entityId: customer.id, branchId, after: { ...this.auditOf(opened) } });
      const response: StoredResponse<BusinessAccountView | ApprovalPendingView> =
        request.creditLimitPesewas === 0n
          ? { status: 201, body: (await this.views(tx, [opened]))[0]! }
          : { status: 202, body: await this.askLimitIn(tx, actor!, opened, request.creditLimitPesewas, request.reason ?? 'Opening credit limit', customer.name) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * updateBusinessAccount (FR-WHL-001, CR-048): the terms, the account manager, the hold threshold and closing or
   * reopening change at once; a new credit limit, up or down, waits for an Owner or Manager who did not ask (202). An
   * account on hold is released through releaseBusinessAccount, never by an edit.
   */
  update(actor: Actor | undefined, customerId: string, request: AccountUpdateRequest, key: string): Promise<StoredResponse<BusinessAccountView | ApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const account = await this.store.account(tx, customerId, true);
      if (account === null) throw new NotFoundError(`no business account for ${customerId}`);
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId: account.branchId });
      const claim = await this.idempotency.claim(tx, { operationId: 'updateBusinessAccount', principalId: actor!.principalId, key, request: { customerId, ...request, creditLimitPesewas: request.creditLimitPesewas?.toString() ?? null } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<BusinessAccountView | ApprovalPendingView>;
      if (request.priceListId !== undefined) throw new AccountInvalidError([{ field: '/priceListId', rule: 'PRICE_LIST_THROUGH_MDM' }]);
      if (account.version !== request.version) throw new VersionConflictError(`business account ${customerId} is at version ${String(account.version)}`);
      if (request.status !== undefined && request.status !== account.status && account.status === 'ON_HOLD') throw new AccountInvalidError([{ field: '/status', rule: 'ACCOUNT_ON_HOLD' }]);
      if (request.accountManagerId !== undefined && request.accountManagerId !== null && !(await this.principals.refs(tx, [request.accountManagerId])).has(request.accountManagerId))
        throw new AccountInvalidError([{ field: '/accountManagerId', rule: 'MANAGER_UNKNOWN' }]);
      const limitAsked = request.creditLimitPesewas !== undefined && request.creditLimitPesewas !== account.creditLimitPesewas ? request.creditLimitPesewas : null;
      if (limitAsked !== null && account.status === 'CLOSED' && request.status !== 'ACTIVE') throw new AccountInvalidError([{ field: '/creditLimitPesewas', rule: 'ACCOUNT_CLOSED' }]);
      const at = this.clock.now();
      const terms = {
        paymentTermsDays: request.paymentTermsDays ?? account.paymentTermsDays,
        accountManagerId: request.accountManagerId === undefined ? account.accountManagerId : request.accountManagerId,
        overdueHoldDays: request.overdueHoldDays ?? account.overdueHoldDays,
        // An account on hold keeps its hold: only its terms move here.
        status: account.status === 'ON_HOLD' ? account.status : (request.status ?? account.status),
      };
      if (terms.paymentTermsDays !== account.paymentTermsDays || terms.accountManagerId !== account.accountManagerId || terms.overdueHoldDays !== account.overdueHoldDays || terms.status !== account.status) {
        await this.store.updateTerms(tx, customerId, terms, actor!.principalId, at);
        const after = (await this.store.account(tx, customerId, true))!;
        await this.audit.record(tx, { module: 'whl', action: 'UPDATE_TERMS', entityType: 'BusinessAccount', entityId: customerId, branchId: account.branchId, before: { ...this.auditOf(account) }, after: { ...this.auditOf(after) } });
      }
      const current = (await this.store.account(tx, customerId, true))!;
      let response: StoredResponse<BusinessAccountView | ApprovalPendingView>;
      if (limitAsked === null) response = { status: 200, body: (await this.views(tx, [current]))[0]! };
      else {
        const customer = (await this.refs.customersIn(tx, [customerId])).get(customerId);
        response = { status: 202, body: await this.askLimitIn(tx, actor!, current, limitAsked, request.reason ?? 'Credit limit change', customer?.name ?? 'the customer') };
      }
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** holdBusinessAccount (FR-WHL-008, CR-048): an Owner, Manager or Accountant puts an active account on hold with a reason. */
  hold(actor: Actor | undefined, customerId: string, request: { readonly reason: string }, key: string): Promise<StoredResponse<BusinessAccountView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, HOLD);
      const account = await this.store.account(tx, customerId, true);
      if (account === null) throw new NotFoundError(`no business account for ${customerId}`);
      await this.authoriser.authorise(tx, actor, HOLD, { branchId: account.branchId });
      const claim = await this.idempotency.claim(tx, { operationId: 'holdBusinessAccount', principalId: actor!.principalId, key, request: { customerId, reason: request.reason } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<BusinessAccountView>;
      if (account.status !== 'ACTIVE') throw new AccountInvalidError([{ field: '/status', rule: account.status === 'ON_HOLD' ? 'ALREADY_ON_HOLD' : 'ACCOUNT_CLOSED' }]);
      const held = await this.holdIn(tx, account, { reason: request.reason, documentId: null, by: actor!.principalId, automatic: false });
      const response = { status: 200, body: (await this.views(tx, [held]))[0]! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * releaseBusinessAccount (CR-048): an Owner or Manager asks for an account on hold to be released, with a reason; 202
   * with the `ACCOUNT_RELEASE` approval, decided by another holder of `whl.account.release`. The account stays on hold
   * until then.
   */
  release(actor: Actor | undefined, customerId: string, request: { readonly reason: string }, key: string): Promise<StoredResponse<ApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, RELEASE);
      const account = await this.store.account(tx, customerId, true);
      if (account === null) throw new NotFoundError(`no business account for ${customerId}`);
      await this.authoriser.authorise(tx, actor, RELEASE, { branchId: account.branchId });
      const claim = await this.idempotency.claim(tx, { operationId: 'releaseBusinessAccount', principalId: actor!.principalId, key, request: { customerId, reason: request.reason } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ApprovalPendingView>;
      if (account.status !== 'ON_HOLD') throw new AccountInvalidError([{ field: '/status', rule: 'NOT_ON_HOLD' }]);
      if ((await this.store.pendingChange(tx, customerId, 'RELEASE')) !== null) throw new AccountInvalidError([{ field: '/status', rule: 'APPROVAL_PENDING' }]);
      const customer = (await this.refs.customersIn(tx, [customerId])).get(customerId);
      const body = await this.askIn(tx, actor!, account, { kind: 'RELEASE', creditLimitPesewas: null, reason: request.reason }, ACCOUNT_RELEASE_KIND, `Release ${customer?.name ?? 'the customer'} from hold (${account.holdReason ?? 'on hold'}). Reason: ${request.reason}`);
      const response: StoredResponse<ApprovalPendingView> = { status: 202, body };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * The overdue hold (FR-WHL-008), run daily by the worker as the Scheduler: every active account with anything
   * outstanding more than its threshold's days past due is held, naming the invoice. Released only by an approved
   * release (A-313): paying the invoice does not release it on its own.
   */
  async holdOverdue(system: { readonly kind: 'SYSTEM'; readonly principalId: string }): Promise<string[]> {
    if (system.kind !== 'SYSTEM') throw new Error('the overdue hold runs as a SYSTEM principal only');
    const held: string[] = [];
    let after: string | null = null;
    for (;;) {
      const batch: AccountRecord[] = await this.uow.run({ isolation: 'read committed' }, (tx) => this.store.activeAccounts(tx, after, HOLD_BATCH));
      for (const candidate of batch) {
        const done = await this.uow.run({ isolation: 'serializable' }, async (tx) => {
          const account = await this.store.account(tx, candidate.customerId, true);
          if (account === null || account.status !== 'ACTIVE') return false;
          const trigger = holdTrigger(await this.credit.openItemsIn(tx, account.customerId), toBusinessDate(this.clock.now()), account.overdueHoldDays);
          if (trigger === null) return false;
          await this.holdIn(tx, account, {
            reason: `Invoice ${trigger.documentNo ?? trigger.documentId} more than ${String(account.overdueHoldDays)} days overdue (${String(trigger.daysPastDue)} days)`,
            documentId: trigger.documentId,
            by: system.principalId,
            automatic: true,
          });
          return true;
        });
        if (done) held.push(candidate.customerId);
      }
      if (batch.length < HOLD_BATCH) return held;
      after = batch.at(-1)!.customerId;
    }
  }

  // ------------------------------------------------------------------------------------------- approvals

  readonly releaseHandler: ApprovalHandler = this.changeHandler('RELEASE');
  readonly limitHandler: ApprovalHandler = this.changeHandler('CREDIT_LIMIT');

  private changeHandler(kind: 'RELEASE' | 'CREDIT_LIMIT'): ApprovalHandler {
    return {
      currentPayloadHash: async (tx, changeId) => {
        const change = await this.changeOf(tx, changeId, kind);
        return changeHash(change);
      },
      onApproved: async (tx: Transaction, approval: ApprovalRecord) => {
        const change = await this.store.changeByApproval(tx, approval.id);
        if (change === null || change.kind !== kind) throw new NotFoundError(`no account change under approval ${approval.id}`);
        // ADR-0017 here as well as in IAM and the database (ck_account_change_checker): the asker never decides.
        if (approval.decidedBy === null || approval.decidedBy === change.createdBy) throw new AskerCannotApproveError('the person who asked for this change cannot approve it');
        const at = this.clock.now();
        const account = (await this.store.account(tx, change.customerId, true))!;
        await this.store.decideChange(tx, change.id, { status: 'APPLIED', by: approval.decidedBy, reason: null, at });
        if (kind === 'CREDIT_LIMIT') {
          await this.store.setLimit(tx, change.customerId, change.creditLimitPesewas!, change.id, approval.decidedBy, at);
          await this.events.publish(tx, {
            type: CREDIT_LIMIT_CHANGED,
            subjectType: 'BusinessAccount',
            subjectId: change.customerId,
            branchId: change.branchId,
            payload: { customerId: change.customerId, previousLimitPesewas: json(account.creditLimitPesewas), creditLimitPesewas: json(change.creditLimitPesewas!), requestedBy: change.createdBy, approvedBy: approval.decidedBy },
          });
        } else {
          if (account.status !== 'ON_HOLD') throw new AccountInvalidError([{ field: '/status', rule: 'NOT_ON_HOLD' }]);
          await this.store.release(tx, change.customerId, change.id, approval.decidedBy, at);
          await this.events.publish(tx, {
            type: ACCOUNT_RELEASED,
            subjectType: 'BusinessAccount',
            subjectId: change.customerId,
            branchId: change.branchId,
            payload: { customerId: change.customerId, reason: change.reason, requestedBy: change.createdBy, approvedBy: approval.decidedBy },
          });
        }
        const after = (await this.store.account(tx, change.customerId, true))!;
        await this.audit.record(tx, {
          module: 'whl',
          action: kind === 'CREDIT_LIMIT' ? 'CHANGE_CREDIT_LIMIT' : 'RELEASE_HOLD',
          entityType: 'BusinessAccount',
          entityId: change.customerId,
          branchId: change.branchId,
          before: { ...this.auditOf(account) },
          after: { ...this.auditOf(after), changeId: change.id, requestedBy: change.createdBy, approvedBy: approval.decidedBy, reason: change.reason },
        });
      },
      onRejected: async (tx: Transaction, approval: ApprovalRecord) => {
        const change = await this.store.changeByApproval(tx, approval.id);
        if (change === null || change.status !== 'PENDING_APPROVAL') return;
        await this.store.decideChange(tx, change.id, { status: approval.status === 'CANCELLED' ? 'CANCELLED' : 'REJECTED', by: approval.decidedBy ?? approval.requestedBy, reason: null, at: this.clock.now() });
      },
    };
  }

  // ------------------------------------------------------------------------------------------- inside

  private async changeOf(tx: Transaction, changeId: string, kind: 'RELEASE' | 'CREDIT_LIMIT'): Promise<AccountChangeRecord> {
    const change = await this.store.change(tx, changeId);
    if (change === null || change.kind !== kind) throw new NotFoundError(`no account change ${changeId}`);
    return change;
  }

  private async askLimitIn(tx: Transaction, actor: Actor, account: AccountRecord, limit: bigint, reason: string, customerName: string): Promise<ApprovalPendingView> {
    if ((await this.store.pendingChange(tx, account.customerId, 'CREDIT_LIMIT')) !== null) throw new AccountInvalidError([{ field: '/creditLimitPesewas', rule: 'APPROVAL_PENDING' }]);
    return this.askIn(
      tx,
      actor,
      account,
      { kind: 'CREDIT_LIMIT', creditLimitPesewas: limit, reason },
      CREDIT_LIMIT_CHANGE_KIND,
      `Change ${customerName}'s credit limit from ${formatCedis(account.creditLimitPesewas)} to ${formatCedis(limit)}. Reason: ${reason}`,
    );
  }

  private async askIn(
    tx: Transaction,
    actor: Actor,
    account: AccountRecord,
    asked: { readonly kind: 'CREDIT_LIMIT' | 'RELEASE'; readonly creditLimitPesewas: bigint | null; readonly reason: string },
    approvalKind: string,
    summary: string,
  ): Promise<ApprovalPendingView> {
    const id = this.nextId();
    const at = this.clock.now();
    await this.registry.register(tx, { id, docType: ACCOUNT_CHANGE, ownerModule: 'whl', branchId: account.branchId, actorId: actor.principalId });
    const approval = await this.approvals.request(tx, actor, {
      kind: approvalKind,
      branchId: account.branchId,
      subjectDocumentId: id,
      payloadHash: changeHash({ id, customerId: account.customerId, kind: asked.kind, creditLimitPesewas: asked.creditLimitPesewas }),
      amountPesewas: asked.creditLimitPesewas,
      summary,
    });
    await this.store.insertChange(tx, {
      id,
      customerId: account.customerId,
      branchId: account.branchId,
      kind: asked.kind,
      creditLimitPesewas: asked.creditLimitPesewas,
      previousLimitPesewas: asked.kind === 'CREDIT_LIMIT' ? account.creditLimitPesewas : null,
      reason: asked.reason,
      approvalRequestId: approval.id,
      status: 'PENDING_APPROVAL',
      createdBy: actor.principalId,
      createdAt: at,
    });
    await this.audit.record(tx, {
      module: 'whl',
      action: asked.kind === 'CREDIT_LIMIT' ? 'ASK_CREDIT_LIMIT' : 'ASK_RELEASE',
      entityType: 'BusinessAccount',
      entityId: account.customerId,
      branchId: account.branchId,
      after: { changeId: id, approvalRequestId: approval.id, creditLimitPesewas: asked.creditLimitPesewas === null ? null : json(asked.creditLimitPesewas), reason: asked.reason },
    });
    return { status: 'PENDING_APPROVAL', approvalRequestId: approval.id, kind: approvalKind, subject: { id, docType: ACCOUNT_CHANGE, number: null }, summary, requestedAt: approval.requestedAt.toISOString() };
  }

  private async holdIn(tx: Transaction, account: AccountRecord, h: { readonly reason: string; readonly documentId: string | null; readonly by: string; readonly automatic: boolean }): Promise<AccountRecord> {
    const at = this.clock.now();
    await this.store.hold(tx, account.customerId, { reason: h.reason, documentId: h.documentId, by: h.by, at });
    const held = (await this.store.account(tx, account.customerId, true))!;
    await this.audit.record(tx, { module: 'whl', action: h.automatic ? 'HOLD_OVERDUE' : 'HOLD', entityType: 'BusinessAccount', entityId: account.customerId, branchId: account.branchId, before: { ...this.auditOf(account) }, after: { ...this.auditOf(held) } });
    await this.events.publish(tx, {
      type: ACCOUNT_HELD,
      subjectType: 'BusinessAccount',
      subjectId: account.customerId,
      branchId: account.branchId,
      payload: { customerId: account.customerId, reason: h.reason, triggerDocumentId: h.documentId, automatic: h.automatic },
    });
    return held;
  }

  private auditOf(a: AccountRecord): Record<string, unknown> {
    return {
      creditLimitPesewas: json(a.creditLimitPesewas),
      paymentTermsDays: a.paymentTermsDays,
      accountManagerId: a.accountManagerId,
      overdueHoldDays: a.overdueHoldDays,
      status: a.status,
      holdReason: a.holdReason,
      holdDocumentId: a.holdDocumentId,
    };
  }

  private async wholeBranches(tx: Transaction, actor: Actor, permission: string): Promise<string[]> {
    return [...new Set((await this.authoriser.scopes(tx, actor, permission)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
  }

  private async views(tx: Transaction, accounts: readonly AccountRecord[]): Promise<BusinessAccountView[]> {
    if (accounts.length === 0) return [];
    const customers = await this.refs.customersIn(tx, accounts.map((a) => a.customerId));
    const branches = await this.refs.branchesIn(tx, [...new Set(accounts.map((a) => a.branchId))]);
    const managers = await this.principals.refs(tx, accounts.flatMap((a) => (a.accountManagerId === null ? [] : [a.accountManagerId])));
    const at = this.clock.now();
    const views: BusinessAccountView[] = [];
    for (const a of accounts) {
      const judged = await this.credit.judgeIn(tx, a, 0n);
      const customer = customers.get(a.customerId);
      const branch = branches.get(a.branchId);
      const pendingLimit = await this.store.pendingChange(tx, a.customerId, 'CREDIT_LIMIT');
      views.push({
        customer: { id: a.customerId, publicId: customer?.publicId ?? '', name: customer?.name ?? '' },
        branch: { id: a.branchId, code: branch?.code ?? '', name: branch?.name ?? '' },
        creditLimitPesewas: json(a.creditLimitPesewas),
        paymentTermsDays: a.paymentTermsDays,
        accountManager: a.accountManagerId === null ? null : (managers.get(a.accountManagerId) ?? { id: a.accountManagerId, displayName: 'Unknown' }),
        overdueHoldDays: a.overdueHoldDays,
        status: a.status,
        holdReason: a.holdReason,
        heldAt: a.heldAt?.toISOString() ?? null,
        exposurePesewas: json(judged.exposure.pesewas),
        availableCreditPesewas: json(availableCredit(Money.ofPesewas(a.creditLimitPesewas), judged.exposure).pesewas),
        overduePesewas: json(judged.overdue.pesewas),
        oldestOverdueDays: judged.oldestOverdueDays,
        priceList: await this.parties.priceListHeldIn(tx, a.customerId, at),
        pendingCreditLimitPesewas: pendingLimit?.creditLimitPesewas === null || pendingLimit === null ? null : json(pendingLimit.creditLimitPesewas),
        pendingRelease: (await this.store.pendingChange(tx, a.customerId, 'RELEASE')) !== null,
        currency: 'GHS',
        version: a.version,
      });
    }
    return views;
  }
}
