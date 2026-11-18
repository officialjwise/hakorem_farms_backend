import { createHash } from 'node:crypto';
import { createUuidV7Generator, formatCedis, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Billing } from '../../bil';
import type { ApprovalHandler, ApprovalListing, ApprovalRecord, Approvals, Authoriser, PrincipalNames } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import type { CreditOrder, CreditOverridePending, CreditPolicyAnswer, OrderConfirmationPolicy, Orders } from '../../ord';
import { judgeCredit, overrideCovers, type CreditJudgement, type CreditReason, type OpenItem } from '../domain/credit';
import { pageProbe } from '../domain/paging';
import type { AccountRecord, AccountStore, OverrideRecord } from './account-store';
import { AskerCannotApproveError, CreditOverrideInvalidError } from './errors';

export const CREDIT_OVERRIDE_KIND = 'CREDIT_OVERRIDE';
export const CREDIT_OVERRIDE_APPROVED = 'whl.CreditOverrideApproved';
const ACCOUNT_READ = 'whl.account.read';
const ORDER_READ = 'ord.order.read';
const ORDER_CONFIRM = 'ord.order.confirm';

type Ref = { readonly id: string; readonly displayName: string };

/** The contract's `CreditOverrideState` (CR-046). */
export interface CreditOverrideStateView {
  readonly approvalRequestId: string;
  readonly status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';
  readonly reason: string;
  readonly requestedBy: Ref;
  readonly requestedAt: string;
  readonly decidedBy: Ref | null;
  readonly decidedAt: string | null;
}

/** The contract's `OrderCreditCheck` (CR-046), worked out by the server as confirmOrder would judge it now. */
export interface OrderCreditCheckView {
  readonly order: { readonly id: string; readonly docType: 'SALES_ORDER'; readonly number: string | null };
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string } | null;
  readonly outcome: 'PASSES' | CreditReason | 'NOT_REQUIRED' | 'NO_ACCOUNT';
  readonly reasons: readonly CreditReason[];
  readonly creditLimitPesewas: number;
  readonly exposurePesewas: number;
  readonly orderPesewas: number;
  readonly overLimitPesewas: number;
  readonly overduePesewas: number;
  readonly oldestOverdueDays: number | null;
  readonly paymentTermsDays: number;
  readonly override: CreditOverrideStateView | null;
  readonly checkedAt: string;
  readonly currency: 'GHS';
}

/** The contract's `CreditOverride`: an approved override, with who asked, why, and who approved. */
export interface CreditOverrideView {
  readonly id: string;
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string };
  readonly order: { readonly id: string; readonly docType: 'SALES_ORDER'; readonly number: string | null };
  readonly limitPesewas: number;
  readonly exposurePesewas: number;
  readonly orderPesewas: number;
  readonly overLimitPesewas: number;
  readonly reasons: readonly CreditReason[];
  readonly reason: string;
  readonly approvalRequestId: string;
  readonly requestedBy: Ref;
  readonly approvedBy: Ref;
  readonly recordedAt: string;
  readonly currency: 'GHS';
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

export interface CreditOverrideQuery {
  readonly customerId: string | null;
  readonly from: string | null;
  readonly to: string | null;
}

/** The order as WHL reads it from ORD. */
type OrderFacts = CreditOrder & { readonly status: string; readonly paymentTerms: string };

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();
const unknownRef = (id: string): Ref => ({ id, displayName: 'Unknown' });

/** The payload an override's approval is bound to: the order, its amount and the reasons it was refused for. */
function overrideHash(order: CreditOrder, reasons: readonly CreditReason[]): string {
  return createHash('sha256')
    .update(canonicalJson({ orderId: order.id, orderPesewas: order.estimatedTotalPesewas.toString(), reasons: [...reasons].sort() }), 'utf8')
    .digest('hex');
}

function stateOf(listing: ApprovalListing, now: Date): CreditOverrideStateView['status'] {
  if (listing.status === 'PENDING' && listing.expiresAt !== null && listing.expiresAt <= now) return 'EXPIRED';
  return listing.status === 'PENDING' ? 'PENDING_APPROVAL' : (listing.status as CreditOverrideStateView['status']);
}

/**
 * Credit control (FR-WHL-006, FR-WHL-007, CR-046, abuse case 14): WHL's implementation of ORD's
 * `OrderConfirmationPolicy`, the order's credit check, the override asked with a written reason and approved by a holder
 * of `whl.credit.override` who did not ask, and the list of approved overrides. Exposure is the customer's outstanding
 * invoiced balance at every branch (BIL's open items, which a reversed or bounced payment has reopened, A-212 (d)) plus
 * their confirmed credit orders not yet invoiced (ORD), read in the caller's transaction under the account's row lock,
 * so two confirmations for one customer queue (A-313).
 */
export class CreditControl implements OrderConfirmationPolicy {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: AccountStore,
    private readonly orders: Orders,
    private readonly billing: Billing,
    private readonly approvals: Approvals,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly refs: MasterDataRefs,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  // --------------------------------------------------------------------------------------- the figures

  /** The account's credit figures with an order of `order` pesewas (nil to read the account alone), as at now. */
  async judgeIn(tx: Transaction, account: AccountRecord, order: bigint): Promise<CreditJudgement> {
    const openItems: OpenItem[] = (await this.billing.customerOpenItemsIn(tx, account.customerId)).map((i) => ({
      documentId: i.id,
      documentNo: i.documentNo,
      issueDate: i.issueDate,
      dueDate: i.dueDate,
      outstanding: Money.ofPesewas(i.outstandingPesewas),
    }));
    return judgeCredit({
      status: account.status === 'ON_HOLD' ? 'ON_HOLD' : 'ACTIVE',
      limit: Money.ofPesewas(account.creditLimitPesewas),
      openItems,
      uninvoicedOrders: Money.ofPesewas(await this.orders.uninvoicedCreditIn(tx, account.customerId)),
      order: Money.ofPesewas(order),
      today: toBusinessDate(this.clock.now()),
    });
  }

  /** The customer's open items, for the overdue hold. */
  async openItemsIn(tx: Transaction, customerId: string): Promise<OpenItem[]> {
    return (await this.billing.customerOpenItemsIn(tx, customerId)).map((i) => ({ documentId: i.id, documentNo: i.documentNo, issueDate: i.issueDate, dueDate: i.dueDate, outstanding: Money.ofPesewas(i.outstandingPesewas) }));
  }

  // --------------------------------------------------------------------------------------- the port

  async creditFor(tx: Transaction, order: CreditOrder): Promise<CreditPolicyAnswer | null> {
    if (order.customerId === null) return null;
    const account = await this.store.account(tx, order.customerId, true);
    if (account === null || account.status === 'CLOSED') return null;
    const judged = await this.judgeIn(tx, account, order.estimatedTotalPesewas);
    const covered = judged.reasons.length > 0 && (await this.store.overridesOfOrder(tx, order.id)).some((o) => overrideCovers(o, judged, Money.ofPesewas(order.estimatedTotalPesewas)));
    const pending = judged.reasons.length > 0 && !covered && (await this.pendingOf(tx, order.id)) !== null;
    const customer = (await this.refs.customersIn(tx, [order.customerId])).get(order.customerId);
    return {
      verdict: judged.reasons.length === 0 ? 'PASSED' : covered ? 'OVERRIDDEN' : 'REFUSED',
      reasons: judged.reasons,
      customerName: customer?.name ?? 'The customer',
      limitPesewas: account.creditLimitPesewas,
      exposurePesewas: judged.exposure.pesewas,
      overLimitPesewas: judged.overLimit.pesewas,
      overduePesewas: judged.overdue.pesewas,
      oldestOverdueDays: judged.oldestOverdueDays,
      overridePending: pending,
    };
  }

  async requestOverrideIn(tx: Transaction, actor: Actor, order: CreditOrder, reason: string): Promise<CreditOverridePending> {
    const account = order.customerId === null ? null : await this.store.account(tx, order.customerId, true);
    if (account === null || account.status === 'CLOSED') throw new CreditOverrideInvalidError('CREDIT_CHECK_UNAVAILABLE');
    const judged = await this.judgeIn(tx, account, order.estimatedTotalPesewas);
    if (judged.reasons.length === 0) throw new CreditOverrideInvalidError('CREDIT_OVERRIDE_NOT_NEEDED');
    const at = this.clock.now();
    const customer = (await this.refs.customersIn(tx, [account.customerId])).get(account.customerId);
    const words = judged.reasons.map((r) => (r === 'OVER_LIMIT' ? `${formatCedis(judged.overLimit.pesewas)} over its ${formatCedis(account.creditLimitPesewas)} limit` : r === 'PAST_TERMS' ? `${formatCedis(judged.overdue.pesewas)} past its terms` : 'on hold'));
    const approval = await this.approvals.request(tx, actor, {
      kind: CREDIT_OVERRIDE_KIND,
      branchId: order.branchId,
      subjectDocumentId: order.id,
      payloadHash: overrideHash(order, judged.reasons),
      amountPesewas: judged.overLimit.pesewas,
      summary: `Credit override for ${order.orderNo ?? 'the order'} of ${formatCedis(order.estimatedTotalPesewas)} to ${customer?.name ?? 'the customer'}: ${words.join('; ')}. Reason: ${reason}`,
    });
    await this.store.insertOverrideRequest(
      tx,
      {
        id: this.nextId(),
        orderId: order.id,
        customerId: account.customerId,
        branchId: order.branchId,
        approvalRequestId: approval.id,
        reason,
        reasons: judged.reasons,
        limitPesewas: account.creditLimitPesewas,
        exposurePesewas: judged.exposure.pesewas,
        orderPesewas: order.estimatedTotalPesewas,
        overLimitPesewas: judged.overLimit.pesewas,
        requestedBy: actor.principalId,
        recordedAt: at,
      },
      actor.principalId,
    );
    await this.audit.record(tx, {
      module: 'whl',
      action: 'CREDIT_OVERRIDE_REQUESTED',
      entityType: 'SalesOrder',
      entityId: order.id,
      branchId: order.branchId,
      after: { approvalRequestId: approval.id, reason, reasons: [...judged.reasons], limitPesewas: json(account.creditLimitPesewas), exposurePesewas: json(judged.exposure.pesewas), orderPesewas: json(order.estimatedTotalPesewas), overLimitPesewas: json(judged.overLimit.pesewas) },
    });
    return {
      status: 'PENDING_APPROVAL',
      approvalRequestId: approval.id,
      kind: CREDIT_OVERRIDE_KIND,
      subject: { id: order.id, docType: 'SALES_ORDER', number: order.orderNo },
      summary: approval.summary,
      requestedAt: approval.requestedAt.toISOString(),
      creditCheck: await this.checkView(tx, order, account, judged),
    };
  }

  // --------------------------------------------------------------------------------------- the operations

  /** getOrderCreditCheck (CR-046): the order's credit check as confirmOrder would judge it now. `ord.order.read` at the order's branch. */
  creditCheck(actor: Actor | undefined, orderId: string): Promise<OrderCreditCheckView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, ORDER_READ);
      const order = await this.orders.creditOrderIn(tx, orderId, false);
      if (order === null) throw new NotFoundError(`no order ${orderId}`);
      await this.authoriser.authorise(tx, actor, ORDER_READ, { branchId: order.branchId });
      if (order.paymentTerms !== 'CREDIT') return this.checkView(tx, order, null, null);
      const account = order.customerId === null ? null : await this.store.account(tx, order.customerId, false);
      if (account === null || account.status === 'CLOSED') return this.checkView(tx, order, null, null);
      return this.checkView(tx, order, account, await this.judgeIn(tx, account, order.estimatedTotalPesewas));
    });
  }

  /**
   * requestCreditOverride (CR-046): asks for an override of a PLACED credit order refused for credit, with a written
   * reason; 202 with the approval. `ord.order.confirm` at the order's branch. Idempotent.
   */
  requestOverride(actor: Actor | undefined, orderId: string, request: { readonly reason: string }, key: string): Promise<StoredResponse<CreditOverridePending>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, ORDER_CONFIRM);
      const claim = await this.idempotency.claim(tx, { operationId: 'requestCreditOverride', principalId: actor!.principalId, key, request: { orderId, reason: request.reason } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<CreditOverridePending>;
      const order = await this.orders.creditOrderIn(tx, orderId, true);
      if (order === null) throw new NotFoundError(`no order ${orderId}`);
      await this.authoriser.authorise(tx, actor, ORDER_CONFIRM, { branchId: order.branchId });
      if (order.status !== 'PLACED') throw new CreditOverrideInvalidError('ORDER_NOT_PLACED');
      if (order.paymentTerms !== 'CREDIT') throw new CreditOverrideInvalidError('NOT_CREDIT');
      const answer = await this.creditFor(tx, order);
      if (answer === null) throw new CreditOverrideInvalidError('CREDIT_CHECK_UNAVAILABLE');
      if (answer.verdict !== 'REFUSED') throw new CreditOverrideInvalidError('CREDIT_OVERRIDE_NOT_NEEDED');
      if (answer.overridePending) throw new CreditOverrideInvalidError('APPROVAL_PENDING');
      const response: StoredResponse<CreditOverridePending> = { status: 202, body: await this.requestOverrideIn(tx, actor!, order, request.reason) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** listCreditOverrides (FR-WHL-007): approved overrides at the reader's whole branches, newest first. */
  list(actor: Actor | undefined, query: CreditOverrideQuery, cursor: string | undefined, limit: number): Promise<Page<CreditOverrideView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, ACCOUNT_READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, ACCOUNT_READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const binding = { operationId: 'listCreditOverrides', principalId: actor!.principalId, filters: query };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.overrides(
        tx,
        { branchIds, customerId: query.customerId, from: query.from === null ? null : new Date(query.from), to: query.to === null ? null : new Date(query.to) },
        beforeId,
        pageProbe(limit),
      );
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      return { data: await this.overrideViews(tx, rows), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: rows.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  // --------------------------------------------------------------------------------------- the approval

  readonly approvalHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, orderId) => {
      const order = await this.orders.creditOrderIn(tx, orderId, true);
      if (order === null) throw new NotFoundError(`no order ${orderId}`);
      const account = order.customerId === null ? null : await this.store.account(tx, order.customerId, true);
      if (account === null) throw new NotFoundError(`no business account for order ${orderId}`);
      return overrideHash(order, (await this.judgeIn(tx, account, order.estimatedTotalPesewas)).reasons);
    },
    onApproved: async (tx: Transaction, approval: ApprovalRecord) => {
      const request = await this.store.overrideRequestByApproval(tx, approval.id);
      if (request === null) throw new NotFoundError(`no credit override asked under approval ${approval.id}`);
      // ADR-0017 in WHL's own code as well as IAM's and the database's: the person who asked never approves.
      if (approval.decidedBy === null || approval.decidedBy === request.requestedBy) throw new AskerCannotApproveError('the person who asked for a credit override cannot approve it');
      const at = this.clock.now();
      const exposure = request.exposurePesewas + request.orderPesewas;
      const override: OverrideRecord = { ...request, id: this.nextId(), requestId: request.id, exposurePesewas: exposure, approvedBy: approval.decidedBy, recordedAt: at };
      await this.store.insertOverride(tx, override, approval.decidedBy);
      await this.audit.record(tx, {
        module: 'whl',
        action: 'CREDIT_OVERRIDE_APPROVED',
        entityType: 'SalesOrder',
        entityId: request.orderId,
        branchId: request.branchId,
        after: { creditOverrideId: override.id, approvalRequestId: approval.id, reason: request.reason, reasons: [...request.reasons], limitPesewas: json(request.limitPesewas), exposurePesewas: json(exposure), overLimitPesewas: json(request.overLimitPesewas), requestedBy: request.requestedBy, approvedBy: approval.decidedBy },
      });
      // For the daily exception report (B12, abuse case 14, `CREDIT_OVERRIDE`).
      await this.events.publish(tx, {
        type: CREDIT_OVERRIDE_APPROVED,
        subjectType: 'SalesOrder',
        subjectId: request.orderId,
        branchId: request.branchId,
        payload: { abuseCases: [14], exceptionKind: 'CREDIT_OVERRIDE', creditOverrideId: override.id, orderId: request.orderId, customerId: request.customerId, limitPesewas: json(request.limitPesewas), exposurePesewas: json(exposure), overLimitPesewas: json(request.overLimitPesewas), reasons: [...request.reasons], requestedBy: request.requestedBy, approvedBy: approval.decidedBy },
      });
    },
  };

  // --------------------------------------------------------------------------------------- inside

  private async pendingOf(tx: Transaction, orderId: string): Promise<ApprovalListing | null> {
    const now = this.clock.now();
    return (await this.approvals.ofSubjectIn(tx, orderId, CREDIT_OVERRIDE_KIND)).find((a) => stateOf(a, now) === 'PENDING_APPROVAL') ?? null;
  }

  private async checkView(tx: Transaction, order: OrderFacts | CreditOrder, account: AccountRecord | null, judged: CreditJudgement | null): Promise<OrderCreditCheckView> {
    const now = this.clock.now();
    const customer = order.customerId === null ? undefined : (await this.refs.customersIn(tx, [order.customerId])).get(order.customerId);
    const listings = await this.approvals.ofSubjectIn(tx, order.id, CREDIT_OVERRIDE_KIND);
    const latest = listings.at(-1);
    let override: CreditOverrideStateView | null = null;
    if (latest !== undefined) {
      const request = await this.store.overrideRequestByApproval(tx, latest.id);
      const names = await this.principals.refs(tx, [latest.requestedBy, ...(latest.decidedBy === null ? [] : [latest.decidedBy])]);
      override = {
        approvalRequestId: latest.id,
        status: stateOf(latest, now),
        reason: request?.reason ?? latest.summary,
        requestedBy: names.get(latest.requestedBy) ?? unknownRef(latest.requestedBy),
        requestedAt: latest.requestedAt.toISOString(),
        decidedBy: latest.decidedBy === null ? null : (names.get(latest.decidedBy) ?? unknownRef(latest.decidedBy)),
        decidedAt: latest.decidedAt?.toISOString() ?? null,
      };
    }
    const terms = 'paymentTerms' in order ? order.paymentTerms : 'CREDIT';
    return {
      order: { id: order.id, docType: 'SALES_ORDER', number: order.orderNo },
      customer: customer === undefined ? null : { id: customer.id, publicId: customer.publicId, name: customer.name },
      outcome: judged === null ? (terms === 'CREDIT' ? 'NO_ACCOUNT' : 'NOT_REQUIRED') : judged.outcome,
      reasons: judged?.reasons ?? [],
      creditLimitPesewas: account === null ? 0 : json(account.creditLimitPesewas),
      exposurePesewas: judged === null ? 0 : json(judged.exposure.pesewas),
      orderPesewas: json(order.estimatedTotalPesewas),
      overLimitPesewas: judged === null ? 0 : json(judged.overLimit.pesewas),
      overduePesewas: judged === null ? 0 : json(judged.overdue.pesewas),
      oldestOverdueDays: judged?.oldestOverdueDays ?? null,
      paymentTermsDays: account?.paymentTermsDays ?? 0,
      override,
      checkedAt: now.toISOString(),
      currency: 'GHS',
    };
  }

  private async overrideViews(tx: Transaction, rows: readonly OverrideRecord[]): Promise<CreditOverrideView[]> {
    const customers = await this.refs.customersIn(tx, [...new Set(rows.map((r) => r.customerId))]);
    const names = await this.principals.refs(tx, [...new Set(rows.flatMap((r) => [r.requestedBy, r.approvedBy]))]);
    const orders = new Map<string, string | null>();
    for (const r of rows) if (!orders.has(r.orderId)) orders.set(r.orderId, (await this.orders.creditOrderIn(tx, r.orderId, false))?.orderNo ?? null);
    return rows.map((r) => {
      const c = customers.get(r.customerId);
      return {
        id: r.id,
        customer: { id: r.customerId, publicId: c?.publicId ?? '', name: c?.name ?? '' },
        order: { id: r.orderId, docType: 'SALES_ORDER', number: orders.get(r.orderId) ?? null },
        limitPesewas: json(r.limitPesewas),
        exposurePesewas: json(r.exposurePesewas),
        orderPesewas: json(r.orderPesewas),
        overLimitPesewas: json(r.overLimitPesewas),
        reasons: r.reasons,
        reason: r.reason,
        approvalRequestId: r.approvalRequestId,
        requestedBy: names.get(r.requestedBy) ?? unknownRef(r.requestedBy),
        approvedBy: names.get(r.approvedBy) ?? unknownRef(r.approvedBy),
        recordedAt: r.recordedAt.toISOString(),
        currency: 'GHS',
      };
    });
  }
}
