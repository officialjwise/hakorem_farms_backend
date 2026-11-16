import { createHash } from 'node:crypto';
import { createUuidV7Generator, Money, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { judgePayee } from '../domain/payout-details';
import { judgeAllocations, judgeFirstPaymentApprover, paymentApprovalReason, type AllocationRule } from '../domain/purchasing';
import { remittanceLines } from '../domain/remittance';
import type { SupplierPaymentMade, SupplierRemittanceReady } from '../events';
import {
  AllocationExceedsAvailableError,
  PayoutMakerCannotApproveError,
  PurReferenceNotFoundError,
  SupplierPaymentInvalidError,
  ThreeWayMatchFailedError,
  translatePurRefusal,
  wrongStatus,
  type BrokenRule,
} from './errors';
import { pesewas, principalRef, readPage, runPurchaseCommand, supplierRef, wholeBranches, type ApprovalPendingView, type Page } from './purchase-command';
import type { PaymentFilter, PaymentMethod, PaymentRecord, PaymentStatus, PurchasingStore, RemittanceRecord } from './purchasing-store';
import type { SupplierRegisterStore } from './supplier-register-store';

export const SUPPLIER_PAYMENT_KIND = 'SUPPLIER_PAYMENT';
const DOC_TYPE = 'SUPPLIER_PAYMENT';
const READ = 'pur.supplier_payment.read';
const CREATE = 'pur.supplier_payment.create';
const PAY = 'pur.supplier_payment.pay';
const WITHDRAWN = 'Approval request withdrawn by its maker';

export interface SupplierPaymentCreate {
  readonly supplierId: string;
  readonly method: PaymentMethod;
  readonly bankAccountId?: string | undefined;
  readonly scheduledFor?: string | undefined;
  readonly allocations: readonly { readonly supplierInvoiceId: string; readonly amountPesewas: number }[];
}

export interface SupplierPaymentMarkPaid {
  readonly paidAt: string;
  readonly externalReference: string;
}

/** The contract's `SupplierPayment`. */
export interface SupplierPaymentView {
  readonly id: string;
  readonly paymentNo: string | null;
  readonly status: PaymentStatus;
  readonly supplier: { readonly id: string; readonly supplierNo: string; readonly name: string };
  readonly method: PaymentMethod;
  /** Who the payment pays: the approved payout details in force when it was prepared, masked; null for cash and cheques. */
  readonly payeeDetailsMasked: string | null;
  readonly bankAccount: null;
  readonly amountPesewas: number;
  readonly currency: 'GHS';
  readonly scheduledFor: string | null;
  readonly paidAt: string | null;
  readonly externalReference: string | null;
  readonly approvalRequestId: string | null;
  readonly allocations: readonly { readonly supplierInvoiceId: string; readonly supplierInvoiceNo: string; readonly amountPesewas: number }[];
  readonly remittanceDocumentId: null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly displayName: string };
}

/** The contract's `SupplierRemittance` (FR-PUR-013): a paid payment's advice data, fixed once when it was paid. */
export interface SupplierRemittanceView {
  readonly id: string;
  readonly supplierPaymentId: string;
  readonly paymentNo: string | null;
  readonly supplier: { readonly id: string; readonly supplierNo: string; readonly name: string };
  readonly method: PaymentMethod;
  readonly payeeDetailsMasked: string | null;
  readonly amountPesewas: number;
  readonly currency: 'GHS';
  readonly paidAt: string;
  readonly externalReference: string;
  readonly lines: readonly {
    readonly supplierInvoiceId: string;
    readonly supplierInvoiceNo: string;
    readonly invoiceDate: string;
    readonly grossPesewas: number;
    readonly creditedPesewas: number;
    readonly amountPesewas: number;
    readonly outstandingAfterPesewas: number;
  }[];
  readonly remittanceDocumentId: null;
  readonly branchId: string;
  readonly recordedAt: string;
}

function paymentHash(payment: PaymentRecord): string {
  const payload = {
    supplierId: payment.supplierId,
    method: payment.method,
    amountPesewas: payment.amountPesewas.toString(),
    scheduledFor: payment.scheduledFor,
    allocations: payment.allocations.map((a) => [a.supplierInvoiceId, a.amountPesewas.toString()]),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** How a broken allocation rule is answered: a failed three-way match by its own code (FR-PUR-010). */
function refusal(rules: readonly { readonly index: number; readonly rule: AllocationRule }[]): Error {
  const field = (index: number) => (index < 0 ? '/allocations' : `/allocations/${index}/supplierInvoiceId`);
  const of = (kind: AllocationRule): BrokenRule[] => rules.filter((r) => r.rule === kind).map((r) => ({ field: field(r.index), rule: r.rule }));
  if (of('THREE_WAY_MATCH_FAILED').length > 0) return new ThreeWayMatchFailedError(of('THREE_WAY_MATCH_FAILED'));
  const exceeded = rules.filter((r) => r.rule === 'EXCEEDS_OUTSTANDING').map((r) => ({ field: `/allocations/${r.index}/amountPesewas`, rule: r.rule }));
  if (exceeded.length === rules.length) return new AllocationExceedsAvailableError(exceeded);
  return new SupplierPaymentInvalidError(rules.map((r) => ({ field: r.rule === 'EXCEEDS_OUTSTANDING' ? `/allocations/${r.index}/amountPesewas` : field(r.index), rule: r.rule })));
}

/**
 * Supplier payments (FR-PUR-010, FR-PUR-012, A-164): prepared as allocations to approved invoices that passed the
 * three-way match, never more than an invoice has left unpromised (the database refuses the rest too), submitted for
 * a different person's approval through IAM's SUPPLIER_PAYMENT kind (always, whatever the amount), and marked paid with
 * the method's reference, which publishes the ledger event for B8. Every handler authorises first, scoped to the
 * payment's branch; every change is audited.
 */
export class SupplierPayments implements ApprovalHandler {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: PurchasingStore,
    private readonly register: SupplierRegisterStore,
    private readonly refs: MasterDataRefs,
    private readonly approvals: Approvals,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly principals: PrincipalNames,
    readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filter: PaymentFilter, cursor: string | undefined, limit: number): Promise<Page<SupplierPaymentView>> {
    return this.uow.run({ isolation: 'read committed' }, (tx) =>
      readPage<PaymentRecord, SupplierPaymentView>(
        tx,
        { authoriser: this.authoriser, cursors: this.cursors },
        actor,
        READ,
        'listSupplierPayments',
        { status: filter.status ?? null, supplierId: filter.supplierId ?? null, scheduledBefore: filter.scheduledBefore ?? null },
        cursor,
        limit,
        (scopes, before, n) => this.store.listPayments(tx, filter, wholeBranches(scopes), before, n),
        (records) => this.views(tx, records),
      ),
    );
  }

  get(actor: Actor | undefined, id: string): Promise<SupplierPaymentView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.store.payment(tx, id);
      await this.authoriser.authorise(tx, actor, READ, record === null ? {} : { branchId: record.branchId });
      if (record === null) throw new NotFoundError(`no supplier payment ${id}`);
      return (await this.views(tx, [record]))[0]!;
    });
  }

  create(actor: Actor | undefined, body: SupplierPaymentCreate, idempotencyKey: string): Promise<StoredResponse<SupplierPaymentView>> {
    return runPurchaseCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      CREATE,
      'createSupplierPayment',
      body,
      idempotencyKey,
      async (tx) => {
        const first = body.allocations[0] === undefined ? null : await this.store.invoice(tx, body.allocations[0].supplierInvoiceId);
        return first === null ? {} : { branchId: first.branchId };
      },
      async (tx) => {
        if (body.bankAccountId !== undefined) throw new SupplierPaymentInvalidError([{ field: '/bankAccountId', rule: 'BANK_ACCOUNT_NOT_AVAILABLE' }]);
        if ((await this.refs.suppliersIn(tx, [body.supplierId])).get(body.supplierId) === undefined) throw new PurReferenceNotFoundError(['/supplierId']);
        const invoices = new Map((await this.store.invoices(tx, body.allocations.map((a) => a.supplierInvoiceId))).map((i) => [i.id, i] as const));
        const missing = body.allocations.flatMap((a, i) => (invoices.has(a.supplierInvoiceId) ? [] : [`/allocations/${i}/supplierInvoiceId`]));
        if (missing.length > 0) throw new PurReferenceNotFoundError(missing);
        const branches = new Set([...invoices.values()].map((i) => i.branchId));
        if (branches.size > 1) throw new SupplierPaymentInvalidError([{ field: '/allocations', rule: 'BRANCH_DIFFERS' }]);
        const promised = await this.store.promised(tx, [...invoices.keys()]);
        const credits = await this.store.liveCredits(tx, [...invoices.keys()]);
        const judged = judgeAllocations(
          body.supplierId,
          body.allocations.map((a) => {
            const invoice = invoices.get(a.supplierInvoiceId)!;
            return {
              invoiceId: a.supplierInvoiceId,
              amount: Money.ofPesewas(BigInt(a.amountPesewas)),
              invoice: {
                supplierId: invoice.supplierId,
                kind: invoice.kind,
                status: invoice.status,
                matchStatus: invoice.matchStatus,
                grossPesewas: invoice.grossPesewas,
                promisedPesewas: promised.get(invoice.id) ?? 0n,
                liveCreditsPesewas: credits.get(invoice.id) ?? 0n,
              },
            };
          }),
        );
        if (!judged.ok) throw refusal(judged.error);
        const payee = await this.payee(tx, body.supplierId, body.method);
        const branchId = [...branches][0]!;
        const id = this.nextId();
        await this.documents.register(tx, { id, docType: DOC_TYPE, ownerModule: 'pur', branchId, actorId: actor!.principalId });
        await this.store.insertPayment(
          tx,
          id,
          { supplierId: body.supplierId, method: body.method, amountPesewas: judged.value.pesewas, scheduledFor: body.scheduledFor ?? null, branchId, payoutChangeId: payee },
          body.allocations.map((a) => ({ id: this.nextId(), supplierInvoiceId: a.supplierInvoiceId, amountPesewas: BigInt(a.amountPesewas) })),
          actor!.principalId,
        );
        const view = await this.view(tx, id);
        await this.audit.record(tx, { module: 'pur', action: 'CREATE', entityType: 'SupplierPayment', entityId: id, branchId, before: null, after: { ...view } });
        return { status: 201, body: view };
      },
    ).catch(translatePurRefusal);
  }

  submit(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<ApprovalPendingView>> {
    return this.write(actor, CREATE, 'submitSupplierPayment', id, {}, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, ['DRAFT']);
      const supplier = (await this.refs.suppliersIn(tx, [before.supplierId])).get(before.supplierId)!;
      // Every payment waits for a second person (FR-PUR-012, ck_supplier_payment_approval): the policy is the floor. The
      // first payment since the supplier's payout details changed does whatever the amount (owner, 2026-11-15, A-170).
      const policy = await this.approvals.judgeIn(tx, SUPPLIER_PAYMENT_KIND, before.branchId, before.amountPesewas);
      const reason = paymentApprovalReason(before.payoutFirstUse, policy.required) ?? 'PAYMENT_POLICY';
      const first = reason === 'FIRST_PAYMENT_AFTER_PAYOUT_CHANGE' ? 'First payment since the payout details changed: ' : '';
      const summary = `${first}Pay ${supplier.name} ${before.amountPesewas} pesewas by ${before.method} against ${before.allocations.length} invoice(s)`;
      const request = await this.approvals.request(tx, actor, {
        kind: SUPPLIER_PAYMENT_KIND,
        branchId: before.branchId,
        subjectDocumentId: id,
        payloadHash: paymentHash(before),
        amountPesewas: before.amountPesewas,
        summary,
      });
      await this.store.markPaymentPending(tx, id, request.id, actor!.principalId);
      await this.audited(tx, 'SUBMIT', before, { approvalRequestId: request.id, approvalReason: reason });
      return {
        status: 202,
        body: { status: 'PENDING_APPROVAL', approvalRequestId: request.id, kind: SUPPLIER_PAYMENT_KIND, subject: { id, docType: DOC_TYPE, number: null }, summary, requestedAt: request.requestedAt.toISOString() },
      };
    });
  }

  markPaid(actor: Actor | undefined, id: string, body: SupplierPaymentMarkPaid, idempotencyKey: string): Promise<StoredResponse<SupplierPaymentView>> {
    return this.write(actor, PAY, 'markSupplierPaymentPaid', id, body, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, ['APPROVED']);
      const paidAt = new Date(body.paidAt);
      await this.store.markPaymentPaid(tx, id, paidAt, body.externalReference.trim(), this.clock.now(), actor!.principalId);
      const view = await this.audited(tx, 'PAY', before);
      await this.recordRemittance(tx, actor!.principalId, id);
      await this.events.publish<SupplierPaymentMade>(tx, {
        type: 'pur.SupplierPaymentMade',
        subjectType: 'SupplierPayment',
        subjectId: id,
        branchId: before.branchId,
        occurredAt: paidAt,
        payload: {
          supplierPaymentId: id,
          supplierId: before.supplierId,
          method: before.method,
          amountPesewas: pesewas(before.amountPesewas),
          paidAt: paidAt.toISOString(),
          approvalRequestId: before.approvalRequestId!,
          allocations: before.allocations.map((a) => ({ supplierInvoiceId: a.supplierInvoiceId, amountPesewas: pesewas(a.amountPesewas) })),
        },
      });
      return { status: 200, body: view };
    });
  }

  cancel(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<SupplierPaymentView>> {
    return this.write(actor, CREATE, 'cancelSupplierPayment', id, { reason }, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, ['DRAFT', 'APPROVED']);
      await this.store.markPaymentDecided(tx, id, 'CANCELLED', reason, actor!.principalId);
      return { status: 200, body: await this.audited(tx, 'CANCEL', before, { reason }) };
    });
  }

  /**
   * `getSupplierPaymentRemittance` (FR-PUR-013): the remittance advice data of a paid payment, as fixed when it was
   * paid. A payment not yet paid has none (404).
   */
  remittance(actor: Actor | undefined, id: string): Promise<SupplierRemittanceView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const payment = await this.store.payment(tx, id);
      await this.authoriser.authorise(tx, actor, READ, payment === null ? {} : { branchId: payment.branchId });
      const record = payment === null ? null : await this.store.remittance(tx, id);
      if (payment === null || record === null) throw new NotFoundError(`no remittance advice for supplier payment ${id}`);
      return this.remittanceView(tx, payment, record);
    });
  }

  /**
   * The remittance advice data, written once in the transaction that marks the payment paid (FR-PUR-013, A-174): the
   * invoices it pays as they stand now, with what is left on each. `uq_supplier_remittance_payment` holds it to one per
   * payment, and `pur.SupplierRemittanceReady` is published once, for DOC to render (B8) and NTF to send (B11).
   */
  private async recordRemittance(tx: Transaction, actorId: string, paymentId: string): Promise<void> {
    const payment = (await this.store.payment(tx, paymentId))!;
    const invoices = new Map((await this.store.invoices(tx, payment.allocations.map((a) => a.supplierInvoiceId))).map((i) => [i.id, i] as const));
    const lines = remittanceLines(
      payment.amountPesewas,
      payment.allocations.map((a) => {
        const invoice = invoices.get(a.supplierInvoiceId)!;
        return {
          supplierInvoiceId: invoice.id,
          supplierInvoiceNo: invoice.supplierInvoiceNo,
          invoiceDate: invoice.invoiceDate,
          grossPesewas: invoice.grossPesewas,
          creditedPesewas: invoice.creditedPesewas,
          paidAfterPesewas: invoice.paidPesewas,
          amountPesewas: a.amountPesewas,
        };
      }),
    );
    if (!lines.ok) throw new Error(`supplier payment ${paymentId}: its allocations do not make a remittance advice (${lines.error})`);
    const id = this.nextId();
    await this.store.insertRemittance(
      tx,
      {
        id,
        supplierPaymentId: payment.id,
        supplierId: payment.supplierId,
        method: payment.method,
        payeeMasked: payment.payeeMasked,
        amountPesewas: payment.amountPesewas,
        paidAt: payment.paidAt!,
        externalReference: payment.externalReference!,
        branchId: payment.branchId,
        lines: lines.value,
      },
      actorId,
    );
    await this.events.publish<SupplierRemittanceReady>(tx, {
      type: 'pur.SupplierRemittanceReady',
      subjectType: 'SupplierPayment',
      subjectId: payment.id,
      branchId: payment.branchId,
      payload: {
        remittanceId: id,
        supplierPaymentId: payment.id,
        supplierId: payment.supplierId,
        amountPesewas: pesewas(payment.amountPesewas),
        paidAt: payment.paidAt!.toISOString(),
        externalReference: payment.externalReference!,
      },
    });
  }

  private async remittanceView(tx: Transaction, payment: PaymentRecord, record: RemittanceRecord): Promise<SupplierRemittanceView> {
    const supplier = (await this.refs.suppliersIn(tx, [record.supplierId])).get(record.supplierId)!;
    return {
      id: record.id,
      supplierPaymentId: record.supplierPaymentId,
      paymentNo: payment.paymentNo,
      supplier: supplierRef(supplier),
      method: record.method,
      payeeDetailsMasked: record.payeeMasked,
      amountPesewas: pesewas(record.amountPesewas),
      currency: 'GHS',
      paidAt: record.paidAt.toISOString(),
      externalReference: record.externalReference,
      lines: record.lines.map((l) => ({
        supplierInvoiceId: l.supplierInvoiceId,
        supplierInvoiceNo: l.supplierInvoiceNo,
        invoiceDate: l.invoiceDate,
        grossPesewas: pesewas(l.grossPesewas),
        creditedPesewas: pesewas(l.creditedPesewas),
        amountPesewas: pesewas(l.amountPesewas),
        outstandingAfterPesewas: pesewas(l.outstandingAfterPesewas),
      })),
      remittanceDocumentId: null,
      branchId: record.branchId,
      recordedAt: record.recordedAt.toISOString(),
    };
  }

  /** ApprovalHandler: the payment as it is now; a change since the request voids the approval. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const payment = await this.store.payment(tx, subjectDocumentId);
    if (payment === null) throw new NotFoundError(`no supplier payment ${subjectDocumentId}`);
    return paymentHash(payment);
  }

  /** ApprovalHandler: approves the payment in the approval's transaction; marking it paid is a separate step. */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const before = await this.locked(tx, request.subjectDocumentId, ['PENDING_APPROVAL']);
    // The person who made the payout change this payment is the first to use never approves it (owner, A-171).
    const change = before.payoutFirstUseChangeId === null ? null : await this.register.payoutChange(tx, before.payoutFirstUseChangeId, false);
    if (!judgeFirstPaymentApprover({ changeMakerId: change?.createdBy ?? null, approverId: request.decidedBy! }).ok) throw new PayoutMakerCannotApproveError();
    await this.store.markPaymentDecided(tx, before.id, 'APPROVED', null, request.decidedBy!);
    await this.audited(tx, 'APPROVE', before, { approvalRequestId: request.id });
  }

  /** ApprovalHandler: a refused payment is REJECTED; one its maker withdrew is CANCELLED. Either frees its invoices. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const before = await this.locked(tx, request.subjectDocumentId, ['PENDING_APPROVAL']);
    const withdrawn = request.status === 'CANCELLED';
    await this.store.markPaymentDecided(tx, before.id, withdrawn ? 'CANCELLED' : 'REJECTED', withdrawn ? WITHDRAWN : null, request.decidedBy ?? request.requestedBy);
    await this.audited(tx, withdrawn ? 'CANCEL' : 'REJECT', before, { approvalRequestId: request.id });
  }

  async views(tx: Transaction, records: readonly PaymentRecord[]): Promise<SupplierPaymentView[]> {
    const suppliers = await this.refs.suppliersIn(tx, records.map((r) => r.supplierId));
    const names = await this.principals.refs(tx, records.map((r) => r.createdBy));
    return records.map((r) => ({
      id: r.id,
      paymentNo: r.paymentNo,
      status: r.status,
      supplier: supplierRef(suppliers.get(r.supplierId)!),
      method: r.method,
      payeeDetailsMasked: r.payeeMasked,
      bankAccount: null,
      amountPesewas: pesewas(r.amountPesewas),
      currency: 'GHS' as const,
      scheduledFor: r.scheduledFor,
      paidAt: r.paidAt === null ? null : r.paidAt.toISOString(),
      externalReference: r.externalReference,
      approvalRequestId: r.approvalRequestId,
      allocations: r.allocations.map((a) => ({ supplierInvoiceId: a.supplierInvoiceId, supplierInvoiceNo: a.supplierInvoiceNo, amountPesewas: pesewas(a.amountPesewas) })),
      remittanceDocumentId: null,
      branchId: r.branchId,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      createdBy: principalRef(names, r.createdBy),
    }));
  }

  private write<T>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    id: string,
    body: object,
    idempotencyKey: string,
    work: (tx: Transaction) => Promise<StoredResponse<T>>,
  ): Promise<StoredResponse<T>> {
    return runPurchaseCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      permission,
      operationId,
      { id, ...body },
      idempotencyKey,
      async (tx) => {
        const record = await this.store.payment(tx, id);
        return record === null ? {} : { branchId: record.branchId };
      },
      work,
    ).catch(translatePurRefusal);
  }

  /**
   * The payout details a payment pays (FR-PUR-002): for a bank transfer or a wallet payment, the supplier's approved
   * details of that method in force now. A change still waiting for approval is never used.
   */
  private async payee(tx: Transaction, supplierId: string, method: PaymentMethod): Promise<string | null> {
    const profile = await this.register.profile(tx, supplierId, true);
    const inForce = profile?.payoutChangeId == null ? null : await this.register.payoutChange(tx, profile.payoutChangeId, false);
    const judged = judgePayee(method, inForce === null ? null : { id: inForce.id, method: inForce.method });
    if (!judged.ok) throw new SupplierPaymentInvalidError([{ field: '/method', rule: judged.error }]);
    return judged.value;
  }

  private async locked(tx: Transaction, id: string, allowed: readonly PaymentStatus[]): Promise<PaymentRecord> {
    const payment = await this.store.lockPayment(tx, id);
    if (payment === null) throw new NotFoundError(`no supplier payment ${id}`);
    if (!allowed.includes(payment.status)) throw wrongStatus(`supplier payment ${id}`, payment.status);
    return payment;
  }

  private async view(tx: Transaction, id: string): Promise<SupplierPaymentView> {
    return (await this.views(tx, [(await this.store.payment(tx, id))!]))[0]!;
  }

  private async audited(tx: Transaction, action: string, before: PaymentRecord, metadata: Record<string, unknown> = {}): Promise<SupplierPaymentView> {
    const beforeView = (await this.views(tx, [before]))[0]!;
    const view = await this.view(tx, before.id);
    await this.audit.record(tx, {
      module: 'pur',
      action,
      entityType: 'SupplierPayment',
      entityId: before.id,
      branchId: before.branchId,
      before: { ...beforeView },
      after: { ...view },
      metadata: JSON.parse(JSON.stringify(metadata)),
    });
    return view;
  }
}
