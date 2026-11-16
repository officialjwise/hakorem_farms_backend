import { createUuidV7Generator, Money, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { IsolationLevelError, type Transaction } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { UnauthenticatedError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Billing } from '../../bil';
import type { MasterDataRefs } from '../../mdm';
import { clearingOf, planTender, type MethodKind } from '../domain/tender';
import type { PaymentCleared } from '../events';
import { PaymentInvalidError, PaymentRequiresVerificationError, type PaymentRule } from './errors';
import type { AllocationRecord, PaymentRecord, PaymentStore } from './payment-store';

export const PAYMENT_CLEARED = 'pay.PaymentCleared';
/** PAY's ◆ events (ADR-0056), declared for the ledger's boot assertion. */
export const PAY_LEDGER_EVENTS = [PAYMENT_CLEARED] as const;

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

/** The contract's `Payment`, as far as B9a answers it. */
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

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();

/**
 * Payments (FR-PAY-001, FR-PAY-002, FR-PAY-005, FR-PAY-009): a tender recorded in the caller's serializable
 * transaction through `recordIn`, the port ORD's sale posting calls (ADR-0010). Cash clears at once; a mobile money or
 * card payment is never recorded cleared from a caller's word (it clears only from the provider, abuse case 4). Each
 * allocation is a ledger row of PAY's, and BIL's settlement summary is moved through `Billing.settleIn`, so an
 * allocation beyond what a document has outstanding is refused by BIL's database rule. Clearing publishes ◆
 * `pay.PaymentCleared`, which the ledger posts in the same transaction. It authorises nothing: the selling command has.
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
    clock: Clock,
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
    };
    await this.events.publish(tx, { type: PAYMENT_CLEARED, subjectType: 'Payment', subjectId: id, branchId: request.branchId, payload, occurredAt: request.receivedAt });
    const [view] = await this.viewsIn(tx, [id]);
    await this.audit.record(tx, { module: 'pay', action: 'RECORD', entityType: 'Payment', entityId: id, branchId: request.branchId, before: null, after: { ...view! } });
    return view!;
  }

  /** Payments by id, as the contract shows them; unknown ids are absent. */
  async viewsIn(tx: Transaction, ids: readonly string[]): Promise<PaymentView[]> {
    if (ids.length === 0) return [];
    const records = await this.store.payments(tx, ids);
    return this.views(tx, records);
  }

  /** The payments taken for an order, oldest first. */
  async ofOrderIn(tx: Transaction, orderDocumentId: string): Promise<PaymentView[]> {
    return this.views(tx, await this.store.paymentsOfOrder(tx, orderDocumentId));
  }

  private async views(tx: Transaction, records: readonly PaymentRecord[]): Promise<PaymentView[]> {
    const allocations = await this.store.allocationsOf(tx, records.map((r) => r.id));
    const byPayment = new Map<string, AllocationRecord[]>();
    for (const a of allocations) byPayment.set(a.paymentId, [...(byPayment.get(a.paymentId) ?? []), a]);
    const methods = await this.methodCodes(tx, records);
    return records.map((r) => ({
      id: r.id,
      methodCode: methods.get(r.paymentMethodId) ?? r.methodKind,
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
      allocations: (byPayment.get(r.id) ?? []).map((a) => ({ id: a.id, billingDocumentId: a.billingDocumentId, amountPesewas: json(a.amountPesewas), direction: a.direction })),
      receivedAt: r.receivedAt.toISOString(),
      clearedAt: r.clearedAt?.toISOString() ?? null,
      branchId: r.branchId,
    }));
  }

  private async methodCodes(tx: Transaction, records: readonly PaymentRecord[]): Promise<Map<string, string>> {
    const methods = await this.refs.paymentMethodsIn(tx, records.map((r) => r.paymentMethodId));
    return new Map([...methods.values()].map((m) => [m.id, m.code] as const));
  }
}
