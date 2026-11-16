import { createHash } from 'node:crypto';
import { createUuidV7Generator, formatCedis, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Billing } from '../../bil';
import type { BankAccounts } from '../../fin';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { judgeChequeClearance, judgeReceipt, judgeReversal } from '../domain/receipt';
import { jsonPesewas as json } from '../domain/tender';
import type { ChequeCleared, PaymentReversalRequested, PaymentReversed } from '../events';
import { PaymentInvalidError, PaymentRequiresVerificationError, PaymentReversalInvalidError, type PaymentRule } from './errors';
import type { PaymentRecord, PaymentStore, ReversalRecord } from './payment-store';
import { CHEQUE_CLEARED, PAYMENT_REVERSED, type PaymentDocumentView, type Payments } from './payments';
import type { ApprovalPendingView } from './refunds';
import type { StoreCredit } from './store-credit';

export const PAYMENT_REVERSAL_KIND = 'PAYMENT_REVERSAL';
export const PAYMENT_REVERSAL_REQUESTED = 'pay.PaymentReversalRequested';
/** Abuse case 32: a payment reversed to hide money taken, or to re-issue store credit (docs/security/THREAT_MODEL.md). */
const REVERSAL_ABUSE_CASE = 32;
const CREATE = 'pay.payment.create';
const CLEAR_CHEQUE = 'pay.payment.clear_cheque';
const REVERSE = 'pay.payment.reverse';
/** The System principal, for the rows an approval writes when the decider is not named. */
const SYSTEM_ACTOR_ID = '01900000-0000-7000-8000-000000000001';

/** `recordPayment`'s body as the contract's `PaymentRecord`, parsed. */
export interface ReceiptRequest {
  readonly id: string;
  readonly paymentMethodId: string;
  readonly amountPesewas: bigint;
  readonly customerId: string | null;
  readonly orderId: string | null;
  readonly shiftId: string | null;
  readonly bankAccountId: string | null;
  readonly externalReference: string | null;
  readonly chequeDueOn: string | null;
  readonly receivedAt: Date;
  readonly allocations: readonly { readonly billingDocumentId: string; readonly amountPesewas: bigint }[];
}

/**
 * Payments recorded by hand, cheques and reversals (FR-PAY-001, FR-PAY-011, FR-PAY-014, FR-PAY-015, ADR-0064). A cheque
 * is received PENDING into 1130 with its allocations applied, and clears into the bank account it was paid into on the
 * bank's confirmation (◆ `pay.ChequeCleared`). A bank transfer is recorded PENDING with nothing posted until a
 * statement line matches it (B09a continued 1c). Store credit clears at once off the customer's balance. Mobile money
 * and card are never recorded by hand (abuse case 4), nor cash, which a sale takes into an open shift's till.
 * A reversal (a bounced cheque, or a payment recorded in error) waits for a different person holding
 * `pay.reversal.approve` with a fresh step-up; approved, it reopens every allocation, writes a reversing payment linked
 * to the original, and posts the exact mirror of each entry the payment made (◆ `pay.PaymentReversed`).
 */
export class Receipts {
  private readonly nextId: () => string;

  constructor(
    private readonly store: PaymentStore,
    private readonly payments: Payments,
    private readonly storeCredit: StoreCredit,
    private readonly refs: MasterDataRefs,
    private readonly billing: Billing,
    private readonly bankAccounts: BankAccounts,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly uow: UnitOfWork,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly approvals: Approvals,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** `recordPayment` (FR-PAY-001): 201 with the payment, PENDING for a cheque or a bank transfer, CLEARED for store credit. */
  record(actor: Actor | undefined, body: ReceiptRequest, key: string): Promise<StoredResponse<PaymentDocumentView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE);
      const request = { ...body, amountPesewas: body.amountPesewas.toString(), receivedAt: body.receivedAt.toISOString(), allocations: body.allocations.map((a) => ({ ...a, amountPesewas: a.amountPesewas.toString() })) };
      const claim = await this.idempotency.claim(tx, { operationId: 'recordPayment', principalId: actor!.principalId, key, request });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<PaymentDocumentView>;
      const method = (await this.refs.paymentMethodsIn(tx, [body.paymentMethodId])).get(body.paymentMethodId);
      if (method === undefined) throw new PaymentInvalidError([{ field: '/paymentMethodId', rule: 'METHOD_UNKNOWN' }]);
      const branchId = await this.branchOf(tx, actor!, body);
      await this.authoriser.authorise(tx, actor, CREATE, { branchId });
      const customer = body.customerId === null ? undefined : (await this.refs.customersIn(tx, [body.customerId])).get(body.customerId);
      const bank = body.bankAccountId === null ? undefined : (await this.bankAccounts.payoutAccountsIn(tx, [body.bankAccountId])).get(body.bankAccountId);
      const judged = judgeReceipt({
        methodKind: method.kind,
        methodLive: method.isLive,
        amountPesewas: body.amountPesewas,
        allocationsPesewas: body.allocations.map((a) => a.amountPesewas),
        customerKnown: body.customerId === null ? null : customer?.isLive === true,
        bankAccount: body.bankAccountId === null ? null : (bank ?? { kind: 'UNKNOWN', isActive: false }),
        externalReference: body.externalReference,
        shiftNamed: body.shiftId !== null,
        receivedAt: body.receivedAt,
        now: this.clock.now(),
      });
      if (!judged.ok && judged.error.includes('REQUIRES_VERIFICATION')) throw new PaymentRequiresVerificationError('/paymentMethodId');
      const broken: PaymentRule[] = judged.ok ? [] : judged.error.map((rule) => ({ field: fieldOf(rule), rule }));
      broken.push(...(await this.payments.allocationRulesIn(tx, { branchId, customerId: body.customerId }, body.allocations)));
      if ((await this.store.payments(tx, [body.id])).length > 0 || (await this.documents.branchOf(tx, body.id)) !== null) broken.push({ field: '/id', rule: 'ID_IN_USE' });
      if (body.orderId !== null && (await this.documents.refs(tx, [body.orderId])).get(body.orderId)?.docType !== 'SALES_ORDER') broken.push({ field: '/orderId', rule: 'ORDER_UNKNOWN' });
      if (broken.length > 0 || !judged.ok) throw new PaymentInvalidError(broken);

      const now = this.clock.now();
      const cleared = judged.value.status === 'CLEARED';
      await this.payments.writeIn(tx, actor!.principalId, {
        id: body.id,
        paymentMethodId: method.id,
        methodKind: method.kind,
        amountPesewas: body.amountPesewas,
        customerId: body.customerId,
        orderDocumentId: body.orderId,
        shiftDocumentId: null,
        register: null,
        externalReference: body.externalReference,
        verification: 'NOT_REQUIRED',
        status: judged.value.status,
        receivedAt: body.receivedAt,
        clearedAt: cleared ? now : null,
        branchId,
        actorId: actor!.principalId,
        bankAccountId: body.bankAccountId,
        chequeDueOn: body.chequeDueOn,
        allocations: body.allocations,
        postsAtReceipt: judged.value.postsAtReceipt,
      });
      if (method.kind === 'STORE_CREDIT') {
        await this.storeCredit.redeemIn(tx, actor!.principalId, { customerId: body.customerId!, amountPesewas: body.amountPesewas, sourceDocumentId: body.id, branchId });
      }
      const [view] = await this.payments.documentViewsIn(tx, [body.id]);
      await this.audit.record(tx, { module: 'pay', action: 'RECORD', entityType: 'Payment', entityId: body.id, branchId, before: null, after: { ...view! } });
      const response = { status: 201, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** `clearCheque` (FR-PAY-011): a pending cheque cleared on the bank's confirmation, 1130 into the bank account (Dr 1100, Cr 1130). */
  clearCheque(actor: Actor | undefined, id: string, body: { readonly clearedOn: string }, key: string): Promise<StoredResponse<PaymentDocumentView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CLEAR_CHEQUE);
      const claim = await this.idempotency.claim(tx, { operationId: 'clearCheque', principalId: actor!.principalId, key, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<PaymentDocumentView>;
      const [payment] = await this.store.payments(tx, [id], true);
      if (payment === undefined) throw new NotFoundError('no such payment');
      await this.authoriser.authorise(tx, actor, CLEAR_CHEQUE, { branchId: payment.branchId });
      const judged = judgeChequeClearance({ methodKind: payment.methodKind, status: payment.status, receivedOn: toBusinessDate(payment.receivedAt) }, body.clearedOn, toBusinessDate(this.clock.now()));
      if (!judged.ok) throw new PaymentReversalInvalidError(judged.error.map((rule) => ({ field: rule === 'CLEARED_ON_OUT_OF_RANGE' ? '/clearedOn' : '', rule })));
      if ((await this.store.openReversalOf(tx, id))?.status === 'PENDING_APPROVAL') throw new PaymentReversalInvalidError([{ field: '', rule: 'REVERSAL_PENDING' }]);
      const [before] = await this.payments.documentViewsIn(tx, [id]);
      const clearanceRef = this.nextId();
      await this.store.markChequeCleared(tx, id, clearanceRef, this.clock.now(), actor!.principalId);
      const payload: ChequeCleared = {
        paymentId: id,
        clearanceRef,
        branchId: payment.branchId,
        bankAccountId: payment.bankAccountId!,
        customerId: payment.customerId,
        amountPesewas: json(payment.amountPesewas),
        clearedOn: body.clearedOn,
      };
      await this.events.publish(tx, { type: CHEQUE_CLEARED, subjectType: 'Payment', subjectId: id, branchId: payment.branchId, payload });
      const [after] = await this.payments.documentViewsIn(tx, [id]);
      await this.audit.record(tx, { module: 'pay', action: 'CLEAR', entityType: 'Payment', entityId: id, branchId: payment.branchId, before: { ...before! }, after: { ...after!, clearedOn: body.clearedOn } });
      const response = { status: 200, body: after! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** `reversePayment` (FR-PAY-011, FR-PAY-014): always 202; nothing changes until a different person approves with step-up. */
  requestReversal(actor: Actor | undefined, id: string, body: { readonly reasonCode: string; readonly note: string | null }, key: string): Promise<StoredResponse<ApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, REVERSE);
      const claim = await this.idempotency.claim(tx, { operationId: 'reversePayment', principalId: actor!.principalId, key, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ApprovalPendingView>;
      const [payment] = await this.store.payments(tx, [id], true);
      if (payment === undefined) throw new NotFoundError('no such payment');
      await this.authoriser.authorise(tx, actor, REVERSE, { branchId: payment.branchId });
      const reason = (await this.refs.reasonCodesIn(tx, [body.reasonCode])).get(body.reasonCode);
      const judged = judgeReversal(payment, reason === undefined ? null : { domain: reason.domain, code: body.reasonCode });
      const broken: PaymentRule[] = judged.ok ? [] : judged.error.map((rule) => ({ field: rule.startsWith('REASON') ? '/reasonCode' : '', rule }));
      if (body.note === null) broken.push({ field: '/note', rule: 'NOTE_REQUIRED' });
      if ((await this.store.openReversalOf(tx, id))?.status === 'PENDING_APPROVAL') broken.push({ field: '', rule: 'REVERSAL_PENDING' });
      if (broken.length > 0) throw new PaymentReversalInvalidError(broken);

      const reversalId = this.nextId();
      await this.store.insertReversal(tx, { id: reversalId, paymentId: id, reasonCode: body.reasonCode, note: body.note!, branchId: payment.branchId, createdBy: actor!.principalId });
      const reversal = (await this.store.openReversalOf(tx, id))!;
      const summary = `Reverse ${formatCedis(payment.amountPesewas)} ${payment.methodKind.toLowerCase().replace('_', ' ')} payment (${body.reasonCode})`;
      const approval = await this.approvals.request(tx, actor, { kind: PAYMENT_REVERSAL_KIND, branchId: payment.branchId, subjectDocumentId: id, payloadHash: reversalHash(payment, reversal), amountPesewas: payment.amountPesewas, summary });
      await this.store.updateReversal(tx, reversalId, { approvalRequestId: approval.id }, actor!.principalId);
      const requested: PaymentReversalRequested = {
        reversalId,
        paymentId: id,
        branchId: payment.branchId,
        amountPesewas: json(payment.amountPesewas),
        methodKind: payment.methodKind,
        reasonCode: body.reasonCode,
        approvalRequestId: approval.id,
        requestedBy: actor!.principalId,
        abuseCases: [REVERSAL_ABUSE_CASE],
      };
      await this.events.publish(tx, { type: PAYMENT_REVERSAL_REQUESTED, subjectType: 'Payment', subjectId: id, branchId: payment.branchId, payload: requested });
      await this.audit.record(tx, { module: 'pay', action: 'SUBMIT', entityType: 'PaymentReversal', entityId: reversalId, branchId: payment.branchId, before: null, after: { paymentId: id, reasonCode: body.reasonCode, note: body.note, approvalRequestId: approval.id } });
      const response = {
        status: 202,
        body: { status: 'PENDING_APPROVAL' as const, approvalRequestId: approval.id, kind: PAYMENT_REVERSAL_KIND, subject: { id, docType: 'PAYMENT', number: null }, summary, requestedAt: approval.requestedAt.toISOString() },
      };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** IAM's handler for `PAYMENT_REVERSAL`: the approved reversal takes effect in the approval's transaction. */
  readonly approvalHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, subjectDocumentId) => {
      const [payment] = await this.store.payments(tx, [subjectDocumentId], true);
      const reversal = await this.store.openReversalOf(tx, subjectDocumentId);
      if (payment === undefined || reversal === null) throw new NotFoundError('no such reversal');
      return reversalHash(payment, reversal);
    },
    onApproved: async (tx: Transaction, request: ApprovalRecord) => {
      const reversal = await this.store.reversalByApproval(tx, request.id);
      if (reversal?.status !== 'PENDING_APPROVAL') throw new NotFoundError('no such reversal');
      await this.reverseIn(tx, reversal, request.decidedBy ?? SYSTEM_ACTOR_ID, request.id);
    },
    onRejected: async (tx: Transaction, request: ApprovalRecord) => {
      const reversal = await this.store.reversalByApproval(tx, request.id);
      if (reversal?.status !== 'PENDING_APPROVAL') return;
      await this.store.updateReversal(tx, reversal.id, { status: 'REJECTED' }, request.decidedBy ?? SYSTEM_ACTOR_ID);
      await this.audit.record(tx, { module: 'pay', action: 'REJECT', entityType: 'PaymentReversal', entityId: reversal.id, branchId: reversal.branchId, before: { status: reversal.status }, after: { status: 'REJECTED', approvalRequestId: request.id } });
    },
  };

  /**
   * The approved reversal: every allocation reopened (each applied from deposit taken off by ◆ `pay.DepositAllocated`,
   * each applied at receipt reopened by the mirror), the original REVERSED (a bounced cheque FAILED), a reversing payment
   * written REVERSED and linked to it, the mirror of each entry the payment made (its receipt, and a cleared cheque's
   * clearing), and store credit given back for a redemption.
   */
  private async reverseIn(tx: Transaction, reversal: ReversalRecord, actorId: string, approvalRequestId: string): Promise<void> {
    const [payment] = await this.store.payments(tx, [reversal.paymentId], true);
    const reason = (await this.refs.reasonCodesIn(tx, [reversal.reasonCode])).get(reversal.reasonCode);
    const judged = judgeReversal(payment!, reason === undefined ? null : { domain: reason.domain, code: reversal.reasonCode });
    if (!judged.ok) throw new PaymentReversalInvalidError(judged.error.map((rule) => ({ field: '', rule })));
    const [before] = await this.payments.documentViewsIn(tx, [payment!.id]);
    const note = `Reversal: ${reversal.reasonCode}`;
    for (const allocation of await this.store.activeAllocations(tx, payment!.id)) {
      const allocationId = this.nextId();
      await this.store.allocate(tx, { id: allocationId, paymentId: payment!.id, billingDocumentId: allocation.billingDocumentId, amountPesewas: allocation.amountPesewas, direction: 'UNAPPLY', reversesAllocationId: allocation.id, reason: note, actorId });
      await this.billing.settleIn(tx, allocation.billingDocumentId, allocation.amountPesewas, 'UNAPPLY');
      if (allocation.atReceipt !== true) {
        await this.payments.publishAllocation(tx, payment!, { allocationId, billingDocumentId: allocation.billingDocumentId, applied: 0n, unapplied: allocation.amountPesewas, reverses: allocation.id });
      }
    }
    const bounced = judged.value.becomes === 'FAILED';
    if (bounced) await this.store.markFailed(tx, payment!.id, `Cheque dishonoured: ${reversal.note}`.slice(0, 500), actorId);
    else await this.store.markReversed(tx, payment!.id, actorId);

    const reversingId = this.nextId();
    const now = this.clock.now();
    await this.documents.register(tx, { id: reversingId, docType: 'PAYMENT', ownerModule: 'pay', branchId: payment!.branchId, actorId });
    await this.store.insert(tx, {
      id: reversingId,
      paymentMethodId: payment!.paymentMethodId,
      methodKind: payment!.methodKind,
      amountPesewas: payment!.amountPesewas,
      customerId: payment!.customerId,
      orderDocumentId: payment!.orderDocumentId,
      shiftDocumentId: payment!.shiftDocumentId,
      register: payment!.registerRef === null || payment!.registerCode === null ? null : { id: payment!.registerRef, code: payment!.registerCode },
      externalReference: payment!.externalReference,
      verification: payment!.verification,
      status: 'REVERSED',
      receivedAt: now,
      clearedAt: now,
      branchId: payment!.branchId,
      actorId,
      bankAccountId: payment!.bankAccountId,
      chequeDueOn: payment!.chequeDueOn,
      reversesPaymentId: payment!.id,
    });
    const mirrors: { readonly subject: string; readonly part: PaymentReversed['part'] }[] = [
      { subject: payment!.id, part: 'RECEIPT' },
      ...(payment!.clearanceRef === null ? [] : [{ subject: payment!.clearanceRef, part: 'CLEARING' as const }]),
    ];
    for (const mirror of mirrors) {
      const payload: PaymentReversed = {
        reversingPaymentId: reversingId,
        paymentId: payment!.id,
        reversesSubjectId: mirror.subject,
        part: mirror.part,
        branchId: payment!.branchId,
        customerId: payment!.customerId,
        orderDocumentId: payment!.orderDocumentId,
        methodKind: payment!.methodKind,
        amountPesewas: json(payment!.amountPesewas),
        reasonCode: reversal.reasonCode,
        bounced,
        approvalRequestId,
      };
      await this.events.publish(tx, { type: PAYMENT_REVERSED, subjectType: 'Payment', subjectId: payment!.id, branchId: payment!.branchId, payload });
    }
    if (payment!.methodKind === 'STORE_CREDIT') {
      await this.storeCredit.issueIn(tx, actorId, { customerId: payment!.customerId!, amountPesewas: payment!.amountPesewas, sourceDocumentId: reversingId, branchId: payment!.branchId });
    }
    await this.store.updateReversal(tx, reversal.id, { status: 'APPROVED', reversingPaymentId: reversingId }, actorId);
    const [after] = await this.payments.documentViewsIn(tx, [payment!.id]);
    await this.audit.record(tx, { module: 'pay', action: 'REVERSE', entityType: 'Payment', entityId: payment!.id, branchId: payment!.branchId, before: { ...before! }, after: { ...after!, reversingPaymentId: reversingId, approvalRequestId } });
  }

  /** The branch a receipt belongs to: its documents', or the caller's one branch when it allocates nothing. */
  private async branchOf(tx: Transaction, actor: Actor, body: ReceiptRequest): Promise<string> {
    const documented = await this.payments.branchOfDocumentsIn(tx, body.allocations.map((a) => a.billingDocumentId));
    if (documented !== null) return documented;
    if (body.orderId !== null) {
      const branch = await this.documents.branchOf(tx, body.orderId);
      if (branch !== null) return branch;
    }
    const branches = [...new Set((await this.authoriser.scopes(tx, actor, CREATE)).filter((s) => s.locationId === null).map((s) => s.branchId))];
    if (branches.length !== 1) throw new PaymentInvalidError([{ field: '/allocations', rule: 'BRANCH_REQUIRED' }]);
    return branches[0]!;
  }
}

function fieldOf(rule: string): string {
  if (rule.startsWith('BANK_ACCOUNT')) return '/bankAccountId';
  if (rule.startsWith('CUSTOMER')) return '/customerId';
  if (rule.startsWith('ALLOCATION')) return '/allocations';
  const fields: Record<string, string> = { SHIFT_NOT_AVAILABLE: '/shiftId', RECEIVED_IN_FUTURE: '/receivedAt', CHEQUE_NUMBER_REQUIRED: '/externalReference', AMOUNT_NOT_POSITIVE: '/amountPesewas' };
  return fields[rule] ?? '/paymentMethodId';
}

/** What a reversal's approval binds to: the payment as it stands and what was asked; a change in between voids it. */
function reversalHash(p: PaymentRecord, r: ReversalRecord): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        reversalId: r.id,
        paymentId: p.id,
        status: p.status,
        amountPesewas: p.amountPesewas.toString(),
        allocatedPesewas: p.allocatedPesewas.toString(),
        refundedPesewas: p.refundedPesewas.toString(),
        reasonCode: r.reasonCode,
        note: r.note,
      }),
      'utf8',
    )
    .digest('hex');
}
