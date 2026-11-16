import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { PaymentProviderError, type ProviderTransaction } from '../../../platform/payments/payment-provider';
import type { ResilientPaymentProvider } from '../../../platform/payments/resilient-provider';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { judgeMissingCharge, judgeProviderAnswer, maskPhone, type ChargeDecision, type ProviderAnswer } from '../domain/charge';
import { addMs } from '../domain/time';
import { jsonPesewas as json } from '../domain/tender';
import type { PaymentCleared, PaymentFailed, PaymentInitiated } from '../events';
import type { Breaks } from './breaks';
import { PaymentInvalidError, PaymentProviderUnavailableError, type PaymentRule } from './errors';
import type { ChargeRecord, PaymentStore, Verification } from './payment-store';
import { PAYMENT_CLEARED, type PaymentDocumentView, type Payments } from './payments';

export const PAYMENT_INITIATED = 'pay.PaymentInitiated';
export const PAYMENT_FAILED = 'pay.PaymentFailed';
/** The provider PAY's port reaches (A-047): its code on payments, charges, webhooks and the ledger's party. */
export const PROVIDER = 'PAYSTACK';
/** How long an order waits for a mobile money approval: the checkout's hold (A-045). */
export const CHARGE_WINDOW_MS = 900_000;
/** A charge is looked up by the sweep once it is this old, so the webhook usually comes first (FR-PAY-007). */
export const LOOKUP_AFTER_MS = 30_000;
/** The first sweep reads this far back. */
const FIRST_SWEEP_LOOKBACK_MS = 86_400_000;
const SWEEP_PAGE_SIZE = 100;
const SWEEP_MAX_PAGES = 50;
const SWEEP_OPEN_CHARGES = 200;
const INITIATE = 'pay.payment.initiate';
const READ = 'pay.payment.read';

export interface MobileMoneyRequest {
  readonly id: string;
  readonly amountPesewas: bigint;
  readonly payerPhone: string;
  readonly network: 'MTN' | 'TELECEL' | 'AIRTELTIGO';
  readonly orderId: string | null;
  readonly shiftId: string | null;
  readonly customerId: string | null;
}

export interface SweepReport {
  readonly from: Date;
  readonly to: Date;
  readonly transactions: number;
  readonly cleared: number;
  readonly failed: number;
  readonly breaksRaised: number;
}

export function answerOf(t: ProviderTransaction): ProviderAnswer {
  return { status: t.status, amountPesewas: t.amountPesewas, currency: t.currency, paidAt: t.paidAt };
}

/**
 * Provider payments (FR-PAY-003 to FR-PAY-008): a mobile money charge is written PENDING with our reference before the
 * provider hears of it, then sent outside any business transaction through the port (timeout, bounded retry with
 * jitter, circuit breaker), so a retry reuses the reference and can never charge twice. It clears in one place,
 * `settleIn`, on the provider's own answer only (a webhook's lookup, `checkPaymentStatus`, or the sweep), as an
 * unallocated deposit; money that arrives after its order stopped waiting is held unmatched with a break, never lost.
 * The sweep (the owner, 2026-11-16) reads the provider's transaction list from where the last run ended and looks up
 * every charge still open, so a payment whose webhook never came is still found.
 */
export class ProviderPayments {
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
    private readonly provider: ResilientPaymentProvider,
    private readonly payerEmail: string | null,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** `initiateMobileMoneyCharge` (FR-PAY-003): one payment and one charge per key; 503 while the provider is down. */
  async initiate(actor: Actor | undefined, body: MobileMoneyRequest, key: string): Promise<StoredResponse<PaymentDocumentView>> {
    const stored = await this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, INITIATE);
      const claim = await this.idempotency.claim(tx, { operationId: 'initiateMobileMoneyCharge', principalId: actor!.principalId, key, request: { ...body, amountPesewas: body.amountPesewas.toString() } });
      if (claim.kind === 'REPLAY') return { replay: true as const, response: claim.response as StoredResponse<PaymentDocumentView> };
      if (!this.provider.available() || this.payerEmail === null) throw new PaymentProviderUnavailableError('the payment provider cannot take a charge now');
      const branchId = await this.branchOf(tx, actor!, body);
      await this.authoriser.authorise(tx, actor, INITIATE, { branchId });
      const method = (await this.refs.paymentMethodsByCodeIn(tx, ['MOMO'])).get('MOMO');
      const broken: PaymentRule[] = [];
      if (method === undefined || !method.isLive) broken.push({ field: '', rule: 'METHOD_DISABLED' });
      if (body.amountPesewas <= 0n) broken.push({ field: '/amountPesewas', rule: 'AMOUNT_NOT_POSITIVE' });
      if (body.shiftId !== null) broken.push({ field: '/shiftId', rule: 'SHIFT_NOT_AVAILABLE' });
      if (body.customerId !== null && (await this.refs.customersIn(tx, [body.customerId])).get(body.customerId)?.isLive !== true) broken.push({ field: '/customerId', rule: 'CUSTOMER_UNKNOWN' });
      if ((await this.store.payments(tx, [body.id])).length > 0 || (await this.documents.branchOf(tx, body.id)) !== null) broken.push({ field: '/id', rule: 'ID_IN_USE' });
      if (broken.length > 0) throw new PaymentInvalidError(broken);
      const now = this.clock.now();
      const reference = referenceOf(body.id);
      await this.documents.register(tx, { id: body.id, docType: 'PAYMENT', ownerModule: 'pay', branchId, actorId: actor!.principalId });
      await this.store.insert(tx, {
        id: body.id,
        paymentMethodId: method!.id,
        methodKind: 'MOBILE_MONEY',
        amountPesewas: body.amountPesewas,
        customerId: body.customerId,
        orderDocumentId: body.orderId,
        shiftDocumentId: null,
        register: null,
        provider: PROVIDER,
        providerReference: reference,
        payerPhoneMasked: maskPhone(body.payerPhone),
        verification: 'UNVERIFIED',
        status: 'PENDING',
        receivedAt: now,
        clearedAt: null,
        branchId,
        actorId: actor!.principalId,
      });
      await this.store.insertCharge(tx, {
        id: this.nextId(),
        paymentId: body.id,
        provider: PROVIDER,
        reference,
        channel: 'MOBILE_MONEY',
        network: body.network,
        requestedPesewas: body.amountPesewas,
        awaitedUntil: addMs(now, CHARGE_WINDOW_MS),
        createdAt: now,
        branchId,
        actorId: actor!.principalId,
      });
      const payload: PaymentInitiated = { paymentId: body.id, branchId, methodKind: 'MOBILE_MONEY', amountPesewas: json(body.amountPesewas), orderDocumentId: body.orderId, provider: PROVIDER };
      await this.events.publish(tx, { type: PAYMENT_INITIATED, subjectType: 'Payment', subjectId: body.id, branchId, payload });
      const [view] = await this.payments.documentViewsIn(tx, [body.id]);
      await this.audit.record(tx, { module: 'pay', action: 'INITIATE', entityType: 'Payment', entityId: body.id, branchId, before: null, after: { ...view! } });
      const response = { status: 201, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return { replay: false as const, response };
    });
    // Outside any transaction: the charge is sent, or sent again after a timeout with the same reference.
    await this.send(stored.response.body.id, body.payerPhone);
    const [current] = await this.uow.run({ isolation: 'read committed' }, (tx) => this.payments.documentViewsIn(tx, [stored.response.body.id]));
    return { status: stored.response.status, body: current! };
  }

  /** `checkPaymentStatus` (FR-PAY-007): the provider's own answer for one pending payment, through the one clearing path. */
  async checkStatus(actor: Actor | undefined, paymentId: string): Promise<PaymentDocumentView> {
    const charge = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const [payment] = await this.store.payments(tx, [paymentId]);
      if (payment === undefined) throw new NotFoundError('no such payment');
      await this.authoriser.authorise(tx, actor, READ, { branchId: payment.branchId });
      return payment.status === 'PENDING' ? this.store.chargeOfPayment(tx, paymentId) : null;
    });
    if (charge !== null && (charge.status === 'INITIATED' || charge.status === 'PENDING')) {
      try {
        await this.lookUp(charge, actor!.principalId);
      } catch (error) {
        if (error instanceof PaymentProviderError && error.kind === 'UNAVAILABLE') throw new PaymentProviderUnavailableError('the payment provider cannot be asked now', [], { cause: error });
        throw error;
      }
    }
    return this.uow.run({ isolation: 'read committed' }, async (tx) => (await this.payments.documentViewsIn(tx, [paymentId]))[0]!);
  }

  /**
   * The one clearing path (FR-PAY-004, FR-PAY-007, FR-PAY-008): the provider's answer for a charge applied once, under
   * the payment's lock. A payment no longer pending is left as it is, so a late webhook, a second lookup or a sweep
   * changes nothing. Answers the decision taken, or null when there was nothing to decide.
   */
  async settleIn(tx: Transaction, reference: string, answer: ProviderAnswer, verification: Exclude<Verification, 'NOT_REQUIRED' | 'UNVERIFIED'>, actorId: string): Promise<ChargeDecision | null> {
    const charge = await this.store.chargeByReference(tx, PROVIDER, reference, true);
    if (charge === null) return null;
    const [payment] = await this.store.payments(tx, [charge.paymentId], true);
    if (payment === undefined || payment.status !== 'PENDING' || (charge.status !== 'INITIATED' && charge.status !== 'PENDING')) return null;
    const now = this.clock.now();
    const decision = judgeProviderAnswer({ requestedPesewas: charge.requestedPesewas, createdAt: charge.createdAt, awaitedUntil: charge.awaitedUntil, releasedAt: charge.releasedAt }, answer, now);
    const [before] = await this.payments.documentViewsIn(tx, [payment.id]);
    switch (decision.kind) {
      case 'WAIT':
        await this.store.updateCharge(tx, charge.id, { status: 'PENDING', providerStatus: answer.status, lastCheckedAt: now }, actorId);
        return decision;
      case 'AMOUNT_DIFFERS':
        await this.store.updateCharge(tx, charge.id, { status: 'SUCCEEDED', providerStatus: answer.status, confirmedPesewas: decision.confirmedPesewas, verifiedAt: now, lastCheckedAt: now }, actorId);
        await this.breaks.raiseIn(tx, actorId, {
          kind: 'PROVIDER_AMOUNT_DIFFERS',
          branchId: payment.branchId,
          paymentId: payment.id,
          refundId: null,
          provider: PROVIDER,
          reference,
          amountPesewas: decision.confirmedPesewas,
          details: { requestedPesewas: json(charge.requestedPesewas), confirmedPesewas: json(decision.confirmedPesewas), currency: answer.currency },
        });
        break;
      case 'FAIL': {
        await this.store.updateCharge(tx, charge.id, { status: decision.status, providerStatus: answer.status, lastCheckedAt: now }, actorId);
        await this.store.markFailed(tx, payment.id, decision.reason, actorId);
        const failed: PaymentFailed = { paymentId: payment.id, branchId: payment.branchId, orderDocumentId: payment.orderDocumentId, reason: decision.reason };
        await this.events.publish(tx, { type: PAYMENT_FAILED, subjectType: 'Payment', subjectId: payment.id, branchId: payment.branchId, payload: failed });
        break;
      }
      case 'CLEAR': {
        await this.store.updateCharge(tx, charge.id, { status: 'SUCCEEDED', providerStatus: answer.status, confirmedPesewas: answer.amountPesewas, verifiedAt: now, lastCheckedAt: now }, actorId);
        await this.store.markCleared(tx, payment.id, verification, now, actorId);
        const cleared: PaymentCleared = {
          paymentId: payment.id,
          branchId: payment.branchId,
          methodKind: payment.methodKind,
          amountPesewas: json(payment.amountPesewas),
          allocatedPesewas: 0,
          unallocatedPesewas: json(payment.amountPesewas),
          customerId: payment.customerId,
          orderDocumentId: payment.orderDocumentId,
          register: null,
          allocations: [],
          receivedAt: payment.receivedAt.toISOString(),
          provider: PROVIDER,
          heldAsUnmatched: decision.heldAsUnmatched,
        };
        await this.events.publish(tx, { type: PAYMENT_CLEARED, subjectType: 'Payment', subjectId: payment.id, branchId: payment.branchId, payload: cleared, occurredAt: now });
        if (decision.heldAsUnmatched) {
          await this.breaks.raiseIn(tx, actorId, {
            kind: 'UNMATCHED_PAYMENT',
            branchId: payment.branchId,
            paymentId: payment.id,
            refundId: null,
            provider: PROVIDER,
            reference,
            amountPesewas: payment.amountPesewas,
            details: { reason: charge.releasedAt === null ? 'PAID_AFTER_WINDOW' : 'ORDER_RELEASED', awaitedUntil: charge.awaitedUntil.toISOString(), releasedAt: charge.releasedAt?.toISOString() ?? null, orderDocumentId: payment.orderDocumentId },
          });
        }
        break;
      }
    }
    const [after] = await this.payments.documentViewsIn(tx, [payment.id]);
    await this.audit.record(tx, { module: 'pay', action: decision.kind === 'CLEAR' ? 'CLEAR' : decision.kind === 'FAIL' ? 'FAIL' : 'HOLD', entityType: 'Payment', entityId: payment.id, branchId: payment.branchId, before: { ...before! }, after: { ...after!, verification } });
    return decision;
  }

  /**
   * The port ORD calls when an order stops waiting for its money (cancelled, expired) in its own transaction: any
   * money that still arrives clears as an unmatched deposit with a break (FR-PAY-008). It authorises nothing.
   */
  async releaseChargeIn(tx: Transaction, paymentId: string, actorId: string): Promise<void> {
    const charge = await this.store.chargeOfPayment(tx, paymentId, true);
    if (charge !== null && charge.releasedAt === null) await this.store.updateCharge(tx, charge.id, { releasedAt: this.clock.now() }, actorId);
  }

  /**
   * The provider sweep (the owner, 2026-11-16; FR-PAY-007): the provider's transaction list from where the last run ended
   * to now, each success applied through `settleIn` (a payment whose webhook never came is cleared), a success we never
   * initiated raised as a break, and every charge still open looked up, a charge the provider has no record of after
   * the grace period failed with a break. A run that cannot reach the provider records nothing and the next run reads
   * the same window again; a second run over a window changes nothing.
   */
  async sweep(system: { readonly principalId: string }): Promise<SweepReport> {
    const to = this.clock.now();
    const from = (await this.uow.run({ isolation: 'read committed' }, (tx) => this.store.lastSweepEnd(tx, PROVIDER))) ?? addMs(to, -FIRST_SWEEP_LOOKBACK_MS);
    let transactions = 0;
    let cleared = 0;
    let failed = 0;
    let breaksRaised = 0;
    const count = (decision: ChargeDecision | null) => {
      if (decision?.kind === 'CLEAR') cleared += 1;
      if (decision?.kind === 'FAIL') failed += 1;
      if (decision?.kind === 'AMOUNT_DIFFERS') breaksRaised += 1;
      if (decision?.kind === 'CLEAR' && decision.heldAsUnmatched) breaksRaised += 1;
    };
    if (to.getTime() > from.getTime()) {
      for (let page = 1; page <= SWEEP_MAX_PAGES; page += 1) {
        const listed = await this.provider.listTransactions({ from, to, page, perPage: SWEEP_PAGE_SIZE });
        for (const t of listed.transactions) {
          transactions += 1;
          await this.uow.run({ isolation: 'serializable' }, async (tx) => {
            const ours = await this.store.chargeByReference(tx, PROVIDER, t.reference);
            if (ours !== null) {
              count(await this.settleIn(tx, t.reference, answerOf(t), 'PROVIDER_LOOKUP', system.principalId));
            } else if (t.status === 'SUCCESS') {
              const raised = await this.breaks.raiseIn(tx, system.principalId, {
                kind: 'PROVIDER_REFERENCE_UNKNOWN',
                branchId: null,
                paymentId: null,
                refundId: null,
                provider: PROVIDER,
                reference: t.reference,
                amountPesewas: t.amountPesewas,
                details: { providerTransactionId: t.providerTransactionId, currency: t.currency, paidAt: t.paidAt?.toISOString() ?? null, source: 'SWEEP' },
              });
              if (raised) breaksRaised += 1;
            }
          });
        }
        if (!listed.hasMore) break;
      }
    }
    const open = await this.uow.run({ isolation: 'read committed' }, (tx) => this.store.openCharges(tx, PROVIDER, addMs(to, -LOOKUP_AFTER_MS), SWEEP_OPEN_CHARGES));
    for (const charge of open) {
      const outcome = await this.lookUp(charge, system.principalId);
      if (outcome === 'MISSING') {
        failed += 1;
        breaksRaised += 1;
      } else count(outcome);
    }
    if (to.getTime() > from.getTime()) {
      await this.uow.run({ isolation: 'read committed' }, (tx) =>
        this.store.insertSweep(tx, { id: this.nextId(), provider: PROVIDER, from, to, transactions, cleared, breaksRaised, actorId: system.principalId }),
      );
    }
    return { from, to, transactions, cleared, failed, breaksRaised };
  }

  /** One charge looked up with the provider and applied; a charge it has no record of fails once the grace period ends. */
  private async lookUp(charge: ChargeRecord, actorId: string): Promise<ChargeDecision | 'MISSING' | null> {
    let found: ProviderTransaction;
    try {
      found = await this.provider.lookup(charge.reference);
    } catch (error) {
      if (!(error instanceof PaymentProviderError) || error.kind !== 'NOT_FOUND') throw error;
      if (judgeMissingCharge({ requestedPesewas: charge.requestedPesewas, createdAt: charge.createdAt, awaitedUntil: charge.awaitedUntil, releasedAt: charge.releasedAt }, this.clock.now()) === 'WAIT') return null;
      return this.uow.run({ isolation: 'serializable' }, (tx) => this.failMissingIn(tx, charge, actorId));
    }
    return this.uow.run({ isolation: 'serializable' }, (tx) => this.settleIn(tx, charge.reference, answerOf(found), 'PROVIDER_LOOKUP', actorId));
  }

  private async failMissingIn(tx: Transaction, charge: ChargeRecord, actorId: string): Promise<'MISSING' | null> {
    const locked = await this.store.chargeByReference(tx, PROVIDER, charge.reference, true);
    const [payment] = await this.store.payments(tx, [charge.paymentId], true);
    if (locked === null || payment?.status !== 'PENDING' || (locked.status !== 'INITIATED' && locked.status !== 'PENDING')) return null;
    const reason = 'The provider has no record of the charge';
    await this.store.updateCharge(tx, locked.id, { status: 'ABANDONED', providerStatus: 'NOT_FOUND', lastCheckedAt: this.clock.now() }, actorId);
    await this.store.markFailed(tx, payment.id, reason, actorId);
    await this.events.publish(tx, { type: PAYMENT_FAILED, subjectType: 'Payment', subjectId: payment.id, branchId: payment.branchId, payload: { paymentId: payment.id, branchId: payment.branchId, orderDocumentId: payment.orderDocumentId, reason } satisfies PaymentFailed });
    await this.breaks.raiseIn(tx, actorId, {
      kind: 'PROVIDER_PAYMENT_MISSING',
      branchId: payment.branchId,
      paymentId: payment.id,
      refundId: null,
      provider: PROVIDER,
      reference: locked.reference,
      amountPesewas: payment.amountPesewas,
      details: { createdAt: locked.createdAt.toISOString() },
    });
    await this.audit.record(tx, { module: 'pay', action: 'FAIL', entityType: 'Payment', entityId: payment.id, branchId: payment.branchId, before: { status: 'PENDING' }, after: { status: 'FAILED', failureReason: reason } });
    return 'MISSING';
  }

  /** Sends a charge still INITIATED; a provider that cannot be reached leaves it for the sweep and answers 503. */
  private async send(paymentId: string, phone: string): Promise<void> {
    const charge = await this.uow.run({ isolation: 'read committed' }, (tx) => this.store.chargeOfPayment(tx, paymentId));
    if (charge === null || charge.status !== 'INITIATED') return;
    let status: ProviderTransaction['status'];
    try {
      status = (await this.provider.chargeMobileMoney({ reference: charge.reference, amountPesewas: charge.requestedPesewas, email: this.payerEmail!, phone, network: charge.network! })).status;
    } catch (error) {
      if (error instanceof PaymentProviderError && error.kind !== 'UNAVAILABLE') {
        await this.uow.run({ isolation: 'serializable' }, (tx) => this.settleIn(tx, charge.reference, { status: 'FAILED', amountPesewas: charge.requestedPesewas, currency: 'GHS', paidAt: null }, 'PROVIDER_LOOKUP', SYSTEM_ACTOR_ID));
        return;
      }
      this.logger.warn({ paymentId, err: error instanceof Error ? error.message : String(error) }, 'mobile money charge not sent; the sweep looks it up');
      throw new PaymentProviderUnavailableError('the payment provider cannot take a charge now', [], { cause: error });
    }
    await this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const locked = await this.store.chargeByReference(tx, PROVIDER, charge.reference, true);
      // A webhook may have settled it while the provider answered (FR-PAY-008): then nothing changes here.
      if (locked?.status === 'INITIATED') await this.store.updateCharge(tx, locked.id, { status: 'PENDING', providerStatus: status }, SYSTEM_ACTOR_ID);
    });
  }

  private async branchOf(tx: Transaction, actor: Actor, body: MobileMoneyRequest): Promise<string> {
    if (body.orderId !== null) {
      const order = (await this.documents.refs(tx, [body.orderId])).get(body.orderId);
      if (order?.docType !== 'SALES_ORDER') throw new PaymentInvalidError([{ field: '/orderId', rule: 'ORDER_UNKNOWN' }]);
      return (await this.documents.branchOf(tx, body.orderId))!;
    }
    const branches = [...new Set((await this.authoriser.scopes(tx, actor, INITIATE)).filter((s) => s.locationId === null).map((s) => s.branchId))];
    if (branches.length !== 1) throw new PaymentInvalidError([{ field: '/orderId', rule: 'BRANCH_REQUIRED' }]);
    return branches[0]!;
  }
}

/** The System principal: what the payment flows act as once the request that started them has been answered. */
const SYSTEM_ACTOR_ID = '01900000-0000-7000-8000-000000000001';

/** Our reference for a payment's charge, sent to the provider before anything else and reused on every retry. */
export function referenceOf(paymentId: string): string {
  return `HK-${paymentId}`;
}
