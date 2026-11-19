import { createHash } from 'node:crypto';
import { createUuidV7Generator, formatCedis, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { AsyncConsumer, DomainEvents } from '../../../platform/events/domain-events';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Billing } from '../../bil';
import type { Journals } from '../../fin';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { DEPOSIT_ALLOCATED, PAYMENT_CLEARED } from '../../pay';
import { judgeWriteOff } from '../domain/write-off';
import type { BadDebtStore, WriteOffRequestRecord } from './bad-debt-store';
import type { ApprovalPendingView } from './business-accounts';
import { AskerCannotApproveError, BadDebtWriteOffInvalidError } from './errors';

const WRITE_OFF = 'whl.bad_debt.write_off';
export const BAD_DEBT_WRITE_OFF = 'BAD_DEBT_WRITE_OFF';
export const BAD_DEBT_WRITE_OFF_KIND = 'BAD_DEBT_WRITE_OFF';
/** ◆ WHL's ledger event (ADR-0003): FIN posts Dr 6940, Cr 1200 against the customer, in the approving transaction. */
export const BAD_DEBT_WRITTEN_OFF = 'whl.BadDebtWrittenOff';
/**
 * Money received from a customer after a debt of theirs was written off (ADR-0090, A-321 (f)): raised for the daily
 * exception report (B12) as its own source kind. No recovery is posted; the owner decides the rule (BL-091).
 */
export const WRITTEN_OFF_CUSTOMER_PAID = 'whl.WrittenOffCustomerPaid';

/** `whl.BadDebtWrittenOff` v1. */
export interface BadDebtWrittenOff {
  readonly writeOffId: string;
  readonly customerId: string;
  readonly billingDocumentId: string;
  readonly documentNo: string | null;
  readonly branchId: string;
  readonly amountPesewas: number;
  readonly reason: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly writtenOffOn: string;
}

/** `whl.WrittenOffCustomerPaid` v1: for the exception report's source (B12). */
export interface WrittenOffCustomerPaid {
  readonly customerId: string;
  readonly paymentId: string | null;
  readonly sourceEventType: string;
  readonly amountPesewas: number | null;
  readonly writtenOffPesewas: number;
}

export interface WriteOffRequest {
  readonly billingDocumentId: string;
  readonly amountPesewas: bigint;
  readonly reason: string;
}

const requestHash = (r: { readonly id: string; readonly billingDocumentId: string; readonly customerId: string; readonly amountPesewas: bigint }) =>
  createHash('sha256')
    .update(canonicalJson({ id: r.id, billingDocumentId: r.billingDocumentId, customerId: r.customerId, amountPesewas: r.amountPesewas.toString() }), 'utf8')
    .digest('hex');

/**
 * The bad-debt write-off (FR-WHL-012, ADR-0090, A-321): the Accountant asks for an unrecoverable open item, all of it or
 * part, to be written off with a reason; nothing moves until the Owner, never the person who asked, approves it with
 * step-up (IAM's `BAD_DEBT_WRITE_OFF` approval, held by the database as well: `ck_bad_debt_write_off_request_checker`,
 * `ck_bad_debt_write_off_checker`, `whl.bad_debt_write_off_check`). On approval, in one transaction: BIL's summary of the
 * document takes the amount off what is outstanding (`Billing.writeOffIn`; the invoice itself is never edited), ◆
 * `whl.BadDebtWrittenOff` posts Dr 6940 Cr 1200 against the customer through FIN, and the insert-only write-off records
 * the journal that posted it. The ageing then shows the item closed (by the day it was written off).
 */
export class BadDebts {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: BadDebtStore,
    private readonly billing: Billing,
    private readonly journals: Journals,
    private readonly refs: MasterDataRefs,
    private readonly registry: DocumentRegistry,
    private readonly approvals: Approvals,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** writeOffBadDebt: 202 with the approval it waits for. A document the caller cannot write off at its branch is not found. Replayed by its key. */
  writeOff(actor: Actor | undefined, request: WriteOffRequest, key: string): Promise<StoredResponse<ApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, WRITE_OFF);
      const claim = await this.idempotency.claim(tx, { operationId: 'writeOffBadDebt', principalId: actor!.principalId, key, request: { ...request, amountPesewas: request.amountPesewas.toString() } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ApprovalPendingView>;
      const facts = (await this.billing.settleableIn(tx, [request.billingDocumentId])).get(request.billingDocumentId);
      const branches = new Set((await this.authoriser.scopes(tx, actor!, WRITE_OFF)).filter((s) => s.locationId === null).map((s) => s.branchId));
      if (facts === undefined || !branches.has(facts.branchId)) throw new NotFoundError(`no billing document ${request.billingDocumentId}`);
      await this.authoriser.authorise(tx, actor, WRITE_OFF, { branchId: facts.branchId });
      const amount = Money.ofPesewas(request.amountPesewas);
      const broken = judgeWriteOff({ kind: facts.kind, status: facts.status, customerId: facts.customerId, outstanding: Money.ofPesewas(facts.outstandingPesewas) }, amount);
      if (broken.length > 0) throw new BadDebtWriteOffInvalidError(broken);
      if ((await this.store.pendingFor(tx, request.billingDocumentId)) !== null) throw new BadDebtWriteOffInvalidError([{ field: '/billingDocumentId', rule: 'APPROVAL_PENDING' }]);

      const customerId = facts.customerId!;
      const customer = (await this.refs.customersIn(tx, [customerId])).get(customerId);
      const id = this.nextId();
      const at = this.clock.now();
      const summary = `Write off ${formatCedis(amount.pesewas)} of ${facts.documentNo ?? 'a document'} owed by ${customer?.name ?? 'a customer'} as bad debt. Reason: ${request.reason}`;
      await this.registry.register(tx, { id, docType: BAD_DEBT_WRITE_OFF, ownerModule: 'whl', branchId: facts.branchId, actorId: actor!.principalId });
      const approval = await this.approvals.request(tx, actor!, {
        kind: BAD_DEBT_WRITE_OFF_KIND,
        branchId: facts.branchId,
        subjectDocumentId: id,
        payloadHash: requestHash({ id, billingDocumentId: request.billingDocumentId, customerId, amountPesewas: amount.pesewas }),
        amountPesewas: amount.pesewas,
        summary,
      });
      await this.store.insertRequest(tx, {
        id,
        customerId,
        billingDocumentId: request.billingDocumentId,
        branchId: facts.branchId,
        amountPesewas: amount.pesewas,
        reason: request.reason,
        approvalRequestId: approval.id,
        status: 'PENDING_APPROVAL',
        createdBy: actor!.principalId,
        createdAt: at,
      });
      await this.audit.record(tx, {
        module: 'whl',
        action: 'ASK_WRITE_OFF',
        entityType: 'BadDebtWriteOff',
        entityId: id,
        branchId: facts.branchId,
        before: null,
        after: { billingDocumentId: request.billingDocumentId, customerId, amountPesewas: amount.toJsonInteger(), reason: request.reason, approvalRequestId: approval.id },
      });
      const response: StoredResponse<ApprovalPendingView> = {
        status: 202,
        body: { status: 'PENDING_APPROVAL', approvalRequestId: approval.id, kind: BAD_DEBT_WRITE_OFF_KIND, subject: { id, docType: BAD_DEBT_WRITE_OFF, number: null }, summary, requestedAt: approval.requestedAt.toISOString() },
      };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** IAM's `BAD_DEBT_WRITE_OFF` handler: the write-off applied, posted and linked to its journal on approval. */
  readonly approvalHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, id) => {
      const request = await this.store.request(tx, id);
      if (request === null) throw new NotFoundError(`no write-off ${id}`);
      return requestHash(request);
    },
    onApproved: async (tx: Transaction, approval: ApprovalRecord) => {
      const request = await this.store.requestByApproval(tx, approval.id);
      if (request === null || request.status !== 'PENDING_APPROVAL') throw new NotFoundError(`no write-off waiting under approval ${approval.id}`);
      // ADR-0017 here as well as in IAM and the database: the maker never checks.
      if (approval.decidedBy === null || approval.decidedBy === request.createdBy) throw new AskerCannotApproveError('the person who asked for this write-off cannot approve it');
      await this.applyIn(tx, request, approval.decidedBy);
    },
    onRejected: async (tx: Transaction, approval: ApprovalRecord) => {
      const request = await this.store.requestByApproval(tx, approval.id);
      if (request === null || request.status !== 'PENDING_APPROVAL') return;
      await this.store.decide(tx, request.id, { status: approval.status === 'CANCELLED' ? 'CANCELLED' : 'REJECTED', by: approval.decidedBy ?? approval.requestedBy, at: this.clock.now() });
    },
  };

  /**
   * WHL's consumer of PAY's payments (A-321 (f)): money from a customer who has had a debt written off is raised for
   * the exception report, once per payment event. It is never posted as a recovery, and it never blocks the payment:
   * the database already refuses any allocation onto the amount written off.
   */
  readonly recoveries: AsyncConsumer = {
    name: 'whl.written-off-customer-paid',
    eventTypes: [PAYMENT_CLEARED, DEPOSIT_ALLOCATED],
    isolation: 'serializable',
    handle: async (tx, event) => {
      const payload = event.payload as { readonly customerId?: string | null; readonly paymentId?: string | null; readonly amountPesewas?: number; readonly appliedPesewas?: number; readonly branchId?: string | null };
      const customerId = payload.customerId ?? null;
      if (customerId === null) return;
      const writtenOff = await this.store.writtenOffFor(tx, customerId);
      if (writtenOff === 0n) return;
      const raised: WrittenOffCustomerPaid = {
        customerId,
        paymentId: payload.paymentId ?? null,
        sourceEventType: event.type,
        amountPesewas: payload.amountPesewas ?? payload.appliedPesewas ?? null,
        writtenOffPesewas: Money.ofPesewas(writtenOff).toJsonInteger(),
      };
      await this.events.publish(tx, { type: WRITTEN_OFF_CUSTOMER_PAID, subjectType: 'Customer', subjectId: customerId, branchId: event.branchId ?? payload.branchId ?? null, payload: { ...raised } });
    },
  };

  private async applyIn(tx: Transaction, request: WriteOffRequestRecord, approvedBy: string): Promise<void> {
    const at = this.clock.now();
    const writtenOffOn = toBusinessDate(at);
    await this.billing.writeOffIn(tx, request.billingDocumentId, request.amountPesewas);
    await this.store.decide(tx, request.id, { status: 'APPLIED', by: approvedBy, at });
    const documentNo = (await this.registry.numberedRefs(tx, [request.billingDocumentId])).get(request.billingDocumentId)?.number ?? null;
    const payload: BadDebtWrittenOff = {
      writeOffId: request.id,
      customerId: request.customerId,
      billingDocumentId: request.billingDocumentId,
      documentNo,
      branchId: request.branchId,
      amountPesewas: Money.ofPesewas(request.amountPesewas).toJsonInteger(),
      reason: request.reason,
      requestedBy: request.createdBy,
      approvedBy,
      writtenOffOn,
    };
    await this.events.publish(tx, { type: BAD_DEBT_WRITTEN_OFF, subjectType: 'BadDebtWriteOff', subjectId: request.id, branchId: request.branchId, payload: { ...payload }, occurredAt: at });
    const entry = await this.journals.entryForSubjectIn(tx, BAD_DEBT_WRITTEN_OFF, request.id);
    if (entry === null) throw new Error(`write-off ${request.id}: the ledger posted no entry`);
    await this.store.insertWriteOff(
      tx,
      {
        id: request.id,
        customerId: request.customerId,
        billingDocumentId: request.billingDocumentId,
        branchId: request.branchId,
        amountPesewas: request.amountPesewas,
        writtenOffOn,
        journalEntryId: entry.id,
        requestedBy: request.createdBy,
        approvedBy,
        recordedAt: at,
      },
      approvedBy,
    );
    await this.audit.record(tx, {
      module: 'whl',
      action: 'WRITE_OFF',
      entityType: 'BadDebtWriteOff',
      entityId: request.id,
      branchId: request.branchId,
      before: null,
      after: { ...payload, journalEntryId: entry.id, journalEntryNo: entry.entryNo },
    });
  }
}
