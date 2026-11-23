import { createHash } from 'node:crypto';
import { createUuidV7Generator, formatCedis, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { translate } from '../../../platform/i18n/messages';
import type { Billing } from '../../bil';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser } from '../../iam';
import type { Reservations, StockMovements } from '../../inv';
import type { MasterDataRefs } from '../../mdm';
import type { Payments, ProviderPayments, Receipts, Refunds } from '../../pay';
import type { OrderStatus } from '../domain/order';
import { judgeCancellation, judgeVoid, judgeVoidApprover, planCancellationMoney } from '../domain/reversal';
import { PRICE_OVERRIDE_KIND } from '../domain/price-override';
import type { OrderCancelled, OrderVoided, SaleVoidRequested } from '../events';
import { OrderInvalidError, VoidApproverIsCashierError, type SaleRule } from './errors';
import type { FulfilmentStore } from './fulfilment-store';
import type { OrderHeaderRecord, OrderStore, OrderVoidRecord } from './order-store';
import type { Orders, SalesOrderView } from './orders';

const CANCEL = 'ord.order.cancel';
const VOID = 'ord.order.void';
export const SALE_VOID_KIND = 'SALE_VOID';
export const ORDER_CANCELLED = 'ord.OrderCancelled';
export const SALE_VOID_REQUESTED = 'ord.SaleVoidRequested';
export const ORDER_VOIDED = 'ord.OrderVoided';
/** Abuse case 1: a cashier completes a sale, takes the cash and voids the sale (docs/security/THREAT_MODEL.md). */
const VOID_ABUSE_CASE = 1;
/** The refund reason of what a cancelled order was paid (migration 0192). */
const ORDER_CANCELLED_REFUND_REASON = 'ORDER_CANCELLED';
/** The CANCELLATION reason of an online order whose money never came (seeded in 0024). */
const PAYMENT_NOT_RECEIVED_REASON = 'PAYMENT_NOT_RECEIVED';
/** The System principal, for the rows an approval writes when the decider is not named. */
const SYSTEM_ACTOR_ID = '01900000-0000-7000-8000-000000000001';

/** The contract's `ReasonCodeRequest`. */
export interface ReasonRequest {
  readonly reasonCode: string;
  readonly note: string | null;
}

export interface ApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: string;
  readonly subject: { readonly id: string; readonly docType: string; readonly number: string | null };
  readonly summary: string;
  readonly requestedAt: string;
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();
const invalidState = (id: string, status: OrderStatus) => new InvalidStateTransitionError(`order ${id} is ${status}`, [{ field: null, code: status, message: translate('error.invalid_state_transition') }]);

/**
 * The order's reversals (FR-ORD-002, FR-ORD-014, ADR-0010, abuse case 1, A-226): `cancelOrder` and `voidOrder`, each
 * authorised in the application layer at the order's branch (ADR-0035) and idempotent.
 *
 * A cancellation, in one serializable transaction: every reservation the order holds released through INV, every
 * pending charge released through PAY (money that still arrives clears as unmatched, A-210), and the refund of what each
 * cleared payment still holds asked for through PAY's `Refunds.requestIn`, which waits for a different approver.
 *
 * A void of a completed counter sale waits for `SALE_VOID`: a holder of `ord.void.approve` with a fresh step-up who is
 * neither the person asking (IAM) nor the cashier who made the sale (here and in the database). Approved, in the
 * approval's transaction: every payment reversed through PAY (the mirror of its journal, cash back out of the till), the
 * receipt credited in full through BIL (a credit note, its journal the reverse of the receipt's), and every stock issue
 * reversed through INV (its value back into stock); the order moves to VOIDED and keeps every original record. Every
 * request and every void is published for the daily exception report (`SALE_VOID`).
 */
export class OrderReversals {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: OrderStore,
    private readonly orders: Orders,
    private readonly refs: MasterDataRefs,
    private readonly reservations: Reservations,
    private readonly movements: StockMovements,
    private readonly billing: Billing,
    private readonly payments: Payments,
    private readonly providerPayments: ProviderPayments,
    private readonly refunds: Refunds,
    private readonly receipts: Receipts,
    private readonly approvals: Approvals,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
    private readonly fulfilments: FulfilmentStore,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** cancelOrder (FR-ORD-014): reservations and pending charges released and the refund asked for, in one transaction. */
  cancel(actor: Actor | undefined, id: string, body: ReasonRequest, key: string): Promise<StoredResponse<SalesOrderView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CANCEL);
      const claim = await this.idempotency.claim(tx, { operationId: 'cancelOrder', principalId: actor!.principalId, key, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<SalesOrderView>;
      const header = await this.lockOrder(tx, id);
      await this.authoriser.authorise(tx, actor, CANCEL, { branchId: header.branchId });
      if (!judgeCancellation(header.status).ok) throw invalidState(id, header.status);
      const reasonRules = await this.reasonRules(tx, body, 'CANCELLATION');
      if (reasonRules.length > 0) throw new OrderInvalidError(reasonRules);
      const view = await this.cancelIn(tx, header, body, actor!);
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * An online order that stops waiting for its money (A-232), in the caller's transaction, as the System: its checkout's
   * hold lapsed or was released (`holdEnded`, the checkout's stock is the expiry's or the releaser's to end), or its
   * charge failed (the checkout's stock is released here, so the cart comes back at once). Only a PLACED order is
   * cancelled; anything else is left as it is and false is answered. Reason `PAYMENT_NOT_RECEIVED`. It authorises
   * nothing: no person asked.
   */
  async stopWaitingIn(tx: Transaction, header: OrderHeaderRecord, why: 'HOLD_ENDED' | 'PAYMENT_FAILED', actorId: string): Promise<boolean> {
    if (header.status !== 'PLACED') return false;
    const note = why === 'HOLD_ENDED' ? 'The checkout’s hold ended before the payment arrived' : 'The payment failed';
    await this.cancelIn(tx, header, { reasonCode: PAYMENT_NOT_RECEIVED_REASON, note }, { principalId: actorId, kind: 'SYSTEM', displayName: 'System', realm: null, sessionId: null, steppedUpAt: null }, why === 'PAYMENT_FAILED');
    return true;
  }

  /**
   * An order whose customer refused what it could send (FR-ORD-013: a substitute or a smaller quantity refused, the last
   * open line cancelled), cancelled in the caller's transaction with the refund of what was paid asked for, as the person
   * who recorded the answer (or the customer). The caller has authorised the answer and holds the order's lock.
   */
  async cancelForCustomerIn(tx: Transaction, orderId: string, actor: Actor, reasonCode: string, note: string): Promise<SalesOrderView> {
    const header = await this.lockOrder(tx, orderId);
    if (!judgeCancellation(header.status).ok) throw invalidState(orderId, header.status);
    return this.cancelIn(tx, header, { reasonCode, note }, actor, false);
  }

  /**
   * The cancellation itself (FR-ORD-014), the order locked and judged by the caller. An online order still PLACED from
   * its checkout also gives the checkout's stock back when `releaseSource` (a cancellation by staff or a failed charge),
   * after the order is CANCELLED, so the checkout's own reaction (it ends and gives the cart back) finds the order ended.
   */
  private async cancelIn(tx: Transaction, header: OrderHeaderRecord, body: ReasonRequest, actor: Actor, releaseSource = header.channel === 'ONLINE' && header.status === 'PLACED'): Promise<SalesOrderView> {
    const id = header.id;
    const before = await this.orders.viewOf(tx, id);
    const actorId = actor.principalId;

    const released = [...(await this.reservations.releaseHeldByIn(tx, actorId, id, `Order ${header.orderNo!} cancelled (${body.reasonCode})`))];
    const money = planCancellationMoney(await this.payments.ofOrderIn(tx, id));
    for (const paymentId of money.releases) await this.providerPayments.releaseChargeIn(tx, paymentId, actorId);
    const refundIds: string[] = [];
    for (const refund of money.refunds) {
      const asked = await this.refunds.requestIn(tx, actor, {
        originalPaymentId: refund.paymentId,
        amountPesewas: refund.amount.pesewas,
        destination: 'ORIGINAL_METHOD',
        reasonCode: ORDER_CANCELLED_REFUND_REASON,
        creditNoteId: null,
        note: `Order ${header.orderNo!} cancelled`,
      });
      refundIds.push(asked.subject.id);
    }

    // A price override still waiting is withdrawn: nobody may approve a price on a cancelled order (A-230).
    for (const asked of await this.approvals.ofSubjectIn(tx, id, PRICE_OVERRIDE_KIND)) {
      if (asked.status === 'PENDING') await this.approvals.withdrawIn(tx, asked.id, `Order ${header.orderNo!} cancelled before its price override was decided`);
    }

    const at = this.clock.now();
    // B11: a question to the customer still waiting is withdrawn, and every pick list not yet packed is cancelled with its
    // picks withdrawn (a pick moved no stock, A-332).
    const waiting = await this.fulfilments.pendingConsent(tx, id);
    if (waiting !== null) await this.fulfilments.answerConsent(tx, waiting.id, { status: 'WITHDRAWN', answeredBy: actorId, at, method: 'SYSTEM', note: 'The order was cancelled' });
    const pickLists = await this.fulfilments.cancelOpenOfOrder(tx, id, { reason: `Order cancelled (${body.reasonCode})`, at, actorId });
    await this.store.cancel(tx, id, { reasonCode: body.reasonCode, at, actorId });
    await this.store.recordStatus(tx, id, { id: this.nextId(), fromStatus: header.status, toStatus: 'CANCELLED', reason: reasonText(body), occurredAt: at, actorId });
    if (releaseSource && header.sourceDocumentId !== null) {
      released.push(...(await this.reservations.releaseHeldByIn(tx, actorId, header.sourceDocumentId, `Order ${header.orderNo!} cancelled (${body.reasonCode})`)));
    }
    const view = await this.orders.viewOf(tx, id);
    const cancelled: OrderCancelled = {
      orderId: id,
      orderNo: header.orderNo!,
      branchId: header.branchId,
      customerId: header.customerId,
      fromStatus: header.status as OrderCancelled['fromStatus'],
      reasonCode: body.reasonCode,
      releasedReservationIds: released.map((r) => r.id),
      releasedChargePaymentIds: money.releases,
      refundIds,
      refundRequestedPesewas: money.total.toJsonInteger(),
      cancelledAt: at.toISOString(),
    };
    await this.events.publish(tx, { type: ORDER_CANCELLED, subjectType: 'SalesOrder', subjectId: id, branchId: header.branchId, payload: cancelled, occurredAt: at });
    await this.audit.record(tx, { module: 'ord', action: 'CANCEL', entityType: 'SalesOrder', entityId: id, branchId: header.branchId, before: { ...before }, after: { ...view, refundIds, pickLists } });
    return view;
  }

  /** voidOrder (abuse case 1): always 202; nothing changes until a supervisor who is not the cashier approves. */
  requestVoid(actor: Actor | undefined, id: string, body: ReasonRequest, key: string): Promise<StoredResponse<ApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, VOID);
      const claim = await this.idempotency.claim(tx, { operationId: 'voidOrder', principalId: actor!.principalId, key, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ApprovalPendingView>;
      const header = await this.lockOrder(tx, id);
      await this.authoriser.authorise(tx, actor, VOID, { branchId: header.branchId });
      await this.judgeVoidIn(tx, header, undefined, await this.reasonRules(tx, body, 'VOID'));

      const amount = header.finalTotalPesewas!;
      const summary = `Void sale ${header.orderNo!} of ${formatCedis(amount)} (${body.reasonCode})`;
      const voidId = this.nextId();
      const approval = await this.approvals.request(tx, actor, {
        kind: SALE_VOID_KIND,
        branchId: header.branchId,
        subjectDocumentId: id,
        payloadHash: voidHash(header, body),
        amountPesewas: amount,
        summary,
      });
      await this.store.insertVoid(tx, { id: voidId, salesOrderId: id, reasonCode: body.reasonCode, note: body.note, approvalRequestId: approval.id, branchId: header.branchId, createdBy: actor!.principalId });
      const requested: SaleVoidRequested = {
        voidId,
        orderId: id,
        orderNo: header.orderNo!,
        branchId: header.branchId,
        amountPesewas: json(amount),
        reasonCode: body.reasonCode,
        approvalRequestId: approval.id,
        requestedBy: actor!.principalId,
        cashierId: header.createdBy,
        abuseCases: [VOID_ABUSE_CASE],
      };
      await this.events.publish(tx, { type: SALE_VOID_REQUESTED, subjectType: 'SalesOrder', subjectId: id, branchId: header.branchId, payload: requested });
      await this.audit.record(tx, { module: 'ord', action: 'SUBMIT', entityType: 'OrderVoid', entityId: voidId, branchId: header.branchId, before: null, after: { orderId: id, reasonCode: body.reasonCode, note: body.note, approvalRequestId: approval.id } });
      const response = {
        status: 202,
        body: { status: 'PENDING_APPROVAL' as const, approvalRequestId: approval.id, kind: SALE_VOID_KIND, subject: { id, docType: 'SALES_ORDER', number: header.orderNo }, summary, requestedAt: approval.requestedAt.toISOString() },
      };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** IAM's handler for `SALE_VOID`: the approved void takes effect in the approval's transaction. */
  readonly approvalHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, subjectDocumentId) => {
      const header = await this.store.lock(tx, subjectDocumentId);
      const pending = await this.store.openVoidOf(tx, subjectDocumentId);
      if (header === null || pending === null) throw new NotFoundError('no such void');
      return voidHash(header, pending);
    },
    onApproved: async (tx: Transaction, request: ApprovalRecord) => {
      const pending = await this.store.voidByApproval(tx, request.id);
      if (pending?.status !== 'PENDING_APPROVAL') throw new NotFoundError('no such void');
      await this.voidIn(tx, pending, request.decidedBy ?? SYSTEM_ACTOR_ID, request);
    },
    onRejected: async (tx: Transaction, request: ApprovalRecord) => {
      const pending = await this.store.voidByApproval(tx, request.id);
      if (pending?.status !== 'PENDING_APPROVAL') return;
      const decider = request.decidedBy ?? SYSTEM_ACTOR_ID;
      await this.store.decideVoid(tx, pending.id, { status: 'REJECTED', creditNoteId: null, decidedBy: decider, at: this.clock.now() });
      await this.audit.record(tx, { module: 'ord', action: 'REJECT', entityType: 'OrderVoid', entityId: pending.id, branchId: pending.branchId, before: { status: pending.status }, after: { status: 'REJECTED', approvalRequestId: request.id } });
    },
  };

  /** The approved void: payments reversed, the receipt credited in full, the stock issues reversed, the order VOIDED. */
  private async voidIn(tx: Transaction, pending: OrderVoidRecord, decider: string, request: ApprovalRecord): Promise<void> {
    const header = await this.lockOrder(tx, pending.salesOrderId);
    if (!judgeVoidApprover(decider, { postedBy: header.createdBy, salespersonId: header.salespersonId }).ok) {
      throw new VoidApproverIsCashierError('the cashier who made a sale cannot approve its void');
    }
    // Judged again at the approval: a void approved after the sale's day is refused like one asked for then.
    await this.judgeVoidIn(tx, header, pending.id);
    const before = await this.orders.viewOf(tx, header.id);
    const note = `Void of ${header.orderNo!} (${pending.reasonCode})`;

    const reversingPaymentIds: string[] = [];
    for (const payment of await this.payments.ofOrderIn(tx, header.id)) {
      if (payment.status !== 'CLEARED') continue;
      reversingPaymentIds.push(await this.receipts.reverseApprovedIn(tx, payment.id, { note, actorId: decider, approvalRequestId: request.id }));
    }
    const [receipt] = await this.billing.viewsIn(tx, [header.billingDocumentId!]);
    const credit = await this.billing.creditIn(
      tx,
      decider,
      receipt!.id,
      { reasonCode: pending.reasonCode, note: pending.note ?? undefined, lines: receipt!.lines.map((l) => ({ lineId: l.id, quantity: l.quantity })) },
      request.id,
    );
    const [order] = await this.store.orders(tx, [header.id]);
    const reversingMovementIds: string[] = [];
    for (const line of order!.lines) {
      if (line.stockMovementId !== null) reversingMovementIds.push(await this.movements.reverseForDocumentIn(tx, decider, line.stockMovementId, credit.id));
    }

    const at = this.clock.now();
    await this.store.markVoided(tx, header.id, { approvalRequestId: request.id, voidedBy: decider, at });
    await this.store.decideVoid(tx, pending.id, { status: 'APPROVED', creditNoteId: credit.id, decidedBy: decider, at });
    await this.store.recordStatus(tx, header.id, { id: this.nextId(), fromStatus: 'COMPLETED', toStatus: 'VOIDED', reason: reasonText(pending), occurredAt: at, actorId: decider });
    const view = await this.orders.viewOf(tx, header.id);
    const voided: OrderVoided = {
      voidId: pending.id,
      orderId: header.id,
      orderNo: header.orderNo!,
      branchId: header.branchId,
      amountPesewas: json(header.finalTotalPesewas!),
      reasonCode: pending.reasonCode,
      creditNoteId: credit.id,
      creditNoteNo: credit.documentNo!,
      reversingPaymentIds,
      reversingMovementIds,
      approvalRequestId: request.id,
      requestedBy: pending.createdBy,
      voidedBy: decider,
      cashierId: header.createdBy,
      voidedAt: at.toISOString(),
      abuseCases: [VOID_ABUSE_CASE],
    };
    await this.events.publish(tx, { type: ORDER_VOIDED, subjectType: 'SalesOrder', subjectId: header.id, branchId: header.branchId, payload: voided, occurredAt: at });
    await this.audit.record(tx, {
      module: 'ord',
      action: 'VOID',
      entityType: 'SalesOrder',
      entityId: header.id,
      branchId: header.branchId,
      before: { ...before },
      after: { ...view, creditNoteId: credit.id, reversingPaymentIds, reversingMovementIds, approvalRequestId: request.id },
    });
  }

  private async lockOrder(tx: Transaction, id: string): Promise<OrderHeaderRecord> {
    const header = await this.store.lock(tx, id);
    if (header === null) throw new NotFoundError('no such order');
    return header;
  }

  /** The void's rules for this sale now; `deciding` names the void being approved, which does not count as pending. */
  private async judgeVoidIn(tx: Transaction, header: OrderHeaderRecord, deciding?: string, reasonRules: readonly SaleRule[] = []): Promise<void> {
    const open = await this.store.openVoidOf(tx, header.id);
    const payments = await this.payments.ofOrderIn(tx, header.id);
    // At the approval, a reversal of a payment still waiting blocks the void (BL-077): the void would write a second
    // open reversal of the payment, which the database refuses (uq_payment_reversal_open).
    const reversalPending = deciding !== undefined && (await this.receipts.pendingReversalsIn(tx, payments.map((p) => p.id))).size > 0;
    const verdict = judgeVoid({
      status: header.status,
      fulfilmentMode: header.fulfilmentMode,
      completedOn: header.completedAt === null ? null : toBusinessDate(header.completedAt),
      today: toBusinessDate(this.clock.now()),
      payments: payments.map((p) => ({ id: p.id, methodKind: p.methodKind, status: p.status, refundedPesewas: p.refundedPesewas })),
      voidPending: open !== null && open.id !== deciding,
      reversalPending,
    });
    if (!verdict.ok && verdict.error.includes('INVALID_STATE_TRANSITION')) throw invalidState(header.id, header.status);
    const broken: SaleRule[] = [...(verdict.ok ? [] : verdict.error.map((rule) => ({ field: rule === 'TENDER_NOT_VOIDABLE' || rule === 'REVERSAL_PENDING' ? '/payments' : '', rule }))), ...reasonRules];
    if (broken.length > 0) throw new OrderInvalidError(broken);
  }

  /** The rules a reversal's reason breaks: a reason of the domain it takes, with its note where the reason asks for one. */
  private async reasonRules(tx: Transaction, body: ReasonRequest, domain: 'CANCELLATION' | 'VOID'): Promise<SaleRule[]> {
    const reason = (await this.refs.reasonCodesIn(tx, [body.reasonCode])).get(body.reasonCode);
    const broken: SaleRule[] = [];
    if (reason === undefined || reason.domain !== domain) broken.push({ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' });
    else if (reason.requiresNote && (body.note === null || body.note.trim() === '')) broken.push({ field: '/note', rule: 'NOTE_REQUIRED' });
    return broken;
  }
}

function reasonText(r: { readonly reasonCode: string; readonly note: string | null }): string {
  return (r.note === null || r.note.trim() === '' ? r.reasonCode : `${r.reasonCode}: ${r.note.trim()}`).slice(0, 500);
}

/** What a void approval binds: the sale as it stands and the void as it was asked. */
function voidHash(header: OrderHeaderRecord, body: { readonly reasonCode: string; readonly note: string | null }): string {
  return createHash('sha256')
    .update(canonicalJson({ orderId: header.id, status: header.status, version: header.version, finalTotalPesewas: header.finalTotalPesewas?.toString() ?? null, reasonCode: body.reasonCode, note: body.note }), 'utf8')
    .digest('hex');
}
