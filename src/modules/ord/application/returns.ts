import { createHash } from 'node:crypto';
import { createUuidV7Generator, formatCedis, Money, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { translate } from '../../../platform/i18n/messages';
import type { Billing } from '../../bil';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames } from '../../iam';
import type { StockMovements } from '../../inv';
import type { MasterDataRefs } from '../../mdm';
import type { Payments, Refunds } from '../../pay';
import { judgeReturn, judgeReturnApprover, planReturnRefund, type ReturnRule } from '../domain/order-return';
import { lineNumber } from '../domain/line-numbers';
import type { OrderStatus } from '../domain/order';
import type { ReturnCompleted, ReturnSubmitted } from '../events';
import { OrderInvalidError, ReturnApproverIsMakerError } from './errors';
import type { ApprovalPendingView } from './order-reversals';
import type { OrderStore } from './order-store';
import type { Disposition, RefundDestination, ReturnRecord, ReturnStore } from './return-store';

const READ = 'ord.return.read';
const CREATE = 'ord.return.create';
export const RETURN_KIND = 'RETURN';
export const RETURN_SUBMITTED = 'ord.ReturnSubmitted';
export const RETURN_COMPLETED = 'ord.ReturnCompleted';
/** Abuse case 12: a false return to obtain a refund (docs/security/THREAT_MODEL.md). */
const RETURN_ABUSE_CASE = 12;
/** The refund reason of what a completed return asks back against its credit note (migration 0198). */
const ORDER_RETURNED_REFUND_REASON = 'ORDER_RETURNED';
/** The System principal, for the rows an approval writes when the decider is not named. */
const SYSTEM_ACTOR_ID = '01900000-0000-7000-8000-000000000001';

/** The contract's `ReturnCreate`. */
export interface ReturnCreateRequest {
  readonly orderId: string;
  readonly kind: 'RETURN' | 'EXCHANGE';
  readonly reasonCode: string;
  readonly refundDestination: RefundDestination;
  readonly note: string | null;
  readonly lines: readonly { readonly orderLineId: string; readonly qty: string; readonly weightKg: string | null; readonly disposition: Disposition }[];
}

/** The contract's `OrderReturn`. */
export interface OrderReturnView {
  readonly id: string;
  readonly returnNo: string;
  readonly status: ReturnRecord['status'];
  readonly order: { readonly id: string; readonly docType: 'SALES_ORDER'; readonly number: string | null };
  readonly originalBillingDocument: { readonly id: string; readonly docType: string; readonly number: string | null };
  readonly kind: ReturnRecord['kind'];
  readonly reasonCode: string;
  readonly lines: readonly {
    readonly id: string;
    readonly orderLineId: string;
    readonly product: { readonly id: string; readonly sku: string; readonly name: string };
    readonly qty: string;
    readonly weightKg: string | null;
    readonly disposition: Disposition;
    readonly refundPesewas: number;
  }[];
  readonly creditNote: { readonly id: string; readonly docType: 'CREDIT_NOTE'; readonly number: string | null } | null;
  readonly refund: { readonly id: string; readonly status: string; readonly amountPesewas: number } | null;
  readonly exchangeOrderId: null;
  readonly approvalRequestId: string | null;
  readonly totalRefundPesewas: number;
  readonly currency: 'GHS';
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly displayName: string };
}

const invalidState = (what: string, status: string) => new InvalidStateTransitionError(`${what} is ${status}`, [{ field: null, code: status, message: translate('error.invalid_state_transition') }]);

/**
 * Returns against the original sale (FR-ORD-015, FR-PAY-012, ADR-0010, ADR-0066, abuse case 12, A-228), each command
 * authorised in the application layer at the sale's branch (ADR-0035) and idempotent.
 *
 * `createReturn` takes back no more of each sold line than was sold less what returns not rejected hold (here, and by
 * `ck_order_return_line_cap` under the sold line's lock), with the refund each line's credit would carry. `submitReturn`,
 * by its maker only, always waits for `RETURN`: a holder of `ord.return.approve` with a fresh step-up who did not make
 * it (IAM, here, and `ck_order_return_decided`). Approved, in the approval's transaction: the credit note issued through
 * BIL's `Billing.creditIn`, made by the return's maker under that approval; each line not written off taken back into
 * stock through INV at its share of the issue's cost, to the shelf it left or the branch's returns holding area; and
 * the refund of what the sale now owes the customer asked for against that credit note through PAY's `Refunds.requestIn`,
 * the maker its maker, so that PAY's rules refuse the maker and the credit note's maker as its approver (ADR-0066).
 */
export class Returns {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ReturnStore,
    private readonly orders: OrderStore,
    private readonly refs: MasterDataRefs,
    private readonly movements: StockMovements,
    private readonly billing: Billing,
    private readonly payments: Payments,
    private readonly refunds: Refunds,
    private readonly approvals: Approvals,
    private readonly authoriser: Authoriser,
    private readonly principals: PrincipalNames,
    private readonly numbers: NumberSeries,
    private readonly documents: DocumentRegistry,
    private readonly idempotency: Idempotency,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** getReturn: one return at a branch the caller reads returns at. */
  get(actor: Actor | undefined, id: string): Promise<OrderReturnView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const [record] = await this.store.returns(tx, [id]);
      if (record === undefined) throw new NotFoundError('no such return');
      await this.authoriser.authorise(tx, actor, READ, { branchId: record.branchId });
      return this.viewIn(tx, record);
    });
  }

  /** createReturn (FR-ORD-015): REQUESTED, numbered, with the refund each line's credit would carry; nothing moves yet. */
  create(actor: Actor | undefined, body: ReturnCreateRequest, key: string): Promise<StoredResponse<OrderReturnView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE);
      const claim = await this.idempotency.claim(tx, { operationId: 'createReturn', principalId: actor!.principalId, key, request: body });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<OrderReturnView>;
      const header = await this.orders.lock(tx, body.orderId);
      if (header === null) throw new NotFoundError('no such order');
      await this.authoriser.authorise(tx, actor, CREATE, { branchId: header.branchId });
      const [order] = await this.orders.orders(tx, [header.id]);
      const lines = order!.lines;
      const returned = await this.store.returnedOf(
        tx,
        lines.map((l) => l.id),
      );
      const products = await this.refs.productsIn(tx, [...new Set(lines.map((l) => l.productId))]);
      const verdict = judgeReturn({
        orderStatus: header.status,
        kind: body.kind,
        sold: lines.map((l) => ({
          id: l.id,
          priceBasis: l.priceBasis,
          serial: products.get(l.productId)?.tracking === 'SERIAL',
          qtySold: Quantity.parse(l.qtyFulfilled),
          qtyReturned: Quantity.parse(returned.get(l.id) ?? '0.000'),
        })),
        asked: body.lines.map((l) => ({ orderLineId: l.orderLineId, qty: Quantity.parse(l.qty) })),
      });
      if (!verdict.ok && verdict.error.some((r) => r.rule === 'INVALID_STATE_TRANSITION')) throw invalidState(`order ${header.id}`, header.status);
      const broken: ReturnRule[] = [...(verdict.ok ? [] : verdict.error), ...(await this.reasonRules(tx, body))];
      if (body.lines.some((l) => l.disposition === 'RETURNS_HOLD') && (await this.refs.physicalLocationOfKindIn(tx, header.branchId, 'RETURNS_HOLD')) === null) {
        broken.push({ field: '/lines', rule: 'NO_RETURNS_HOLD' });
      }
      if (broken.length > 0) throw new OrderInvalidError(broken);

      const receiptLines = await this.billing.linesByOrderLineIn(tx, header.billingDocumentId!);
      const preview = await this.billing.creditPreviewIn(tx, header.billingDocumentId!, {
        reasonCode: body.reasonCode,
        note: body.note ?? undefined,
        lines: body.lines.map((l) => ({ lineId: receiptLines.get(l.orderLineId)!, quantity: l.qty })),
      });
      const id = this.nextId();
      const at = this.clock.now();
      const branch = (await this.refs.branchesIn(tx, [header.branchId])).get(header.branchId)!;
      await this.documents.register(tx, { id, docType: 'ORDER_RETURN', ownerModule: 'ord', branchId: header.branchId, actorId: actor!.principalId });
      const returnNo = await this.numbers.allocateIn(tx, { docType: 'ORDER_RETURN', fiscalYear: Number(toBusinessDate(at).slice(0, 4)), branchId: header.branchId, branchCode: branch.code, documentId: id });
      await this.store.insert(tx, {
        id,
        returnNo,
        salesOrderId: header.id,
        originalBillingDocumentId: header.billingDocumentId!,
        kind: body.kind,
        reasonCode: body.reasonCode,
        refundDestination: body.refundDestination,
        note: body.note,
        branchId: header.branchId,
        createdBy: actor!.principalId,
        lines: body.lines.map((l, i) => ({
          id: this.nextId(),
          salesOrderLineId: l.orderLineId,
          lineNo: lineNumber(i),
          qty: l.qty,
          weightKg: l.weightKg,
          disposition: l.disposition,
          refundPesewas: preview.lines[i]!.grossPesewas,
        })),
      });
      const [record] = await this.store.returns(tx, [id]);
      const view = await this.viewIn(tx, record!);
      await this.audit.record(tx, { module: 'ord', action: 'CREATE', entityType: 'OrderReturn', entityId: id, branchId: header.branchId, before: null, after: { ...view } });
      const response = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** submitReturn: by its maker only; always 202 under `RETURN`, and nothing moves until a different supervisor approves. */
  submit(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<ApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE);
      const claim = await this.idempotency.claim(tx, { operationId: 'submitReturn', principalId: actor!.principalId, key, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ApprovalPendingView>;
      const [record] = await this.store.returns(tx, [id], true);
      if (record === undefined) throw new NotFoundError('no such return');
      await this.authoriser.authorise(tx, actor, CREATE, { branchId: record.branchId });
      if (record.status !== 'REQUESTED') throw invalidState(`return ${id}`, record.status);
      if (record.createdBy !== actor!.principalId) throw new OrderInvalidError([{ field: '', rule: 'NOT_RETURN_MAKER' }]);

      const total = Money.sum(record.lines.map((l) => Money.ofPesewas(l.refundPesewas)));
      const summary = `Return ${record.returnNo} of ${formatCedis(total.pesewas)} (${record.reasonCode})`;
      const approval = await this.approvals.request(tx, actor, { kind: RETURN_KIND, branchId: record.branchId, subjectDocumentId: id, payloadHash: returnHash(record), amountPesewas: total.pesewas, summary });
      const at = this.clock.now();
      await this.store.submit(tx, id, { approvalRequestId: approval.id, actorId: actor!.principalId, at });
      const submitted: ReturnSubmitted = {
        returnId: id,
        returnNo: record.returnNo,
        orderId: record.salesOrderId,
        branchId: record.branchId,
        totalRefundPesewas: total.toJsonInteger(),
        reasonCode: record.reasonCode,
        approvalRequestId: approval.id,
        makerId: record.createdBy,
        abuseCases: [RETURN_ABUSE_CASE],
      };
      await this.events.publish(tx, { type: RETURN_SUBMITTED, subjectType: 'OrderReturn', subjectId: id, branchId: record.branchId, payload: submitted, occurredAt: at });
      await this.audit.record(tx, { module: 'ord', action: 'SUBMIT', entityType: 'OrderReturn', entityId: id, branchId: record.branchId, before: { status: record.status }, after: { status: 'PENDING_APPROVAL', approvalRequestId: approval.id } });
      const response = {
        status: 202,
        body: { status: 'PENDING_APPROVAL' as const, approvalRequestId: approval.id, kind: RETURN_KIND, subject: { id, docType: 'ORDER_RETURN', number: record.returnNo }, summary, requestedAt: approval.requestedAt.toISOString() },
      };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** IAM's handler for `RETURN`: the approved return takes effect in the approval's transaction. */
  readonly approvalHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, subjectDocumentId) => {
      const [record] = await this.store.returns(tx, [subjectDocumentId], true);
      if (record === undefined) throw new NotFoundError('no such return');
      return returnHash(record);
    },
    onApproved: async (tx: Transaction, request: ApprovalRecord) => {
      const record = await this.pendingOf(tx, request.id);
      if (record === null) throw new NotFoundError('no such return');
      const decider = request.decidedBy ?? SYSTEM_ACTOR_ID;
      if (!judgeReturnApprover(decider, { makerId: record.createdBy }).ok) throw new ReturnApproverIsMakerError('the person who made a return cannot approve it');
      await this.completeIn(tx, record, decider, request);
    },
    onRejected: async (tx: Transaction, request: ApprovalRecord) => {
      const record = await this.pendingOf(tx, request.id);
      if (record === null) return;
      const decider = request.decidedBy ?? SYSTEM_ACTOR_ID;
      await this.store.decide(tx, record.id, { status: 'REJECTED', creditNoteId: null, refundId: null, decidedBy: decider, at: this.clock.now() });
      await this.audit.record(tx, { module: 'ord', action: 'REJECT', entityType: 'OrderReturn', entityId: record.id, branchId: record.branchId, before: { status: record.status }, after: { status: 'REJECTED', approvalRequestId: request.id } });
    },
  };

  private async pendingOf(tx: Transaction, approvalRequestId: string): Promise<ReturnRecord | null> {
    const id = await this.store.idByApproval(tx, approvalRequestId);
    const [record] = id === null ? [] : await this.store.returns(tx, [id], true);
    return record?.status === 'PENDING_APPROVAL' ? record : null;
  }

  /** The approved return: the credit note, the stock back by disposition, the refund asked for against the credit note. */
  private async completeIn(tx: Transaction, record: ReturnRecord, decider: string, request: ApprovalRecord): Promise<void> {
    const header = (await this.orders.lock(tx, record.salesOrderId))!;
    if (header.status !== 'COMPLETED') throw invalidState(`order ${header.id}`, header.status satisfies OrderStatus);
    const before = await this.viewIn(tx, record);
    const receiptLines = await this.billing.linesByOrderLineIn(tx, record.originalBillingDocumentId);
    const credit = await this.billing.creditIn(
      tx,
      record.createdBy,
      record.originalBillingDocumentId,
      { reasonCode: record.reasonCode, note: record.note ?? undefined, lines: record.lines.map((l) => ({ lineId: receiptLines.get(l.salesOrderLineId)!, quantity: l.qty })) },
      request.id,
    );

    const [order] = await this.orders.orders(tx, [header.id]);
    const sold = new Map(order!.lines.map((l) => [l.id, l] as const));
    const holding = record.lines.some((l) => l.disposition === 'RETURNS_HOLD') ? await this.refs.physicalLocationOfKindIn(tx, header.branchId, 'RETURNS_HOLD') : null;
    const movementIds: string[] = [];
    for (const [i, line] of record.lines.entries()) {
      let movementId: string | null = null;
      if (line.disposition !== 'WRITE_OFF') {
        const soldLine = sold.get(line.salesOrderLineId)!;
        // The return counts in the unit the line was sold in (a crate); stock takes it back in the base unit (30 eggs, B09e).
        const base = await this.refs.toBaseIn(tx, soldLine.productId, soldLine.uom, Quantity.parse(line.qty));
        if (!base.ok) throw new Error(`a returned ${soldLine.uom} of product ${soldLine.productId} has no exact base quantity (${base.error})`);
        movementId = await this.movements.returnSaleIn(tx, decider, {
          issueMovementId: soldLine.stockMovementId!,
          qty: base.value,
          toLocationId: line.disposition === 'RETURNS_HOLD' ? holding : null,
          reasonCode: record.reasonCode,
          sourceDocumentId: record.id,
          sourceLineRef: line.id,
        });
        movementIds.push(movementId);
      }
      await this.store.setLine(tx, line.id, { refundPesewas: BigInt(credit.lines[i]!.lineGrossPesewas), stockMovementId: movementId });
    }

    const creditGross = Money.fromJsonInteger(credit.grossPesewas);
    const original = (await this.billing.settleableIn(tx, [record.originalBillingDocumentId])).get(record.originalBillingDocumentId)!;
    const plan = planReturnRefund(creditGross, Money.ofPesewas(original.refundablePesewas), await this.payments.ofOrderIn(tx, header.id));
    let refundId: string | null = null;
    if (plan !== null) {
      // The refund is asked for by the return's maker, so PAY refuses them (and the credit note's maker) as its approver.
      const maker: Actor = { principalId: record.createdBy, kind: 'USER', displayName: '', realm: 'STAFF', sessionId: null, steppedUpAt: null };
      const asked = await this.refunds.requestIn(tx, maker, {
        originalPaymentId: plan.paymentId,
        amountPesewas: plan.amount.pesewas,
        destination: record.refundDestination,
        reasonCode: ORDER_RETURNED_REFUND_REASON,
        creditNoteId: credit.id,
        note: `Return ${record.returnNo}`,
      });
      refundId = asked.subject.id;
    }

    const at = this.clock.now();
    await this.store.decide(tx, record.id, { status: 'COMPLETED', creditNoteId: credit.id, refundId, decidedBy: decider, at });
    const completed: ReturnCompleted = {
      returnId: record.id,
      returnNo: record.returnNo,
      orderId: header.id,
      orderNo: header.orderNo!,
      branchId: record.branchId,
      reasonCode: record.reasonCode,
      creditNoteId: credit.id,
      creditNoteNo: credit.documentNo!,
      refundId,
      totalRefundPesewas: creditGross.toJsonInteger(),
      refundRequestedPesewas: plan === null ? 0 : plan.amount.toJsonInteger(),
      movementIds,
      approvalRequestId: request.id,
      makerId: record.createdBy,
      approvedBy: decider,
      completedAt: at.toISOString(),
      abuseCases: [RETURN_ABUSE_CASE],
    };
    await this.events.publish(tx, { type: RETURN_COMPLETED, subjectType: 'OrderReturn', subjectId: record.id, branchId: record.branchId, payload: completed, occurredAt: at });
    const [after] = await this.store.returns(tx, [record.id]);
    await this.audit.record(tx, { module: 'ord', action: 'APPROVE', entityType: 'OrderReturn', entityId: record.id, branchId: record.branchId, before: { ...before }, after: { ...(await this.viewIn(tx, after!)) } });
  }

  /** The rules a return's reason breaks: a `RETURN` reason, with its note where the reason asks for one. */
  private async reasonRules(tx: Transaction, body: ReturnCreateRequest): Promise<ReturnRule[]> {
    const reason = (await this.refs.reasonCodesIn(tx, [body.reasonCode])).get(body.reasonCode);
    if (reason === undefined || reason.domain !== 'RETURN') return [{ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' }];
    if (reason.requiresNote && (body.note === null || body.note.trim() === '')) return [{ field: '/note', rule: 'NOTE_REQUIRED' }];
    return [];
  }

  private async viewIn(tx: Transaction, r: ReturnRecord): Promise<OrderReturnView> {
    const [order] = await this.orders.orders(tx, [r.salesOrderId]);
    const productOf = new Map(order!.lines.map((l) => [l.id, l.productId] as const));
    const products = await this.refs.productsIn(tx, [...new Set(r.lines.map((l) => productOf.get(l.salesOrderLineId)!))]);
    const documents = new Map((await this.billing.viewsIn(tx, [r.originalBillingDocumentId, ...(r.creditNoteId === null ? [] : [r.creditNoteId])])).map((d) => [d.id, d] as const));
    const refund = r.refundId === null ? null : ((await this.refunds.summariesIn(tx, [r.refundId])).get(r.refundId) ?? null);
    const maker = (await this.principals.refs(tx, [r.createdBy])).get(r.createdBy);
    const original = documents.get(r.originalBillingDocumentId)!;
    const credit = r.creditNoteId === null ? null : documents.get(r.creditNoteId)!;
    return {
      id: r.id,
      returnNo: r.returnNo,
      status: r.status,
      order: { id: r.salesOrderId, docType: 'SALES_ORDER', number: order!.orderNo },
      originalBillingDocument: { id: original.id, docType: original.kind, number: original.documentNo },
      kind: r.kind,
      reasonCode: r.reasonCode,
      lines: r.lines.map((l) => {
        const product = products.get(productOf.get(l.salesOrderLineId)!)!;
        return {
          id: l.id,
          orderLineId: l.salesOrderLineId,
          product: { id: product.id, sku: product.sku, name: product.name },
          qty: l.qty,
          weightKg: l.weightKg,
          disposition: l.disposition,
          refundPesewas: Money.ofPesewas(l.refundPesewas).toJsonInteger(),
        };
      }),
      creditNote: credit === null ? null : { id: credit.id, docType: 'CREDIT_NOTE', number: credit.documentNo },
      refund,
      exchangeOrderId: null,
      approvalRequestId: r.approvalRequestId,
      totalRefundPesewas: Money.sum(r.lines.map((l) => Money.ofPesewas(l.refundPesewas))).toJsonInteger(),
      currency: 'GHS',
      branchId: r.branchId,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      createdBy: { id: r.createdBy, displayName: maker?.displayName ?? '' },
    };
  }
}

/** What a return approval binds: the return as it was asked, which cannot change while it waits. */
function returnHash(r: ReturnRecord): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        id: r.id,
        orderId: r.salesOrderId,
        reasonCode: r.reasonCode,
        refundDestination: r.refundDestination,
        lines: r.lines.map((l) => ({ id: l.id, orderLineId: l.salesOrderLineId, qty: l.qty, disposition: l.disposition, refundPesewas: l.refundPesewas.toString() })),
      }),
      'utf8',
    )
    .digest('hex');
}
