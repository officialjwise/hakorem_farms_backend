import { createUuidV7Generator, Money, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { databaseErrorOf, IsolationLevelError, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, UnauthenticatedError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Billing } from '../../bil';
import type { BankAccounts } from '../../fin';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { judgeClearedTender } from '../domain/cleared-tender';
import { clearingOf, planTender, type MethodKind } from '../domain/tender';
import { pageProbe } from '../domain/time';
import type { DepositAllocated, PaymentCleared } from '../events';
import { AllocationExceedsAvailableError, PaymentInvalidError, PaymentRequiresVerificationError, type PaymentRule } from './errors';
import type { AllocationRecord, NewPayment, PaymentFilter, PaymentRecord, PaymentStatus, PaymentStore } from './payment-store';
import type { TillCashAnswer, TillCashRequest, TillShiftRegistry } from './till-shifts';

export const PAYMENT_CLEARED = 'pay.PaymentCleared';
export const DEPOSIT_ALLOCATED = 'pay.DepositAllocated';
export const REFUND_PAID = 'pay.RefundPaid';
export const CHEQUE_CLEARED = 'pay.ChequeCleared';
export const PAYMENT_REVERSED = 'pay.PaymentReversed';
/** PAY's ◆ events (ADR-0056), declared for the ledger's boot assertion. */
export const PROVIDER_SETTLED = 'pay.ProviderSettled';
export const UNIDENTIFIED_RECEIPT_HELD = 'pay.UnidentifiedReceiptHeld';
export const PAY_LEDGER_EVENTS = [PAYMENT_CLEARED, DEPOSIT_ALLOCATED, REFUND_PAID, CHEQUE_CLEARED, PAYMENT_REVERSED, PROVIDER_SETTLED, UNIDENTIFIED_RECEIPT_HELD] as const;

const READ = 'pay.payment.read';
const ALLOCATE = 'pay.payment.allocate';
/** Billing documents a payment settles; a proforma or a credit note is never paid. */
const SETTLEABLE_KINDS: ReadonlySet<string> = new Set(['INVOICE', 'RECEIPT', 'DEBIT_NOTE']);

/** Method kinds a tender may clear at once in B9a; the others clear by the flows that verify them (A-209). */
const RECORDABLE_AT_ONCE: ReadonlySet<MethodKind> = new Set(['CASH']);

export type SalesChannel = 'POS' | 'ONLINE' | 'WHOLESALE' | 'QUOTE';

/** A tender taken in a selling module's transaction, with what it settles now. */
export interface TenderRequest {
  readonly branchId: string;
  readonly channel: SalesChannel;
  readonly methodCode: string;
  readonly amountPesewas: bigint;
  readonly customerId: string | null;
  readonly orderDocumentId: string | null;
  readonly shiftDocumentId?: string | null;
  /** The till a cash tender goes into (its subledger on 1000). */
  readonly register: { readonly id: string; readonly code: string } | null;
  readonly receivedAt: Date;
  readonly allocations: readonly { readonly billingDocumentId: string; readonly amountPesewas: bigint }[];
  /**
   * Cash a till took offline on a shift that has since closed, recorded on that shift as a late entry (ADR-0077
   * Amendments, the owner on 2026-11-18): only cash, only by the shift's own cashier, only on a shift no longer open.
   */
  readonly lateEntry?: boolean;
}

/**
 * A sale's tender taken from a mobile money or card payment the provider already cleared at the till (FR-POS-006,
 * ADR-0079): the whole payment, applied to the sale's receipt.
 */
export interface ClearedTenderRequest {
  readonly paymentId: string;
  readonly methodCode: string;
  readonly amountPesewas: bigint;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly orderDocumentId: string;
  readonly shiftDocumentId: string;
  readonly billingDocumentId: string;
}

/** What one payment method took in a till shift. */
export interface ShiftTenderTotal {
  readonly paymentMethodId: string;
  readonly methodCode: string;
  readonly methodName: string;
  readonly methodKind: MethodKind;
  readonly count: number;
  readonly amountPesewas: bigint;
  readonly refundedPesewas: bigint;
}

/** A payment as a selling module reads it back in its own transaction (B9a). */
export interface PaymentView {
  readonly id: string;
  readonly methodCode: string;
  readonly methodKind: MethodKind;
  readonly status: PaymentRecord['status'];
  readonly verification: PaymentRecord['verification'];
  readonly amountPesewas: number;
  readonly allocatedPesewas: number;
  readonly unallocatedPesewas: number;
  readonly refundedPesewas: number;
  readonly currency: 'GHS';
  readonly customerId: string | null;
  readonly orderDocumentId: string | null;
  readonly register: { readonly id: string; readonly code: string } | null;
  readonly allocations: readonly { readonly id: string; readonly billingDocumentId: string; readonly amountPesewas: number; readonly direction: 'APPLY' | 'UNAPPLY' }[];
  readonly receivedAt: string;
  readonly clearedAt: string | null;
  readonly branchId: string;
}

interface DocumentRefView {
  readonly id: string;
  readonly docType: string;
  readonly number: string | null;
}

/** The contract's `Payment`. A payment carries no number of its own: the receipt or invoice it settles is the customer's document (A-208 (f)). */
export interface PaymentDocumentView {
  readonly id: string;
  readonly paymentNo: null;
  readonly status: PaymentStatus;
  readonly method: { readonly id: string; readonly code: string; readonly name: string; readonly kind: MethodKind };
  readonly amountPesewas: number;
  readonly currency: 'GHS';
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string } | null;
  readonly order: DocumentRefView | null;
  readonly shiftId: string | null;
  readonly driver: null;
  readonly bankAccount: { readonly id: string; readonly name: string; readonly kind: string; readonly last4: string } | null;
  readonly provider: string | null;
  readonly providerReference: string | null;
  readonly externalReference: string | null;
  readonly payerPhoneMasked: string | null;
  readonly verification: PaymentRecord['verification'];
  readonly chequeDueOn: string | null;
  readonly allocatedPesewas: number;
  readonly unallocatedPesewas: number;
  readonly refundedPesewas: number;
  readonly receivedAt: string;
  readonly clearedAt: string | null;
  readonly reversesPaymentId: string | null;
  readonly failureReason: string | null;
  readonly allocations: readonly { readonly id: string; readonly billingDocument: DocumentRefView; readonly amountPesewas: number; readonly direction: 'APPLY' | 'UNAPPLY'; readonly recordedAt: string }[];
  readonly branchId: string;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

export interface PaymentQuery {
  readonly status: PaymentStatus | null;
  readonly methodKind: MethodKind | null;
  readonly customerId: string | null;
  readonly orderId: string | null;
  readonly shiftId: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly unallocatedOnly: boolean;
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();

/** What a payment holds on deposit: nothing once it is reversed or failed, whatever its amounts read. */
const unallocatedOf = (r: PaymentRecord): bigint => (r.status === 'REVERSED' || r.status === 'FAILED' ? 0n : r.amountPesewas - r.allocatedPesewas - r.refundedPesewas);

/**
 * Payments (FR-PAY-001, FR-PAY-002, FR-PAY-005, FR-PAY-009, FR-PAY-010). `recordIn` is the port ORD's sale posting
 * calls (ADR-0010): a tender recorded in the caller's serializable transaction, cash cleared at once; a mobile money or
 * card payment is never recorded cleared from a caller's word (abuse case 4). Allocating a cleared payment's deposit to
 * billing documents, or taking an allocation off with a reason, is a ledger row of PAY's, BIL's settlement summary
 * moves through `Billing.settleIn`, and ◆ `pay.DepositAllocated` posts it; the database holds both sides' caps.
 */
export class Payments {
  private readonly nextId: () => string;

  constructor(
    private readonly store: PaymentStore,
    private readonly refs: MasterDataRefs,
    private readonly billing: Billing,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly cursors: Cursors,
    private readonly bankAccounts: BankAccounts,
    private readonly tills: TillShiftRegistry,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /**
   * Refuses cash moving into or out of a till unless POS's `TillShiftCheck` answers for the shift, under its lock: a till
   * shift, OPEN (never CLOSING, CLOSED or force-closed), of the till named, and the actor's own or recoverable by them
   * (ADR-0077, the owner on A-212 (a)). Every PAY path that takes or pays out a till's cash calls it, so a direct PAY
   * call cannot go round the shift. Answers the shift's till.
   */
  async tillCashIn(tx: Transaction, request: TillCashRequest, field: string): Promise<{ readonly id: string; readonly code: string; readonly locationId: string }> {
    const answer = await this.tillCashAnswerIn(tx, request);
    if (!answer.ok) throw new PaymentInvalidError([{ field, rule: answer.refusal }]);
    return answer.register;
  }

  /** POS's answer for cash through a shift, for a PAY command that words its own refusal (ADR-0077). */
  tillCashAnswerIn(tx: Transaction, request: TillCashRequest): Promise<TillCashAnswer> {
    return this.tills.cashAtIn(tx, request);
  }

  async recordIn(tx: Transaction, actor: Actor | undefined, request: TenderRequest, field = ''): Promise<PaymentView> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    if (actor === undefined) throw new UnauthenticatedError('a payment needs an actor');
    const method = (await this.refs.paymentMethodsByCodeIn(tx, [request.methodCode])).get(request.methodCode);
    const broken: PaymentRule[] = [];
    if (method === undefined) throw new PaymentInvalidError([{ field: `${field}/methodCode`, rule: 'METHOD_UNKNOWN' }]);
    if (method.kind === 'MOBILE_MONEY' || method.kind === 'CARD') throw new PaymentRequiresVerificationError(`${field}/methodCode`);
    if (!method.isLive) broken.push({ field: `${field}/methodCode`, rule: 'METHOD_DISABLED' });
    if (!method.channels.includes(request.channel)) broken.push({ field: `${field}/methodCode`, rule: 'METHOD_NOT_FOR_CHANNEL' });
    if (clearingOf(method.kind) !== 'AT_ONCE' || !RECORDABLE_AT_ONCE.has(method.kind)) broken.push({ field: `${field}/methodCode`, rule: 'TENDER_NOT_AVAILABLE' });
    if (method.kind === 'CASH' && request.register === null) broken.push({ field: `${field}/register`, rule: 'REGISTER_REQUIRED' });
    // Cash enters a till only inside a till shift (the owner on A-212 (a)); POS checks the shift is open under its lock.
    if (method.kind === 'CASH' && request.register !== null && (request.shiftDocumentId ?? null) === null) broken.push({ field: `${field}/register`, rule: 'SHIFT_REQUIRED' });
    if (request.lateEntry === true && method.kind !== 'CASH') broken.push({ field: `${field}/methodCode`, rule: 'LATE_ENTRY_ONLY_CASH' });
    const plan = planTender(
      Money.ofPesewas(request.amountPesewas),
      request.allocations.map((a) => Money.ofPesewas(a.amountPesewas)),
    );
    if (!plan.ok) broken.push({ field: `${field}/amountPesewas`, rule: plan.error });
    if (broken.length > 0 || !plan.ok) throw new PaymentInvalidError(broken);

    const id = this.nextId();
    await this.writeIn(tx, actor.principalId, {
      id,
      paymentMethodId: method.id,
      methodKind: method.kind,
      amountPesewas: request.amountPesewas,
      customerId: request.customerId,
      orderDocumentId: request.orderDocumentId,
      shiftDocumentId: request.shiftDocumentId ?? null,
      register: request.register,
      verification: 'NOT_REQUIRED',
      status: 'CLEARED',
      receivedAt: request.receivedAt,
      clearedAt: request.receivedAt,
      branchId: request.branchId,
      actorId: actor.principalId,
      allocations: request.allocations,
      postsAtReceipt: true,
      ...(request.lateEntry === true ? { lateEntry: true } : {}),
    }, `${field}/register`);
    const [view] = await this.viewsIn(tx, [id]);
    await this.audit.record(tx, { module: 'pay', action: 'RECORD', entityType: 'Payment', entityId: id, branchId: request.branchId, before: null, after: { ...view! } });
    return view!;
  }

  /**
   * Takes a payment the provider already cleared as a sale's tender, in the caller's serializable transaction (ORD's
   * sale posting, FR-POS-006, ADR-0079). Under the payment's lock it must be a mobile money or card payment the provider
   * confirmed, taken at the sale's own till shift (still open, and the seller's: ADR-0077) for the sale's customer or for
   * nobody on a walk-in sale, never yet taken for an order, allocated or refunded, and the tender must be its whole
   * amount, so no change is ever given from it (`judgeClearedTender`; a payment of another branch is answered as
   * unknown). It is then linked to the sale (`pay.payment_order_link`, insert-only, one per payment, the same rules held
   * by the database) and allocated to the sale's receipt, posted from deposit by ◆ `pay.DepositAllocated` (Dr 2200 Cr
   * 1200), and audited. Refusals are 422 `PAYMENT_INVALID` on `<field>/paymentId`.
   */
  async takeClearedIn(tx: Transaction, actor: Actor | undefined, request: ClearedTenderRequest, field = ''): Promise<PaymentView> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    if (actor === undefined) throw new UnauthenticatedError('a payment needs an actor');
    const method = (await this.refs.paymentMethodsByCodeIn(tx, [request.methodCode])).get(request.methodCode);
    const [payment] = await this.store.payments(tx, [request.paymentId], true);
    const linked = payment === undefined ? new Map<string, string>() : await this.store.linkedOrders(tx, [payment.id]);
    const judged = judgeClearedTender(payment === undefined ? null : { ...payment, linkedToOrder: linked.has(payment.id) }, {
      paymentMethodId: method?.id ?? '',
      amountPesewas: request.amountPesewas,
      customerId: request.customerId,
      branchId: request.branchId,
      shiftDocumentId: request.shiftDocumentId,
    });
    if (!judged.ok) throw new PaymentInvalidError(judged.error.map((rule) => ({ field: `${field}/paymentId`, rule })));
    // The shift the payment was taken at still takes entries, from this seller (ADR-0077); the database holds it too.
    await this.tillCashIn(tx, { shiftDocumentId: request.shiftDocumentId, registerId: null, branchId: request.branchId, actorId: actor.principalId, direction: 'IN' }, `${field}/paymentId`);
    const [before] = await this.documentViews(tx, [payment!]);
    await this.store.insertOrderLink(tx, {
      paymentId: payment!.id,
      orderDocumentId: request.orderDocumentId,
      shiftDocumentId: request.shiftDocumentId,
      customerId: request.customerId,
      branchId: request.branchId,
      recordedAt: this.clock.now(),
      actorId: actor.principalId,
    });
    const allocationId = this.nextId();
    await this.capped(`${field}/amountPesewas`, () => this.store.allocate(tx, { id: allocationId, paymentId: payment!.id, billingDocumentId: request.billingDocumentId, amountPesewas: request.amountPesewas, direction: 'APPLY', actorId: actor.principalId }));
    await this.billing.settleIn(tx, request.billingDocumentId, request.amountPesewas, 'APPLY');
    await this.publishAllocation(tx, payment!, { allocationId, billingDocumentId: request.billingDocumentId, applied: request.amountPesewas, unapplied: 0n, reverses: null });
    const [after] = await this.documentViewsIn(tx, [payment!.id]);
    await this.audit.record(tx, { module: 'pay', action: 'TAKE_AS_TENDER', entityType: 'Payment', entityId: payment!.id, branchId: payment!.branchId, before: { ...before! }, after: { ...after! } });
    return (await this.viewsIn(tx, [payment!.id]))[0]!;
  }

  /**
   * What a till shift took, by payment method (FR-POS-017, FR-POS-019): the payments naming the shift that stand
   * (cleared and not reversed), their count and amount, and what was refunded of them. Read-only, for POS's reports
   * and its close; it authorises nothing.
   */
  async shiftTotalsIn(tx: Transaction, shiftDocumentId: string): Promise<ShiftTenderTotal[]> {
    const rows = await this.store.shiftTotals(tx, shiftDocumentId);
    const methods = await this.refs.paymentMethodsIn(tx, rows.map((r) => r.paymentMethodId));
    return rows.map((r) => {
      const method = methods.get(r.paymentMethodId);
      return { ...r, methodCode: method?.code ?? r.methodKind, methodName: method?.name ?? r.methodKind };
    });
  }

  /**
   * Writes a payment received and its allocations in the caller's serializable transaction (the sale's tender, or a
   * receipt recorded by hand): its document, its row, each allocation with BIL's settlement moved through
   * `Billing.settleIn`, and, when it posts at receipt, ◆ `pay.PaymentCleared` (a cheque into 1130, marked as awaiting
   * clearance). The allocations must already be judged; the database still holds both sides' caps.
   */
  async writeIn(tx: Transaction, actorId: string, p: NewPayment & { readonly allocations: readonly { readonly billingDocumentId: string; readonly amountPesewas: bigint }[]; readonly postsAtReceipt: boolean }, field = '/register'): Promise<void> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    // Cash into a till only through its open shift, whoever calls (ADR-0077); the database holds that it names one.
    if (p.methodKind === 'CASH' && p.register !== null) {
      if (p.shiftDocumentId === null) throw new PaymentInvalidError([{ field, rule: 'SHIFT_REQUIRED' }]);
      await this.tillCashIn(tx, { shiftDocumentId: p.shiftDocumentId, registerId: p.register.id, branchId: p.branchId, actorId, direction: 'IN', ...(p.lateEntry === true ? { lateEntry: true } : {}) }, field);
    }
    if (p.lateEntry === true && !(p.methodKind === 'CASH' && p.register !== null)) throw new PaymentInvalidError([{ field, rule: 'LATE_ENTRY_ONLY_CASH' }]);
    await this.documents.register(tx, { id: p.id, docType: 'PAYMENT', ownerModule: 'pay', branchId: p.branchId, actorId });
    await this.store.insert(tx, p);
    let allocated = 0n;
    for (const [i, allocation] of p.allocations.entries()) {
      await this.capped(`/allocations/${i}/amountPesewas`, () => this.store.allocate(tx, { id: this.nextId(), paymentId: p.id, billingDocumentId: allocation.billingDocumentId, amountPesewas: allocation.amountPesewas, direction: 'APPLY', actorId }));
      await this.billing.settleIn(tx, allocation.billingDocumentId, allocation.amountPesewas, 'APPLY');
      allocated += allocation.amountPesewas;
    }
    if (!p.postsAtReceipt) return;
    const payload: PaymentCleared = {
      paymentId: p.id,
      branchId: p.branchId,
      methodKind: p.methodKind,
      amountPesewas: json(p.amountPesewas),
      allocatedPesewas: json(allocated),
      unallocatedPesewas: json(p.amountPesewas - allocated),
      customerId: p.customerId,
      orderDocumentId: p.orderDocumentId,
      register: p.register,
      allocations: p.allocations.map((a) => ({ billingDocumentId: a.billingDocumentId, amountPesewas: json(a.amountPesewas) })),
      receivedAt: p.receivedAt.toISOString(),
      provider: null,
      heldAsUnmatched: false,
      ...(p.methodKind === 'CHEQUE' ? { awaitingClearance: true } : {}),
      ...(p.verification === 'UNVERIFIED' ? { unverified: true, bankAccountId: p.bankAccountId ?? null } : {}),
    };
    await this.events.publish(tx, { type: PAYMENT_CLEARED, subjectType: 'Payment', subjectId: p.id, branchId: p.branchId, payload, occurredAt: p.receivedAt });
  }

  /**
   * What allocating a payment of a customer at a branch to these documents breaks (FR-PAY-009): each an issued invoice,
   * receipt or debit note of the same branch and customer, named once, for an amount above zero.
   */
  async allocationRulesIn(tx: Transaction, at: { readonly branchId: string; readonly customerId: string | null }, allocations: readonly { readonly billingDocumentId: string; readonly amountPesewas: bigint }[]): Promise<PaymentRule[]> {
    const broken: PaymentRule[] = [];
    const documents = await this.billing.settleableIn(tx, allocations.map((a) => a.billingDocumentId));
    const seen = new Set<string>();
    allocations.forEach((a, i) => {
      const doc = documents.get(a.billingDocumentId);
      const field = `/allocations/${i}`;
      if (a.amountPesewas <= 0n) broken.push({ field: `${field}/amountPesewas`, rule: 'ALLOCATION_NOT_POSITIVE' });
      if (seen.has(a.billingDocumentId)) broken.push({ field: `${field}/billingDocumentId`, rule: 'DUPLICATE_DOCUMENT' });
      seen.add(a.billingDocumentId);
      if (doc === undefined) broken.push({ field: `${field}/billingDocumentId`, rule: 'DOCUMENT_UNKNOWN' });
      else {
        if (!SETTLEABLE_KINDS.has(doc.kind) || doc.status !== 'ISSUED') broken.push({ field: `${field}/billingDocumentId`, rule: 'DOCUMENT_NOT_PAYABLE' });
        if (doc.branchId !== at.branchId) broken.push({ field: `${field}/billingDocumentId`, rule: 'BRANCH_DIFFERS' });
        if (doc.customerId !== at.customerId) broken.push({ field: `${field}/billingDocumentId`, rule: 'CUSTOMER_DIFFERS' });
      }
    });
    return broken;
  }

  /** The branch of the first billing document named, if any is known. */
  async branchOfDocumentsIn(tx: Transaction, ids: readonly string[]): Promise<string | null> {
    if (ids.length === 0) return null;
    return (await this.billing.settleableIn(tx, [ids[0]!])).get(ids[0]!)?.branchId ?? null;
  }

  /**
   * `allocatePayment` (FR-PAY-009): a cleared payment's deposit applied to issued invoices, receipts or debit notes of
   * the same customer at its branch, each never more than the payment has unallocated (PAY's trigger) nor the document
   * has outstanding (BIL's), each posted Dr 2200 Cr 1200 by ◆ `pay.DepositAllocated`.
   */
  allocate(actor: Actor | undefined, paymentId: string, body: { readonly allocations: readonly { readonly billingDocumentId: string; readonly amountPesewas: bigint }[] }, key: string): Promise<StoredResponse<PaymentDocumentView>> {
    return this.command(actor, 'allocatePayment', paymentId, { allocations: body.allocations.map((a) => ({ billingDocumentId: a.billingDocumentId, amountPesewas: a.amountPesewas.toString() })) }, key, async (tx, payment) => {
      const broken: PaymentRule[] = [];
      if (payment.status !== 'CLEARED') broken.push({ field: '', rule: 'PAYMENT_NOT_CLEARED' });
      if (body.allocations.length === 0) broken.push({ field: '/allocations', rule: 'NO_ALLOCATIONS' });
      broken.push(...(await this.allocationRulesIn(tx, payment, body.allocations)));
      if (broken.length > 0) throw new PaymentInvalidError(broken);
      for (const [i, a] of body.allocations.entries()) {
        const allocationId = this.nextId();
        await this.capped(`/allocations/${i}/amountPesewas`, () => this.store.allocate(tx, { id: allocationId, paymentId, billingDocumentId: a.billingDocumentId, amountPesewas: a.amountPesewas, direction: 'APPLY', actorId: actor!.principalId }));
        await this.billing.settleIn(tx, a.billingDocumentId, a.amountPesewas, 'APPLY');
        await this.publishAllocation(tx, payment, { allocationId, billingDocumentId: a.billingDocumentId, applied: a.amountPesewas, unapplied: 0n, reverses: null });
      }
      return 'ALLOCATE';
    });
  }

  /** `unallocatePayment` (FR-PAY-009): one allocation taken off with a reason, the money back on deposit (Dr 1200 Cr 2200). */
  unallocate(actor: Actor | undefined, paymentId: string, body: { readonly allocationId: string; readonly reason: string }, key: string): Promise<StoredResponse<PaymentDocumentView>> {
    return this.command(actor, 'unallocatePayment', paymentId, body, key, async (tx, payment) => {
      const original = await this.store.allocation(tx, body.allocationId);
      if (original === null || original.paymentId !== paymentId || original.direction !== 'APPLY') throw new PaymentInvalidError([{ field: '/allocationId', rule: 'ALLOCATION_UNKNOWN' }]);
      if (original.reversed) throw new PaymentInvalidError([{ field: '/allocationId', rule: 'ALREADY_UNALLOCATED' }]);
      if (payment.status !== 'CLEARED') throw new PaymentInvalidError([{ field: '', rule: 'PAYMENT_NOT_CLEARED' }]);
      const allocationId = this.nextId();
      await this.store.allocate(tx, {
        id: allocationId,
        paymentId,
        billingDocumentId: original.billingDocumentId,
        amountPesewas: original.amountPesewas,
        direction: 'UNAPPLY',
        reversesAllocationId: original.id,
        reason: body.reason,
        actorId: actor!.principalId,
      });
      await this.billing.settleIn(tx, original.billingDocumentId, original.amountPesewas, 'UNAPPLY');
      await this.publishAllocation(tx, payment, { allocationId, billingDocumentId: original.billingDocumentId, applied: 0n, unapplied: original.amountPesewas, reverses: original.id });
      return 'UNALLOCATE';
    });
  }

  get(actor: Actor | undefined, id: string): Promise<PaymentDocumentView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const [record] = await this.store.payments(tx, [id]);
      if (record === undefined) throw new NotFoundError('no such payment');
      await this.authoriser.authorise(tx, actor, READ, { branchId: record.branchId });
      return (await this.documentViews(tx, [record]))[0]!;
    });
  }

  list(actor: Actor | undefined, query: PaymentQuery, cursor: string | undefined, limit: number): Promise<Page<PaymentDocumentView>> {
    return this.page(actor, 'listPayments', { ...query, from: query.from?.toISOString() ?? null, to: query.to?.toISOString() ?? null }, cursor, limit, (tx, branchIds, beforeId, probe) =>
      this.store.list(tx, { ...query, branchIds } satisfies PaymentFilter, beforeId, probe),
    );
  }

  /** `listUnmatchedPayments` (FR-PAY-005, abuse case 4): provider payments still pending verification, and money held unmatched. */
  listUnmatched(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<PaymentDocumentView>> {
    return this.page(actor, 'listUnmatchedPayments', {}, cursor, limit, (tx, branchIds, beforeId, probe) => this.store.unmatched(tx, branchIds, beforeId, probe));
  }

  /** Payments by id, as a selling module reads them; unknown ids are absent. */
  async viewsIn(tx: Transaction, ids: readonly string[]): Promise<PaymentView[]> {
    if (ids.length === 0) return [];
    const records = await this.store.payments(tx, ids);
    return this.views(tx, records);
  }

  /** The payments taken for an order, oldest first. */
  async ofOrderIn(tx: Transaction, orderDocumentId: string): Promise<PaymentView[]> {
    return this.views(tx, await this.store.paymentsOfOrder(tx, orderDocumentId));
  }

  /** Payments by id as the contract shows them; unknown ids are absent. */
  async documentViewsIn(tx: Transaction, ids: readonly string[]): Promise<PaymentDocumentView[]> {
    return this.documentViews(tx, await this.store.payments(tx, ids));
  }

  private async page(
    actor: Actor | undefined,
    operationId: string,
    filters: Record<string, unknown>,
    cursor: string | undefined,
    limit: number,
    ids: (tx: Transaction, branchIds: readonly string[], beforeId: string | null, probe: number) => Promise<string[]>,
  ): Promise<Page<PaymentDocumentView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const binding = { operationId, principalId: actor!.principalId, filters };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await ids(tx, branchIds, beforeId, pageProbe(limit));
      const records = await this.store.payments(tx, found.slice(0, limit));
      const data = (await this.documentViews(tx, records)).sort((a, b) => (a.id < b.id ? 1 : -1));
      const hasMore = found.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  /** An allocation command: authorised, idempotent, serializable, at the payment's branch, with its audit event. */
  private async command(
    actor: Actor | undefined,
    operationId: string,
    paymentId: string,
    request: object,
    key: string,
    work: (tx: Transaction, payment: PaymentRecord) => Promise<string>,
  ): Promise<StoredResponse<PaymentDocumentView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, ALLOCATE);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key, request: { paymentId, ...request } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<PaymentDocumentView>;
      const [payment] = await this.store.payments(tx, [paymentId], true);
      if (payment === undefined) throw new NotFoundError('no such payment');
      await this.authoriser.authorise(tx, actor, ALLOCATE, { branchId: payment.branchId });
      const [before] = await this.documentViews(tx, [payment]);
      const action = await work(tx, payment);
      const [after] = await this.documentViewsIn(tx, [paymentId]);
      await this.audit.record(tx, { module: 'pay', action, entityType: 'Payment', entityId: paymentId, branchId: payment.branchId, before: { ...before! }, after: { ...after! } });
      const response = { status: 200, body: after! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  async publishAllocation(
    tx: Transaction,
    payment: PaymentRecord,
    a: { readonly allocationId: string; readonly billingDocumentId: string; readonly applied: bigint; readonly unapplied: bigint; readonly reverses: string | null },
  ): Promise<void> {
    const payload: DepositAllocated = {
      allocationId: a.allocationId,
      paymentId: payment.id,
      billingDocumentId: a.billingDocumentId,
      branchId: payment.branchId,
      customerId: payment.customerId,
      appliedPesewas: json(a.applied),
      unappliedPesewas: json(a.unapplied),
      reversesAllocationId: a.reverses,
    };
    await this.events.publish(tx, { type: DEPOSIT_ALLOCATED, subjectType: 'Payment', subjectId: payment.id, branchId: payment.branchId, payload });
  }

  /** PAY's allocation cap (`ck_payment_allocation_cap`) as the contract's refusal. */
  async capped(field: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      const failure = databaseErrorOf(error);
      if (failure?.code === 'HK010' && failure.constraint === 'ck_payment_allocation_cap') throw new AllocationExceedsAvailableError(field);
      throw error;
    }
  }

  private async views(tx: Transaction, records: readonly PaymentRecord[]): Promise<PaymentView[]> {
    const allocations = await this.allocationsByPayment(tx, records);
    const linked = await this.store.linkedOrders(tx, records.map((r) => r.id));
    const methods = await this.refs.paymentMethodsIn(tx, records.map((r) => r.paymentMethodId));
    return records.map((r) => ({
      id: r.id,
      methodCode: methods.get(r.paymentMethodId)?.code ?? r.methodKind,
      methodKind: r.methodKind,
      status: r.status,
      verification: r.verification,
      amountPesewas: json(r.amountPesewas),
      allocatedPesewas: json(r.allocatedPesewas),
      unallocatedPesewas: json(unallocatedOf(r)),
      refundedPesewas: json(r.refundedPesewas),
      currency: 'GHS' as const,
      customerId: r.customerId,
      orderDocumentId: r.orderDocumentId ?? linked.get(r.id) ?? null,
      register: r.registerRef === null || r.registerCode === null ? null : { id: r.registerRef, code: r.registerCode },
      allocations: (allocations.get(r.id) ?? []).map((a) => ({ id: a.id, billingDocumentId: a.billingDocumentId, amountPesewas: json(a.amountPesewas), direction: a.direction })),
      receivedAt: r.receivedAt.toISOString(),
      clearedAt: r.clearedAt?.toISOString() ?? null,
      branchId: r.branchId,
    }));
  }

  private async documentViews(tx: Transaction, records: readonly PaymentRecord[]): Promise<PaymentDocumentView[]> {
    const allocations = await this.allocationsByPayment(tx, records);
    const methods = await this.refs.paymentMethodsIn(tx, records.map((r) => r.paymentMethodId));
    const customers = await this.refs.customersIn(tx, records.flatMap((r) => (r.customerId === null ? [] : [r.customerId])));
    const billed = await this.billing.settleableIn(tx, [...new Set([...allocations.values()].flat().map((a) => a.billingDocumentId))]);
    // A provider payment a counter sale took as its tender names that sale by its link (ADR-0079).
    const linked = await this.store.linkedOrders(tx, records.map((r) => r.id));
    const orderOf = (r: PaymentRecord): string | null => r.orderDocumentId ?? linked.get(r.id) ?? null;
    const orders = await this.documents.numberedRefs(tx, records.flatMap((r) => (orderOf(r) === null ? [] : [orderOf(r)!])));
    const banks = await this.bankAccounts.payoutAccountsIn(tx, records.flatMap((r) => (r.bankAccountId === null ? [] : [r.bankAccountId])));
    return records.map((r) => {
      const bank = r.bankAccountId === null ? undefined : banks.get(r.bankAccountId);
      const method = methods.get(r.paymentMethodId)!;
      const customer = r.customerId === null ? undefined : customers.get(r.customerId);
      return {
        id: r.id,
        paymentNo: null,
        status: r.status,
        method: { id: method.id, code: method.code, name: method.name, kind: method.kind },
        amountPesewas: json(r.amountPesewas),
        currency: 'GHS' as const,
        customer: customer === undefined ? null : { id: customer.id, publicId: customer.publicId, name: customer.name },
        order: orderOf(r) === null ? null : (orders.get(orderOf(r)!) ?? null),
        shiftId: r.shiftDocumentId,
        driver: null,
        bankAccount: bank === undefined ? null : { id: bank.id, name: bank.name, kind: bank.kind, last4: bank.last4 },
        provider: r.provider,
        providerReference: r.providerReference,
        externalReference: r.externalReference,
        payerPhoneMasked: r.payerPhoneMasked,
        verification: r.verification,
        chequeDueOn: r.chequeDueOn,
        allocatedPesewas: json(r.allocatedPesewas),
        unallocatedPesewas: json(unallocatedOf(r)),
        refundedPesewas: json(r.refundedPesewas),
        receivedAt: r.receivedAt.toISOString(),
        clearedAt: r.clearedAt?.toISOString() ?? null,
        reversesPaymentId: r.reversesPaymentId,
        failureReason: r.failureReason,
        allocations: (allocations.get(r.id) ?? []).map((a) => {
          const doc = billed.get(a.billingDocumentId);
          return {
            id: a.id,
            billingDocument: { id: a.billingDocumentId, docType: doc?.kind ?? 'INVOICE', number: doc?.documentNo ?? null },
            amountPesewas: json(a.amountPesewas),
            direction: a.direction,
            recordedAt: (a.recordedAt ?? r.receivedAt).toISOString(),
          };
        }),
        branchId: r.branchId,
      };
    });
  }

  private async allocationsByPayment(tx: Transaction, records: readonly PaymentRecord[]): Promise<Map<string, AllocationRecord[]>> {
    const byPayment = new Map<string, AllocationRecord[]>();
    for (const a of await this.store.allocationsOf(tx, records.map((r) => r.id))) byPayment.set(a.paymentId, [...(byPayment.get(a.paymentId) ?? []), a]);
    return byPayment;
  }
}
