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
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { clearingOf, planTender, type MethodKind } from '../domain/tender';
import { pageProbe } from '../domain/time';
import type { DepositAllocated, PaymentCleared } from '../events';
import { AllocationExceedsAvailableError, PaymentInvalidError, PaymentRequiresVerificationError, type PaymentRule } from './errors';
import type { AllocationRecord, PaymentFilter, PaymentRecord, PaymentStatus, PaymentStore } from './payment-store';

export const PAYMENT_CLEARED = 'pay.PaymentCleared';
export const DEPOSIT_ALLOCATED = 'pay.DepositAllocated';
export const REFUND_PAID = 'pay.RefundPaid';
/** PAY's ◆ events (ADR-0056), declared for the ledger's boot assertion. */
export const PAY_LEDGER_EVENTS = [PAYMENT_CLEARED, DEPOSIT_ALLOCATED, REFUND_PAID] as const;

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
  readonly customer: { readonly id: string; readonly customerNo: string; readonly name: string } | null;
  readonly order: DocumentRefView | null;
  readonly shiftId: string | null;
  readonly driver: null;
  readonly bankAccount: null;
  readonly provider: string | null;
  readonly providerReference: string | null;
  readonly externalReference: string | null;
  readonly payerPhoneMasked: string | null;
  readonly verification: PaymentRecord['verification'];
  readonly chequeDueOn: null;
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
  ) {
    this.nextId = createUuidV7Generator(clock);
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
    const plan = planTender(
      Money.ofPesewas(request.amountPesewas),
      request.allocations.map((a) => Money.ofPesewas(a.amountPesewas)),
    );
    if (!plan.ok) broken.push({ field: `${field}/amountPesewas`, rule: plan.error });
    if (broken.length > 0 || !plan.ok) throw new PaymentInvalidError(broken);

    const id = this.nextId();
    await this.documents.register(tx, { id, docType: 'PAYMENT', ownerModule: 'pay', branchId: request.branchId, actorId: actor.principalId });
    await this.store.insert(tx, {
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
    });
    for (const allocation of request.allocations) {
      await this.store.allocate(tx, { id: this.nextId(), paymentId: id, billingDocumentId: allocation.billingDocumentId, amountPesewas: allocation.amountPesewas, direction: 'APPLY', actorId: actor.principalId });
      await this.billing.settleIn(tx, allocation.billingDocumentId, allocation.amountPesewas, 'APPLY');
    }
    const payload: PaymentCleared = {
      paymentId: id,
      branchId: request.branchId,
      methodKind: method.kind,
      amountPesewas: json(request.amountPesewas),
      allocatedPesewas: plan.value.allocated.toJsonInteger(),
      unallocatedPesewas: plan.value.unallocated.toJsonInteger(),
      customerId: request.customerId,
      orderDocumentId: request.orderDocumentId,
      register: request.register,
      allocations: request.allocations.map((a) => ({ billingDocumentId: a.billingDocumentId, amountPesewas: json(a.amountPesewas) })),
      receivedAt: request.receivedAt.toISOString(),
      provider: null,
      heldAsUnmatched: false,
    };
    await this.events.publish(tx, { type: PAYMENT_CLEARED, subjectType: 'Payment', subjectId: id, branchId: request.branchId, payload, occurredAt: request.receivedAt });
    const [view] = await this.viewsIn(tx, [id]);
    await this.audit.record(tx, { module: 'pay', action: 'RECORD', entityType: 'Payment', entityId: id, branchId: request.branchId, before: null, after: { ...view! } });
    return view!;
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
      const documents = await this.billing.settleableIn(tx, body.allocations.map((a) => a.billingDocumentId));
      const seen = new Set<string>();
      body.allocations.forEach((a, i) => {
        const doc = documents.get(a.billingDocumentId);
        const at = `/allocations/${i}`;
        if (a.amountPesewas <= 0n) broken.push({ field: `${at}/amountPesewas`, rule: 'ALLOCATION_NOT_POSITIVE' });
        if (seen.has(a.billingDocumentId)) broken.push({ field: `${at}/billingDocumentId`, rule: 'DUPLICATE_DOCUMENT' });
        seen.add(a.billingDocumentId);
        if (doc === undefined) broken.push({ field: `${at}/billingDocumentId`, rule: 'DOCUMENT_UNKNOWN' });
        else {
          if (!SETTLEABLE_KINDS.has(doc.kind) || doc.status !== 'ISSUED') broken.push({ field: `${at}/billingDocumentId`, rule: 'DOCUMENT_NOT_PAYABLE' });
          if (doc.branchId !== payment.branchId) broken.push({ field: `${at}/billingDocumentId`, rule: 'BRANCH_DIFFERS' });
          if (doc.customerId !== payment.customerId) broken.push({ field: `${at}/billingDocumentId`, rule: 'CUSTOMER_DIFFERS' });
        }
      });
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

  private async publishAllocation(
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
  private async capped(field: string, write: () => Promise<void>): Promise<void> {
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
    const methods = await this.refs.paymentMethodsIn(tx, records.map((r) => r.paymentMethodId));
    return records.map((r) => ({
      id: r.id,
      methodCode: methods.get(r.paymentMethodId)?.code ?? r.methodKind,
      methodKind: r.methodKind,
      status: r.status,
      verification: r.verification,
      amountPesewas: json(r.amountPesewas),
      allocatedPesewas: json(r.allocatedPesewas),
      unallocatedPesewas: json(r.amountPesewas - r.allocatedPesewas - r.refundedPesewas),
      refundedPesewas: json(r.refundedPesewas),
      currency: 'GHS' as const,
      customerId: r.customerId,
      orderDocumentId: r.orderDocumentId,
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
    const orders = await this.documents.numberedRefs(tx, records.flatMap((r) => (r.orderDocumentId === null ? [] : [r.orderDocumentId])));
    return records.map((r) => {
      const method = methods.get(r.paymentMethodId)!;
      const customer = r.customerId === null ? undefined : customers.get(r.customerId);
      return {
        id: r.id,
        paymentNo: null,
        status: r.status,
        method: { id: method.id, code: method.code, name: method.name, kind: method.kind },
        amountPesewas: json(r.amountPesewas),
        currency: 'GHS' as const,
        customer: customer === undefined ? null : { id: customer.id, customerNo: customer.customerNo, name: customer.name },
        order: r.orderDocumentId === null ? null : (orders.get(r.orderDocumentId) ?? null),
        shiftId: r.shiftDocumentId,
        driver: null,
        bankAccount: null,
        provider: r.provider,
        providerReference: r.providerReference,
        externalReference: r.externalReference,
        payerPhoneMasked: r.payerPhoneMasked,
        verification: r.verification,
        chequeDueOn: null,
        allocatedPesewas: json(r.allocatedPesewas),
        unallocatedPesewas: json(r.amountPesewas - r.allocatedPesewas - r.refundedPesewas),
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
