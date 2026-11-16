import { createHash } from 'node:crypto';
import { createUuidV7Generator, formatCedis, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import { databaseErrorOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { PaymentProviderError } from '../../../platform/payments/payment-provider';
import type { ResilientPaymentProvider } from '../../../platform/payments/resilient-provider';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { judgeStoredRefund, nextRefundAttempt, refundLeftOf, type RefundDestination } from '../domain/refund';
import { jsonPesewas as json } from '../domain/tender';
import { addMs, pageProbe } from '../domain/time';
import type { RefundFailed, RefundPaid, RefundRequested } from '../events';
import type { Breaks } from './breaks';
import type { StoreCredit } from './store-credit';
import { RefundExceedsPaymentError, RefundInvalidError, RefundMakerCannotPayError, type PaymentRule } from './errors';
import type { PaymentRecord, PaymentStore, RefundRecord, RefundStatus } from './payment-store';
import { REFUND_PAID, type Page, type Payments } from './payments';

export const REFUND_KIND = 'REFUND';
export const REFUND_REQUESTED = 'pay.RefundRequested';
export const REFUND_FAILED = 'pay.RefundFailed';
/** Abuse case 12: a false return to obtain a refund (docs/security/THREAT_MODEL.md), on the refund report. */
const REFUND_ABUSE_CASE = 12;
const READ = 'pay.refund.read';
const CREATE = 'pay.refund.create';
const PAY = 'pay.refund.pay';
/** A provider refund accepted but not yet processed is asked about again after this long. */
const REFUND_STATUS_CHECK_MS = 60_000;
const DISPATCH_BATCH = 50;
/** The System principal: a provider refund is paid out by the system, never by its maker (`ck_refund_paid_by`). */
const SYSTEM_ACTOR_ID = '01900000-0000-7000-8000-000000000001';
const PROVIDER_KINDS: ReadonlySet<string> = new Set(['MOBILE_MONEY', 'CARD']);

export interface RefundRequest {
  readonly originalPaymentId: string;
  readonly amountPesewas: bigint;
  readonly destination: RefundDestination;
  readonly reasonCode: string;
  readonly creditNoteId: string | null;
  readonly note: string | null;
}

/** The contract's `Refund`. A refund carries no number: the payment it returns and its approval are its links. */
export interface RefundView {
  readonly id: string;
  readonly refundNo: null;
  readonly status: RefundStatus;
  readonly originalPayment: { readonly id: string; readonly paymentNo: null; readonly method: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string } };
  readonly amountPesewas: number;
  readonly currency: 'GHS';
  readonly destination: RefundDestination;
  readonly reasonCode: string;
  readonly creditNote: null;
  readonly isAutomatic: boolean;
  readonly approvalRequestId: string | null;
  readonly providerReference: string | null;
  readonly paidAt: string | null;
  readonly failureReason: string | null;
  readonly branchId: string;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly displayName: string };
}

export interface ApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: string;
  readonly subject: { readonly id: string; readonly docType: string; readonly number: null };
  readonly summary: string;
  readonly requestedAt: string;
}

export interface RefundQuery {
  readonly status: RefundStatus | null;
  readonly createdBy: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
}

/**
 * Refunds (FR-PAY-012, FR-PAY-013, abuse case 12; the owner, 2026-11-16: "refunds are where till fraud lives"). A
 * refund references its original payment and draws only on its unallocated, unrefunded money (held by the database,
 * `trg_refund_cap`). Every refund a person asks for waits for a different person holding `pay.refund.approve`, with a
 * fresh step-up (`REFUND`, threshold 0), so a single Owner cannot refund alone. Approved, a mobile money or card
 * refund goes back through the provider (the `refund-dispatch` job: outside any transaction, the refund's id its
 * idempotency key, retried with backoff and, after the third failure, a break for a person); any other is paid by
 * hand and recorded with `markRefundPaid` by someone other than its maker. Paid, ◆ `pay.RefundPaid` posts it.
 */
export class Refunds {
  private readonly nextId: () => string;

  constructor(
    private readonly store: PaymentStore,
    private readonly payments: Payments,
    private readonly refs: MasterDataRefs,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly breaks: Breaks,
    private readonly uow: UnitOfWork,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly approvals: Approvals,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly provider: ResilientPaymentProvider,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly storeCredit: StoreCredit,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** `requestRefund`: always 202, nothing paid until a different person approves (FR-PAY-012). */
  request(actor: Actor | undefined, body: RefundRequest, key: string): Promise<StoredResponse<ApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE);
      const claim = await this.idempotency.claim(tx, { operationId: 'requestRefund', principalId: actor!.principalId, key, request: { ...body, amountPesewas: body.amountPesewas.toString() } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ApprovalPendingView>;
      const [payment] = await this.store.payments(tx, [body.originalPaymentId], true);
      if (payment === undefined) throw new NotFoundError('no such payment');
      await this.authoriser.authorise(tx, actor, CREATE, { branchId: payment.branchId });
      const broken: PaymentRule[] = [];
      const reason = (await this.refs.reasonCodesIn(tx, [body.reasonCode])).get(body.reasonCode);
      if (reason === undefined || reason.domain !== 'REFUND') broken.push({ field: '/reasonCode', rule: 'REASON_UNKNOWN' });
      else if (reason.requiresNote && body.note === null) broken.push({ field: '/note', rule: 'NOTE_REQUIRED' });
      if (body.creditNoteId !== null) broken.push({ field: '/creditNoteId', rule: 'CREDIT_NOTE_NOT_AVAILABLE' });
      const judged = judgeStoredRefund(payment, body.amountPesewas, body.destination);
      if (!judged.ok && judged.error.includes('REFUND_EXCEEDS_PAYMENT') && broken.length === 0 && judged.error.length === 1) throw new RefundExceedsPaymentError(refundLeftOf(payment));
      if (!judged.ok) broken.push(...judged.error.map((rule) => ({ field: rule === 'DESTINATION_NOT_AVAILABLE' ? '/destination' : rule === 'PAYMENT_NOT_CLEARED' ? '/originalPaymentId' : '/amountPesewas', rule })));
      if (broken.length > 0) throw new RefundInvalidError(broken);

      const id = this.nextId();
      await this.documents.register(tx, { id, docType: 'REFUND', ownerModule: 'pay', branchId: payment.branchId, actorId: actor!.principalId });
      try {
        await this.store.insertRefund(tx, {
          id,
          originalPaymentId: payment.id,
          amountPesewas: body.amountPesewas,
          destination: body.destination,
          reasonCode: body.reasonCode,
          note: body.note,
          creditNoteId: null,
          isAutomatic: false,
          status: 'PENDING_APPROVAL',
          branchId: payment.branchId,
          createdBy: actor!.principalId,
        });
      } catch (error) {
        const failure = databaseErrorOf(error);
        if (failure?.code === 'HK010' && failure.constraint === 'ck_refund_cap') throw new RefundExceedsPaymentError(refundLeftOf(payment));
        throw error;
      }
      const [record] = await this.store.refunds(tx, [id]);
      const summary = `Refund ${formatCedis(body.amountPesewas)} of payment ${payment.providerReference ?? payment.id} (${body.reasonCode})`;
      const approval = await this.approvals.request(tx, actor, { kind: REFUND_KIND, branchId: payment.branchId, subjectDocumentId: id, payloadHash: refundHash(record!), amountPesewas: body.amountPesewas, summary });
      await this.store.updateRefund(tx, id, { approvalRequestId: approval.id }, actor!.principalId);
      const requested: RefundRequested = { refundId: id, paymentId: payment.id, branchId: payment.branchId, amountPesewas: json(body.amountPesewas), approvalRequestId: approval.id, requestedBy: actor!.principalId, abuseCases: [REFUND_ABUSE_CASE] };
      await this.events.publish(tx, { type: REFUND_REQUESTED, subjectType: 'Refund', subjectId: id, branchId: payment.branchId, payload: requested });
      const [view] = await this.views(tx, await this.store.refunds(tx, [id]));
      await this.audit.record(tx, { module: 'pay', action: 'SUBMIT', entityType: 'Refund', entityId: id, branchId: payment.branchId, before: null, after: { ...view! } });
      const response = {
        status: 202,
        body: { status: 'PENDING_APPROVAL' as const, approvalRequestId: approval.id, kind: REFUND_KIND, subject: { id, docType: 'REFUND', number: null }, summary, requestedAt: approval.requestedAt.toISOString() },
      };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** IAM's handler for `REFUND`: the approved refund goes to the provider's queue, or waits to be paid by hand. */
  readonly approvalHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, subjectDocumentId) => {
      const [refund] = await this.store.refunds(tx, [subjectDocumentId], true);
      if (refund === undefined) throw new NotFoundError('no such refund');
      return refundHash(refund);
    },
    onApproved: async (tx: Transaction, request: ApprovalRecord) => {
      const [refund] = await this.store.refunds(tx, [request.subjectDocumentId], true);
      const [payment] = await this.store.payments(tx, [refund!.originalPaymentId]);
      const viaProvider = refund!.destination === 'ORIGINAL_METHOD' && PROVIDER_KINDS.has(payment!.methodKind);
      const toCredit = toStoreCredit(refund!, payment!);
      const decider = request.decidedBy ?? SYSTEM_ACTOR_ID;
      await this.store.updateRefund(tx, refund!.id, { status: 'APPROVED', nextAttemptAt: viaProvider ? this.clock.now() : null }, decider);
      await this.audit.record(tx, { module: 'pay', action: 'APPROVE', entityType: 'Refund', entityId: refund!.id, branchId: refund!.branchId, before: { status: refund!.status }, after: { status: 'APPROVED', approvalRequestId: request.id, route: toCredit ? 'STORE_CREDIT' : viaProvider ? 'PROVIDER' : 'MANUAL' } });
      // A refund to store credit is paid at once, by its approver (never its maker), into the customer's credit (FR-PAY-015).
      if (toCredit) await this.payIn(tx, (await this.store.refunds(tx, [refund!.id], true))[0]!, payment!, 'STORE_CREDIT', this.clock.now(), decider, 'Paid to store credit');
    },
    onRejected: async (tx: Transaction, request: ApprovalRecord) => {
      const [refund] = await this.store.refunds(tx, [request.subjectDocumentId], true);
      if (refund?.status !== 'PENDING_APPROVAL') return;
      await this.store.updateRefund(tx, refund.id, { status: 'REJECTED' }, request.decidedBy ?? SYSTEM_ACTOR_ID);
      await this.audit.record(tx, { module: 'pay', action: 'REJECT', entityType: 'Refund', entityId: refund.id, branchId: refund.branchId, before: { status: refund.status }, after: { status: 'REJECTED', approvalRequestId: request.id } });
    },
  };

  /** `retryRefund`: a provider refund that failed is tried again now, with the same idempotency key. */
  retry(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<RefundView>> {
    return this.command(actor, CREATE, 'retryRefund', id, {}, key, async (tx, refund, payment) => {
      if (refund.status !== 'FAILED' || refund.destination !== 'ORIGINAL_METHOD' || !PROVIDER_KINDS.has(payment.methodKind)) throw new RefundInvalidError([{ field: '', rule: 'NOT_RETRYABLE' }]);
      await this.store.updateRefund(tx, id, { status: 'APPROVED', attempts: 0, nextAttemptAt: this.clock.now() }, actor!.principalId);
      return 'RETRY';
    });
  }

  /** `markRefundPaid` (FR-PAY-013): an approved refund paid by hand, recorded with its reference by someone other than its maker. */
  markPaid(actor: Actor | undefined, id: string, body: { readonly paidAt: Date; readonly externalReference: string | null }, key: string): Promise<StoredResponse<RefundView>> {
    return this.command(actor, PAY, 'markRefundPaid', id, { paidAt: body.paidAt.toISOString(), externalReference: body.externalReference }, key, async (tx, refund, payment) => {
      if (refund.createdBy === actor!.principalId) throw new RefundMakerCannotPayError('the maker of a refund cannot record its payout');
      const broken: PaymentRule[] = [];
      if (refund.status !== 'APPROVED' && refund.status !== 'FAILED') broken.push({ field: '', rule: 'NOT_PAYABLE' });
      if (body.externalReference === null) broken.push({ field: '/externalReference', rule: 'REFERENCE_REQUIRED' });
      if (body.paidAt.getTime() > this.clock.now().getTime() || body.paidAt.getTime() < refund.createdAt.getTime()) broken.push({ field: '/paidAt', rule: 'PAID_AT_OUT_OF_RANGE' });
      if (broken.length > 0) throw new RefundInvalidError(broken);
      await this.store.updateRefund(tx, id, { externalReference: body.externalReference!, nextAttemptAt: null }, actor!.principalId);
      await this.payIn(tx, refund, payment, 'MANUAL', body.paidAt, actor!.principalId, `Paid by hand, reference ${body.externalReference!}`);
      return 'PAY';
    });
  }

  get(actor: Actor | undefined, id: string): Promise<RefundView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const [refund] = await this.store.refunds(tx, [id]);
      if (refund === undefined) throw new NotFoundError('no such refund');
      await this.authoriser.authorise(tx, actor, READ, { branchId: refund.branchId });
      return (await this.views(tx, [refund]))[0]!;
    });
  }

  list(actor: Actor | undefined, query: RefundQuery, cursor: string | undefined, limit: number): Promise<Page<RefundView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const binding = { operationId: 'listRefunds', principalId: actor!.principalId, filters: { ...query, from: query.from?.toISOString() ?? null, to: query.to?.toISOString() ?? null } };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.listRefunds(tx, { ...query, branchIds }, beforeId, pageProbe(limit));
      const data = (await this.views(tx, await this.store.refunds(tx, found.slice(0, limit)))).sort((a, b) => (a.id < b.id ? 1 : -1));
      const hasMore = found.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  /**
   * The `refund-dispatch` job (FR-PAY-013): every provider refund due goes to the provider, or is asked about, outside
   * any business transaction. Accepted, it waits for the provider to process it; processed, it is paid and posted; a
   * failure is retried after 5 then 10 minutes, and after the third it waits for a person with a `REFUND_FAILED` break.
   * Nothing here touches stock: a released reservation stays released.
   */
  async dispatch(): Promise<{ readonly sent: number; readonly paid: number; readonly failed: number }> {
    const due = await this.uow.run({ isolation: 'read committed' }, (tx) => this.store.dueRefunds(tx, this.clock.now(), DISPATCH_BATCH));
    let sent = 0;
    let paid = 0;
    let failed = 0;
    for (const refund of due) {
      const outcome = await this.attempt(refund);
      if (outcome === 'SENT') sent += 1;
      if (outcome === 'PAID') paid += 1;
      if (outcome === 'FAILED') failed += 1;
    }
    return { sent, paid, failed };
  }

  private async attempt(due: RefundRecord): Promise<'SENT' | 'PAID' | 'FAILED' | 'WAITING' | 'SKIPPED'> {
    const claimed = await this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const [refund] = await this.store.refunds(tx, [due.id], true);
      if (refund === undefined || refund.nextAttemptAt === null || refund.nextAttemptAt.getTime() > this.clock.now().getTime()) return null;
      const [payment] = await this.store.payments(tx, [refund.originalPaymentId]);
      if (refund.status === 'FAILED') await this.store.updateRefund(tx, refund.id, { status: 'APPROVED' }, SYSTEM_ACTOR_ID);
      if (refund.status === 'APPROVED' || refund.status === 'FAILED') {
        await this.store.updateRefund(tx, refund.id, { status: 'PROCESSING', attempts: refund.attempts + 1, nextAttemptAt: addMs(this.clock.now(), REFUND_STATUS_CHECK_MS) }, SYSTEM_ACTOR_ID);
      } else {
        await this.store.updateRefund(tx, refund.id, { nextAttemptAt: addMs(this.clock.now(), REFUND_STATUS_CHECK_MS) }, SYSTEM_ACTOR_ID);
      }
      return { refund: (await this.store.refunds(tx, [refund.id]))[0]!, payment: payment!, wasSent: refund.status === 'PROCESSING' && refund.providerReference !== null };
    });
    if (claimed === null) return 'SKIPPED';
    const { refund, payment } = claimed;
    try {
      if (claimed.wasSent) {
        const status = await this.provider.refundStatus(refund.providerReference!);
        if (status.status === 'PENDING') return 'WAITING';
        if (status.status === 'FAILED') return this.failed(refund.id, 'The provider reported the refund failed');
        await this.uow.run({ isolation: 'serializable' }, async (tx) => {
          const [locked] = await this.store.refunds(tx, [refund.id], true);
          if (locked?.status === 'PROCESSING') await this.payIn(tx, locked, payment, 'PROVIDER', this.clock.now(), SYSTEM_ACTOR_ID);
        });
        return 'PAID';
      }
      const accepted = await this.provider.refund({ reference: payment.providerReference!, amountPesewas: refund.amountPesewas, idempotencyKey: refund.id });
      await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.store.updateRefund(tx, refund.id, { providerReference: accepted.refundId, providerStatus: accepted.status.slice(0, 40) }, SYSTEM_ACTOR_ID);
        if (accepted.status === 'processed') {
          const [locked] = await this.store.refunds(tx, [refund.id], true);
          await this.payIn(tx, locked!, payment, 'PROVIDER', this.clock.now(), SYSTEM_ACTOR_ID);
        }
      });
      return accepted.status === 'processed' ? 'PAID' : 'SENT';
    } catch (error) {
      if (!(error instanceof PaymentProviderError)) throw error;
      this.logger.warn({ refundId: refund.id, kind: error.kind }, 'provider refund attempt failed');
      return this.failed(refund.id, error.kind === 'UNAVAILABLE' ? 'The provider could not be reached' : 'The provider refused the refund');
    }
  }

  /** A failed attempt: retried with backoff, or after the last attempt left FAILED with a break for a person. */
  private async failed(refundId: string, reason: string): Promise<'FAILED'> {
    await this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const [refund] = await this.store.refunds(tx, [refundId], true);
      if (refund?.status !== 'PROCESSING') return;
      const plan = nextRefundAttempt(refund.attempts, this.clock.now());
      await this.store.updateRefund(tx, refund.id, { status: 'FAILED', failureReason: reason, nextAttemptAt: plan.kind === 'RETRY' ? plan.at : null }, SYSTEM_ACTOR_ID);
      const payload: RefundFailed = { refundId: refund.id, branchId: refund.branchId, attempts: refund.attempts, exhausted: plan.kind === 'EXHAUSTED' };
      await this.events.publish(tx, { type: REFUND_FAILED, subjectType: 'Refund', subjectId: refund.id, branchId: refund.branchId, payload });
      if (plan.kind === 'EXHAUSTED') {
        await this.breaks.raiseIn(tx, SYSTEM_ACTOR_ID, {
          kind: 'REFUND_FAILED',
          branchId: refund.branchId,
          paymentId: refund.originalPaymentId,
          refundId: refund.id,
          provider: null,
          reference: null,
          amountPesewas: refund.amountPesewas,
          details: { attempts: refund.attempts, reason },
        });
      }
      await this.audit.record(tx, { module: 'pay', action: 'FAIL', entityType: 'Refund', entityId: refund.id, branchId: refund.branchId, before: { status: 'PROCESSING' }, after: { status: 'FAILED', attempts: refund.attempts, failureReason: reason, exhausted: plan.kind === 'EXHAUSTED' } });
    });
    return 'FAILED';
  }

  /** A refund paid: PAID once, its break closed, and ◆ `pay.RefundPaid` posts it off the customer's deposit to the original tender. */
  private async payIn(tx: Transaction, refund: RefundRecord, payment: PaymentRecord, paidBy: 'PROVIDER' | 'MANUAL' | 'STORE_CREDIT', at: Date, actorId: string, note = 'Paid by the provider'): Promise<void> {
    await this.store.updateRefund(tx, refund.id, { status: 'PAID', paid: { at, by: actorId }, nextAttemptAt: null }, actorId);
    // A refund that waited for a person after failing is closed on the break queue once it is paid, by either path.
    await this.store.resolveRefundBreaks(tx, refund.id, note, this.clock.now(), actorId);
    const toCredit = toStoreCredit(refund, payment);
    if (toCredit) await this.storeCredit.issueIn(tx, actorId, { customerId: payment.customerId!, amountPesewas: refund.amountPesewas, sourceDocumentId: refund.id, branchId: refund.branchId });
    const payload: RefundPaid = {
      refundId: refund.id,
      paymentId: payment.id,
      branchId: refund.branchId,
      customerId: payment.customerId,
      amountPesewas: json(refund.amountPesewas),
      methodKind: toCredit ? 'STORE_CREDIT' : payment.methodKind,
      destination: refund.destination,
      register: toCredit || payment.registerRef === null || payment.registerCode === null ? null : { id: payment.registerRef, code: payment.registerCode },
      provider: toCredit ? null : payment.provider,
      paidBy,
    };
    await this.events.publish(tx, { type: REFUND_PAID, subjectType: 'Refund', subjectId: refund.id, branchId: refund.branchId, payload, occurredAt: at });
    await this.audit.record(tx, { module: 'pay', action: 'PAY', entityType: 'Refund', entityId: refund.id, branchId: refund.branchId, before: { status: refund.status }, after: { status: 'PAID', paidAt: at.toISOString(), paidBy } });
  }

  private async command(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    id: string,
    request: object,
    key: string,
    work: (tx: Transaction, refund: RefundRecord, payment: PaymentRecord) => Promise<string>,
  ): Promise<StoredResponse<RefundView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key, request: { id, ...request } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<RefundView>;
      const [refund] = await this.store.refunds(tx, [id], true);
      if (refund === undefined) throw new NotFoundError('no such refund');
      await this.authoriser.authorise(tx, actor, permission, { branchId: refund.branchId });
      const [payment] = await this.store.payments(tx, [refund.originalPaymentId]);
      const [before] = await this.views(tx, [refund]);
      const action = await work(tx, refund, payment!);
      const [after] = await this.views(tx, await this.store.refunds(tx, [id]));
      await this.audit.record(tx, { module: 'pay', action, entityType: 'Refund', entityId: id, branchId: refund.branchId, before: { ...before! }, after: { ...after! } });
      const response = { status: 200, body: after! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private async views(tx: Transaction, refunds: readonly RefundRecord[]): Promise<RefundView[]> {
    const payments = new Map((await this.payments.documentViewsIn(tx, [...new Set(refunds.map((r) => r.originalPaymentId))])).map((p) => [p.id, p] as const));
    const names = await this.principals.refs(tx, [...new Set(refunds.map((r) => r.createdBy))]);
    return refunds.map((r) => {
      const payment = payments.get(r.originalPaymentId)!;
      return {
        id: r.id,
        refundNo: null,
        status: r.status,
        originalPayment: { id: payment.id, paymentNo: null, method: payment.method },
        amountPesewas: json(r.amountPesewas),
        currency: 'GHS' as const,
        destination: r.destination,
        reasonCode: r.reasonCode,
        creditNote: null,
        isAutomatic: r.isAutomatic,
        approvalRequestId: r.approvalRequestId,
        providerReference: r.providerReference,
        paidAt: r.paidAt?.toISOString() ?? null,
        failureReason: r.failureReason,
        branchId: r.branchId,
        createdAt: r.createdAt.toISOString(),
        createdBy: { id: r.createdBy, displayName: names.get(r.createdBy)?.displayName ?? r.createdBy },
      };
    });
  }
}

/** A refund paid into the customer's store credit: asked for so, or of a store credit tender back to its method. */
function toStoreCredit(refund: RefundRecord, payment: PaymentRecord): boolean {
  return refund.destination === 'STORE_CREDIT' || (refund.destination === 'ORIGINAL_METHOD' && payment.methodKind === 'STORE_CREDIT');
}

/** What a refund's approval binds to: the payment, the amount, where it goes and why. */
function refundHash(r: RefundRecord): string {
  return createHash('sha256')
    .update(canonicalJson({ originalPaymentId: r.originalPaymentId, amountPesewas: r.amountPesewas.toString(), destination: r.destination, reasonCode: r.reasonCode, note: r.note }), 'utf8')
    .digest('hex');
}

