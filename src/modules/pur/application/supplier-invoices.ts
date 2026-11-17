import { createHash } from 'node:crypto';
import { createUuidV7Generator, Money, Quantity, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { FileStore } from '../../../platform/storage/file-store';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames } from '../../iam';
import type { Stock } from '../../inv';
import type { MasterDataRefs, ProductFacts, TaxService } from '../../mdm';
import { invoicePayable, judgeCreditNote, judgeCreditTarget } from '../domain/credit-note';
import { orderLineNet } from '../domain/purchasing';
import { judgeVarianceApprover, judgeVarianceLines } from '../domain/variance';
import { claimedPart, judgeClaimCredit, judgeClaimCreditApprover, receivedPartValue } from '../domain/claim';
import { matchInvoice, matchLine, type MatchReason, type MatchStatus } from '../domain/three-way-match';
import { dueDateFrom } from '../domain/terms';
import type { SupplierCreditNoteApproved, SupplierInvoiceApproved, SupplierInvoiceMismatched } from '../events';
import {
  ApprovalPendingError,
  CreditNoteExceedsInvoiceError,
  DuplicateSupplierInvoiceError,
  InvoiceMakerCannotApproveError,
  PurReferenceNotFoundError,
  SupplierClaimInvalidError,
  SupplierInvoiceInvalidError,
  ThreeWayMatchFailedError,
  translatePurRefusal,
  VarianceNotAllowedError,
  wrongStatus,
  type BrokenRule,
} from './errors';
import { lineNumber, pesewas, principalRef, productRef, readPage, runPurchaseCommand, supplierRef, wholeBranches, type ApprovalPendingView, type Page } from './purchase-command';
import type { SupplierRegisterStore } from './supplier-register-store';
import type { ClaimRecord, SupplierClaimStore } from './supplier-claim-store';
import type { InvoiceFilter, InvoiceHeader, InvoiceLineRecord, InvoiceMatchStatus, InvoiceRecord, InvoiceStatus, LineMatchRecord, OrderRecord, PurchasingStore } from './purchasing-store';

const DOC_TYPE = 'SUPPLIER_INVOICE';
const READ = 'pur.supplier_invoice.read';
const CREATE = 'pur.supplier_invoice.create';
const MATCH = 'pur.supplier_invoice.match';
const APPROVE = 'pur.supplier_invoice.approve';
const INVOICE_FILE = 'SUPPLIER_INVOICE';
export const SUPPLIER_CREDIT_NOTE_KIND = 'SUPPLIER_CREDIT_NOTE';
export const SUPPLIER_INVOICE_VARIANCE_KIND = 'SUPPLIER_INVOICE_VARIANCE';
const WITHDRAWN = 'Approval request withdrawn by its maker';
/** Orders an invoice may be entered against: sent, being received, received or closed. */
const INVOICEABLE: ReadonlySet<string> = new Set(['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED']);
const CHANGEABLE: ReadonlySet<InvoiceStatus> = new Set(['DRAFT', 'MATCHED', 'MISMATCH']);
const CANCELLABLE: ReadonlySet<InvoiceStatus> = new Set(['DRAFT', 'MATCHED', 'MISMATCH', 'APPROVED']);

/** The contract's `SupplierInvoiceLineInput`, parsed at the boundary. */
export interface InvoiceLineInput {
  readonly productId?: string | undefined;
  readonly description: string;
  readonly purchaseOrderLineId?: string | undefined;
  readonly goodsReceiptLineId?: string | undefined;
  readonly qty: string;
  readonly unitPricePesewas: number;
  readonly taxCategoryId: string;
  readonly leviesCharged?: readonly { readonly levyId: string; readonly amountPesewas: number }[] | undefined;
  readonly expenseCategory?: string | undefined;
  /** A credit note's line only: where goods sent back to the supplier leave from (FR-PUR-011). */
  readonly returnFromLocationId?: string | undefined;
  /** The lot or animal sent back, for a tracked product. */
  readonly returnStockUnitId?: string | undefined;
}

export interface SupplierInvoiceCreate {
  readonly kind: 'INVOICE' | 'CREDIT_NOTE';
  readonly supplierId: string;
  readonly supplierInvoiceNo: string;
  readonly invoiceDate: string;
  readonly dueDate?: string | undefined;
  readonly purchaseOrderId?: string | undefined;
  readonly originalInvoiceId?: string | undefined;
  readonly branchId?: string | undefined;
  readonly fileId?: string | undefined;
  readonly statedGrossPesewas?: number | undefined;
  readonly returnReasonCode?: string | undefined;
  readonly lines: readonly InvoiceLineInput[];
}

export interface SupplierInvoiceUpdate {
  readonly version: number;
  readonly supplierInvoiceNo?: string | undefined;
  readonly invoiceDate?: string | undefined;
  readonly dueDate?: string | undefined;
  readonly fileId?: string | undefined;
  readonly statedGrossPesewas?: number | undefined;
  readonly returnReasonCode?: string | undefined;
  readonly lines?: readonly InvoiceLineInput[] | undefined;
}

/** The contract's `SupplierInvoiceLine`. */
export interface SupplierInvoiceLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string } | null;
  readonly description: string;
  readonly purchaseOrderLineId: string | null;
  readonly goodsReceiptLineId: string | null;
  readonly qty: string;
  readonly uom: string | null;
  readonly unitPricePesewas: number;
  readonly lineNetPesewas: number;
  readonly taxCategory: { readonly id: string; readonly code: string; readonly name: string };
  readonly levies: readonly {
    readonly levyCode: string;
    readonly levyName: string;
    readonly treatment: string;
    readonly ratePercent: string;
    readonly basePesewas: number;
    readonly amountPesewas: number;
    readonly calculatedAmountPesewas: number;
    readonly isReclaimable: boolean;
  }[];
  readonly qtyVariance: string | null;
  readonly priceVariancePesewas: number | null;
  readonly priceVarianceDirection: 'OVER' | 'UNDER' | null;
  readonly matchStatus: MatchStatus;
  readonly matchReasons: readonly MatchReason[];
  readonly returnFromLocationId: string | null;
  readonly returnStockUnitId: string | null;
  /** A claim credit note's line: the claim line it credits, whose claimed value is its net (ADR-0076); else null. */
  readonly supplierClaimLineId: string | null;
}

/** The contract's `SupplierInvoice`. */
export interface SupplierInvoiceView {
  readonly id: string;
  readonly kind: 'INVOICE' | 'CREDIT_NOTE';
  readonly status: InvoiceStatus;
  readonly supplier: { readonly id: string; readonly publicId: string; readonly name: string };
  readonly supplierInvoiceNo: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly purchaseOrder: { readonly id: string; readonly docType: string; readonly number: string | null } | null;
  readonly originalInvoiceId: string | null;
  readonly netPesewas: number;
  readonly taxPesewas: number;
  readonly grossPesewas: number;
  readonly paidPesewas: number;
  readonly creditedPesewas: number;
  readonly outstandingPesewas: number;
  readonly currency: 'GHS';
  readonly matchStatus: InvoiceMatchStatus;
  readonly approvalRequestId: string | null;
  readonly varianceReason: string | null;
  readonly returnReasonCode: string | null;
  /** A credit note drafted from a receipt's claim (ADR-0076); else null. */
  readonly supplierClaimId: string | null;
  readonly file: { readonly id: string; readonly originalName: string; readonly contentType: string } | null;
  readonly lines: readonly SupplierInvoiceLineView[];
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly displayName: string };
}

/** What a credit note's approval binds to: the credit as entered (A-172). */
function creditHash(credit: InvoiceRecord): string {
  return documentHash(credit, null);
}

/** What a variance's approval binds to: the invoice as entered and the match it failed (A-172). */
function varianceHash(invoice: InvoiceRecord): string {
  return documentHash(invoice, invoice.lines.map((l) => [l.matchStatus, [...l.matchReasons]]));
}

function documentHash(record: InvoiceRecord, match: unknown): string {
  const payload = {
    kind: record.kind,
    supplierId: record.supplierId,
    supplierInvoiceNo: record.supplierInvoiceNo,
    invoiceDate: record.invoiceDate,
    originalInvoiceId: record.originalInvoiceId,
    grossPesewas: record.grossPesewas.toString(),
    returnReasonCode: record.returnReasonCode,
    lines: record.lines.map((l) => [l.productId, l.purchaseOrderLineId, l.qty, l.unitPricePesewas.toString(), l.lineNetPesewas.toString(), l.returnLocationId, l.returnStockUnitId]),
    levies: record.lines.map((l) => l.levies.map((levy) => [levy.levyId, levy.amountPesewas.toString()])),
    match,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Supplier invoices with the three-way match (FR-PUR-008 to FR-PUR-010, A-164): entered with each line's levies as
 * the supplier charged them beside MDM's calculation on the invoice date (a reclaimable flag on every levy row,
 * ADR-0020), matched line by line against the order line and what was received (SA-08), and approved for payment only
 * when every payable line matches, or when a different person approves the price or levy variance (FR-PUR-010,
 * A-172); approval publishes the ledger event for B8. Supplier credit notes (FR-PUR-011, A-172) reduce an approved
 * invoice by no more than it has left, wait for a different person, and on approval send returned goods back through
 * INV's `Stock` and publish their ledger event. A line in the order line's unit converts to the base unit through
 * `MasterDataRefs.toBaseIn`. Every handler authorises first, scoped to the invoice's branch; every change is audited.
 */
/**
 * The events PUR publishes that post to the ledger (◆ in docs/DOMAIN_MODEL.md section 5.7), declared for FIN's boot
 * assertion (ADR-0003). `pur.SupplierCreditNoteRecorded` of ADR-0003's matrix is published as `pur.SupplierCreditNoteApproved`.
 */
export const PUR_LEDGER_EVENTS = ['pur.SupplierInvoiceMatched', 'pur.ExpenseInvoiceApproved', 'pur.SupplierCreditNoteApproved', 'pur.SupplierPaymentMade'] as const;

export class SupplierInvoices {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: PurchasingStore,
    private readonly register: SupplierRegisterStore,
    private readonly refs: MasterDataRefs,
    private readonly tax: TaxService,
    private readonly files: FileStore,
    private readonly approvals: Approvals,
    private readonly stock: Stock,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly principals: PrincipalNames,
    readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly claims: SupplierClaimStore,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filter: InvoiceFilter, cursor: string | undefined, limit: number): Promise<Page<SupplierInvoiceView>> {
    return this.uow.run({ isolation: 'read committed' }, (tx) =>
      readPage<InvoiceRecord, SupplierInvoiceView>(
        tx,
        { authoriser: this.authoriser, cursors: this.cursors },
        actor,
        READ,
        'listSupplierInvoices',
        {
          status: filter.status ?? null,
          kind: filter.kind ?? null,
          supplierId: filter.supplierId ?? null,
          matchStatus: filter.matchStatus ?? null,
          dueBefore: filter.dueBefore ?? null,
          outstandingOnly: filter.outstandingOnly,
        },
        cursor,
        limit,
        (scopes, before, n) => this.store.listInvoices(tx, filter, wholeBranches(scopes), before, n),
        (records) => this.views(tx, records),
      ),
    );
  }

  get(actor: Actor | undefined, id: string): Promise<SupplierInvoiceView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.store.invoice(tx, id);
      await this.authoriser.authorise(tx, actor, READ, record === null ? {} : { branchId: record.branchId });
      if (record === null) throw new NotFoundError(`no supplier invoice ${id}`);
      return (await this.views(tx, [record]))[0]!;
    });
  }

  create(actor: Actor | undefined, body: SupplierInvoiceCreate, idempotencyKey: string): Promise<StoredResponse<SupplierInvoiceView>> {
    return runPurchaseCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      CREATE,
      'createSupplierInvoice',
      body,
      idempotencyKey,
      async (tx) => {
        const original = body.originalInvoiceId === undefined ? null : await this.store.invoice(tx, body.originalInvoiceId);
        const order = body.purchaseOrderId === undefined ? null : await this.store.order(tx, body.purchaseOrderId);
        const branchId = original?.branchId ?? order?.branchId ?? body.branchId;
        return branchId === undefined ? {} : { branchId };
      },
      async (tx) => {
        if (body.kind === 'CREDIT_NOTE') return this.createCreditNote(tx, actor!, body);
        refuseCreditFields(body);
        const supplier = (await this.refs.suppliersIn(tx, [body.supplierId])).get(body.supplierId);
        if (supplier === undefined) throw new PurReferenceNotFoundError(['/supplierId']);
        const order = await this.orderFor(tx, body.purchaseOrderId, body.supplierId);
        const branchId = order?.branchId ?? body.branchId;
        if (branchId === undefined) throw new SupplierInvoiceInvalidError([{ field: '/branchId', rule: 'BRANCH_REQUIRED' }]);
        if (order !== null && body.branchId !== undefined && body.branchId !== order.branchId) throw new SupplierInvoiceInvalidError([{ field: '/branchId', rule: 'BRANCH_DIFFERS' }]);
        if ((await this.refs.branchesIn(tx, [branchId])).get(branchId) === undefined) throw new PurReferenceNotFoundError(['/branchId']);
        const built = await this.build(tx, body, order, await this.termsDays(tx, supplier.id));
        if (await this.store.supplierInvoiceNoTaken(tx, body.supplierId, built.header.supplierInvoiceNo, null)) throw new DuplicateSupplierInvoiceError();
        const id = this.nextId();
        await this.documents.register(tx, { id, docType: DOC_TYPE, ownerModule: 'pur', branchId, actorId: actor!.principalId });
        await this.store.insertInvoice(tx, id, { ...built.header, kind: 'INVOICE', supplierId: supplier.id, purchaseOrderId: order?.id ?? null, originalInvoiceId: null, branchId }, built.lines, actor!.principalId);
        const view = await this.view(tx, id);
        await this.audit.record(tx, { module: 'pur', action: 'CREATE', entityType: 'SupplierInvoice', entityId: id, branchId, before: null, after: { ...view } });
        return { status: 201, body: view };
      },
    ).catch(translatePurRefusal);
  }

  update(actor: Actor | undefined, id: string, body: SupplierInvoiceUpdate, idempotencyKey: string): Promise<StoredResponse<SupplierInvoiceView>> {
    return this.write(actor, CREATE, 'updateSupplierInvoice', id, body, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, CHANGEABLE, body.version);
      const credit = before.kind === 'CREDIT_NOTE';
      if (credit && before.status !== 'DRAFT') throw wrongStatus(`credit note ${id}`, before.status);
      // A credit note drafted from a claim is the claim's, never keyed: cancel it and draft it again instead (ADR-0076).
      if (before.supplierClaimId !== null) throw new SupplierInvoiceInvalidError([{ field: '/supplierClaimId', rule: 'CLAIM_CREDIT_NOTE_FIXED' }]);
      if (!credit) refuseCreditFields(body);
      const order = before.purchaseOrderId === null ? null : await this.store.order(tx, before.purchaseOrderId);
      const fields = {
        supplierInvoiceNo: body.supplierInvoiceNo ?? before.supplierInvoiceNo,
        invoiceDate: body.invoiceDate ?? before.invoiceDate,
        dueDate: body.dueDate ?? (body.invoiceDate === undefined ? before.dueDate : undefined),
        fileId: body.fileId ?? before.fileId ?? undefined,
        statedGrossPesewas: body.statedGrossPesewas ?? (before.statedGrossPesewas === null ? undefined : pesewas(before.statedGrossPesewas)),
        returnReasonCode: body.returnReasonCode ?? before.returnReasonCode ?? undefined,
        lines: body.lines ?? before.lines.map(inputOf),
      };
      const built = await this.build(tx, fields, order, credit ? 0 : await this.termsDays(tx, before.supplierId));
      if (credit) {
        const original = (await this.store.lockInvoice(tx, before.originalInvoiceId!))!;
        await this.judgeReturns(tx, fields, original.branchId);
        await this.judgeHeadroom(tx, original, built.header.grossPesewas, before.grossPesewas);
      }
      if (await this.store.supplierInvoiceNoTaken(tx, before.supplierId, built.header.supplierInvoiceNo, id)) throw new DuplicateSupplierInvoiceError();
      await this.store.replaceInvoice(tx, id, built.header, built.lines, actor!.principalId);
      return { status: 200, body: await this.audited(tx, 'UPDATE', before) };
    });
  }

  match(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<SupplierInvoiceView>> {
    return this.write(actor, MATCH, 'matchSupplierInvoice', id, {}, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, CHANGEABLE, null);
      if (before.kind === 'CREDIT_NOTE') throw new SupplierInvoiceInvalidError([{ field: '/kind', rule: 'CREDIT_NOTE_NEEDS_APPROVAL' }]);
      const results = await this.matched(tx, before);
      const status = matchInvoice(results.map((r) => ({ ...r, status: r.matchStatus, qtyVariance: null, priceVariance: null })));
      await this.store.recordMatch(tx, id, results, status, this.clock.now(), actor!.principalId);
      const view = await this.audited(tx, 'MATCH', before, { matchStatus: status });
      if (status === 'MISMATCH') {
        await this.events.publish<SupplierInvoiceMismatched>(tx, {
          type: 'pur.SupplierInvoiceMismatched',
          subjectType: 'SupplierInvoice',
          subjectId: id,
          branchId: view.branchId,
          payload: {
            supplierInvoiceId: id,
            supplierId: view.supplier.id,
            supplierInvoiceNo: view.supplierInvoiceNo,
            purchaseOrderId: before.purchaseOrderId,
            grossPesewas: view.grossPesewas,
            lines: view.lines.filter((l) => l.matchStatus === 'MISMATCH').map((l) => ({ lineNo: l.lineNo, reasons: [...l.matchReasons] })),
          },
        });
      }
      return { status: 200, body: view };
    });
  }

  approve(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<SupplierInvoiceView>> {
    return this.write(actor, APPROVE, 'approveSupplierInvoice', id, {}, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, new Set(['DRAFT', 'MATCHED', 'MISMATCH']), null);
      if (before.kind === 'CREDIT_NOTE') throw new SupplierInvoiceInvalidError([{ field: '/kind', rule: 'CREDIT_NOTE_NEEDS_APPROVAL' }]);
      if (before.status === 'DRAFT') throw new ThreeWayMatchFailedError([{ field: '/matchStatus', rule: 'UNMATCHED' }]);
      // The match again, as things are now: a mismatch recorded earlier, or one that appeared since, blocks approval.
      const results = await this.matched(tx, before);
      const failing = results.flatMap((r, i) => r.reasons.map((reason) => ({ field: `/lines/${i}`, rule: reason })));
      if (before.status === 'MISMATCH' || failing.length > 0) {
        throw new ThreeWayMatchFailedError(failing.length > 0 ? failing : [{ field: '/matchStatus', rule: 'MISMATCH' }]);
      }
      await this.store.markInvoiceApproved(tx, id, this.clock.now(), actor!.principalId);
      const view = await this.audited(tx, 'APPROVE', before);
      await this.publishApproved(tx, before, view, null);
      return { status: 200, body: view };
    });
  }

  cancel(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<SupplierInvoiceView>> {
    return this.write(actor, CREATE, 'cancelSupplierInvoice', id, { reason }, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, CANCELLABLE, null);
      if (before.kind === 'CREDIT_NOTE' && before.status !== 'DRAFT') throw wrongStatus(`credit note ${id}`, before.status);
      if (((await this.store.promised(tx, [id])).get(id) ?? 0n) > 0n) throw new SupplierInvoiceInvalidError([{ field: '/status', rule: 'PAYMENT_ALLOCATED' }]);
      if (((await this.store.liveCredits(tx, [id])).get(id) ?? 0n) > 0n) throw new SupplierInvoiceInvalidError([{ field: '/status', rule: 'CREDIT_NOTE_ENTERED' }]);
      await this.store.markInvoiceCancelled(tx, id, reason, actor!.principalId);
      return { status: 200, body: await this.audited(tx, 'CANCEL', before, { reason }) };
    });
  }

  /**
   * `submitSupplierCreditNote` (FR-PUR-011, A-172): a DRAFT credit note waits for a different person, whatever its
   * amount, through IAM's SUPPLIER_CREDIT_NOTE kind. Nothing is credited and no goods move until it is approved.
   */
  submitCreditNote(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<ApprovalPendingView>> {
    return this.write(actor, CREATE, 'submitSupplierCreditNote', id, {}, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, new Set(['DRAFT']), null);
      if (before.kind !== 'CREDIT_NOTE') throw new SupplierInvoiceInvalidError([{ field: '/kind', rule: 'NOT_A_CREDIT_NOTE' }]);
      const original = (await this.store.lockInvoice(tx, before.originalInvoiceId!))!;
      await this.judgeHeadroom(tx, original, before.grossPesewas, before.grossPesewas);
      const supplier = (await this.refs.suppliersIn(tx, [before.supplierId])).get(before.supplierId)!;
      const returning = before.lines.filter((l) => l.returnLocationId !== null).length;
      const summary = `Credit ${before.grossPesewas} pesewas from ${supplier.name} (${before.supplierInvoiceNo}) against invoice ${original.supplierInvoiceNo}${returning > 0 ? `, sending back the goods of ${returning} line(s)` : ''}`;
      const request = await this.approvals.request(tx, actor, {
        kind: SUPPLIER_CREDIT_NOTE_KIND,
        branchId: before.branchId,
        subjectDocumentId: id,
        payloadHash: creditHash(before),
        amountPesewas: before.grossPesewas,
        summary,
      });
      await this.store.markInvoicePending(tx, id, request.id, null, actor!.principalId);
      await this.audited(tx, 'SUBMIT', before, { approvalRequestId: request.id });
      return {
        status: 202,
        body: { status: 'PENDING_APPROVAL', approvalRequestId: request.id, kind: SUPPLIER_CREDIT_NOTE_KIND, subject: { id, docType: DOC_TYPE, number: null }, summary, requestedAt: request.requestedAt.toISOString() },
      };
    });
  }

  /**
   * `requestSupplierInvoiceVariance` (FR-PUR-010, A-172): a MISMATCH invoice whose lines fail only on price or a levy
   * waits for a different person to accept the variance, through IAM's SUPPLIER_INVOICE_VARIANCE kind. The match is
   * taken again now and recorded, so the approval binds to the mismatch as it stands.
   */
  requestVariance(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<ApprovalPendingView>> {
    return this.write(actor, APPROVE, 'requestSupplierInvoiceVariance', id, { reason }, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, new Set(['MISMATCH']), null);
      const results = await this.matched(tx, before);
      const judged = judgeVarianceLines(results);
      if (!judged.ok && judged.error.length === 0) throw new SupplierInvoiceInvalidError([{ field: '/matchStatus', rule: 'NO_MISMATCH' }]);
      if (!judged.ok) throw new VarianceNotAllowedError(judged.error.map((e) => ({ field: `/lines/${e.index}`, rule: e.reason })));
      await this.store.recordMatch(tx, id, results, 'MISMATCH', this.clock.now(), actor!.principalId);
      const current = (await this.store.invoice(tx, id))!;
      const supplier = (await this.refs.suppliersIn(tx, [before.supplierId])).get(before.supplierId)!;
      const lines = results.flatMap((r, i) => (r.reasons.length > 0 ? [`line ${lineNumber(i)} ${r.reasons.join(' and ')}`] : []));
      const summary = `Pay ${supplier.name} invoice ${before.supplierInvoiceNo} at ${before.grossPesewas} pesewas despite the mismatch (${lines.join('; ')}): ${reason.trim()}`;
      const request = await this.approvals.request(tx, actor, {
        kind: SUPPLIER_INVOICE_VARIANCE_KIND,
        branchId: before.branchId,
        subjectDocumentId: id,
        payloadHash: varianceHash(current),
        amountPesewas: before.grossPesewas,
        summary,
      });
      await this.store.markInvoicePending(tx, id, request.id, reason.trim(), actor!.principalId);
      await this.audited(tx, 'VARIANCE_REQUEST', before, { approvalRequestId: request.id, reason: reason.trim() });
      return {
        status: 202,
        body: { status: 'PENDING_APPROVAL', approvalRequestId: request.id, kind: SUPPLIER_INVOICE_VARIANCE_KIND, subject: { id, docType: DOC_TYPE, number: null }, summary, requestedAt: request.requestedAt.toISOString() },
      };
    });
  }

  /** IAM's handler for SUPPLIER_CREDIT_NOTE: the credit goes into force, goods go back, the ledger event is published. */
  readonly creditNoteApprovals: ApprovalHandler = {
    currentPayloadHash: async (tx, subjectDocumentId) => creditHash(await this.existing(tx, subjectDocumentId)),
    onApproved: async (tx, request) => {
      const before = await this.locked(tx, request.subjectDocumentId, new Set(['DRAFT']), null, request.id);
      const approver = request.decidedBy!;
      const claim = before.supplierClaimId === null ? null : await this.claims.lockClaim(tx, before.supplierClaimId);
      const judged = judgeClaimCreditApprover({
        creditMakerId: before.createdBy,
        requesterId: request.requestedBy,
        claimMakerId: claim?.createdBy ?? null,
        receiverId: claim?.receivedBy ?? null,
        approverId: approver,
      });
      if (!judged.ok) throw new InvoiceMakerCannotApproveError();
      const original = (await this.store.lockInvoice(tx, before.originalInvoiceId!))!;
      const originalBefore = (await this.views(tx, [original]))[0]!;
      const now = this.clock.now();
      const returns = await this.sendBack(tx, approver, before, now);
      await this.store.markCreditApproved(tx, before.id, now, approver);
      await this.audited(tx, 'APPROVE', before, { approvalRequestId: request.id, returns: returns.map((r) => r.movementId) });
      if (claim !== null) await this.settleClaimIn(tx, claim, 'CREDIT_NOTE', before.id, approver, now);
      const originalAfter = await this.view(tx, original.id);
      await this.audit.record(tx, { module: 'pur', action: 'CREDIT', entityType: 'SupplierInvoice', entityId: original.id, branchId: original.branchId, before: { ...originalBefore }, after: { ...originalAfter }, metadata: { creditNoteId: before.id } });
      await this.events.publish<SupplierCreditNoteApproved>(tx, {
        type: 'pur.SupplierCreditNoteApproved',
        subjectType: 'SupplierInvoice',
        subjectId: before.id,
        branchId: before.branchId,
        payload: {
          creditNoteId: before.id,
          originalInvoiceId: original.id,
          supplierId: before.supplierId,
          supplierInvoiceNo: before.supplierInvoiceNo,
          invoiceDate: before.invoiceDate,
          purchaseOrderId: before.purchaseOrderId,
          netPesewas: pesewas(before.netPesewas),
          taxPesewas: pesewas(before.taxPesewas),
          grossPesewas: pesewas(before.grossPesewas),
          approvalRequestId: request.id,
          ...(await this.postingParts(tx, before)),
          returns,
        },
      });
    },
    onRejected: (tx, request) => this.undecided(tx, request, new Set(['DRAFT'])),
  };

  /** IAM's handler for SUPPLIER_INVOICE_VARIANCE: the invoice is approved for payment as invoiced, on the variance. */
  readonly varianceApprovals: ApprovalHandler = {
    currentPayloadHash: async (tx, subjectDocumentId) => varianceHash(await this.existing(tx, subjectDocumentId)),
    onApproved: async (tx, request) => {
      const before = await this.locked(tx, request.subjectDocumentId, new Set(['MISMATCH']), null, request.id);
      const judged = judgeVarianceApprover({ invoiceMakerId: before.createdBy, requesterId: request.requestedBy, approverId: request.decidedBy! });
      if (!judged.ok) throw new InvoiceMakerCannotApproveError();
      // The match as things are now must still be the mismatch that was approved, and one a variance covers.
      const results = await this.matched(tx, before);
      const stored = new Map(before.lines.map((l) => [l.id, l.matchReasons.join(',')] as const));
      if (results.some((r) => r.reasons.join(',') !== stored.get(r.lineId))) throw new SupplierInvoiceInvalidError([{ field: '/lines', rule: 'MATCH_CHANGED' }]);
      const lines = judgeVarianceLines(results);
      if (!lines.ok) throw new VarianceNotAllowedError(lines.error.map((e) => ({ field: `/lines/${e.index}`, rule: e.reason })));
      await this.store.markVarianceApproved(tx, before.id, this.clock.now(), request.decidedBy!);
      const view = await this.audited(tx, 'APPROVE_VARIANCE', before, { approvalRequestId: request.id });
      await this.publishApproved(tx, before, view, request.id);
    },
    onRejected: (tx, request) => this.undecided(tx, request, new Set(['MISMATCH'])),
  };

  /** A credit or variance refused or withdrawn: the document may be corrected again; nothing was credited or approved. */
  private async undecided(tx: Transaction, request: ApprovalRecord, allowed: ReadonlySet<InvoiceStatus>): Promise<void> {
    const before = await this.locked(tx, request.subjectDocumentId, allowed, null, request.id);
    const withdrawn = request.status === 'CANCELLED';
    await this.store.clearInvoicePending(tx, before.id, request.decidedBy ?? request.requestedBy);
    await this.audited(tx, withdrawn ? 'WITHDRAW' : 'REJECT', before, { approvalRequestId: request.id, ...(withdrawn ? { reason: WITHDRAWN } : {}) });
  }

  private async existing(tx: Transaction, id: string): Promise<InvoiceRecord> {
    const record = await this.store.invoice(tx, id);
    if (record === null) throw new NotFoundError(`no supplier invoice ${id}`);
    return record;
  }

  /**
   * The supplier-return movements of an approved credit note (FR-PUR-011): each line that sends goods back moves its
   * base quantity from where it stands to the branch's virtual SUPPLIER location through INV's `Stock`, at the cost
   * the database decides, with the credit's return reason. INV refuses more than is on hand.
   */
  private async sendBack(tx: Transaction, actorId: string, credit: InvoiceRecord, at: Date): Promise<SupplierCreditNoteApproved['returns'][number][]> {
    const returning = credit.lines.filter((l) => l.returnLocationId !== null);
    if (returning.length === 0) return [];
    const supplierLocation = await this.refs.virtualLocationIn(tx, credit.branchId, 'SUPPLIER');
    if (supplierLocation === null) throw new Error(`branch ${credit.branchId} has no virtual SUPPLIER location; every branch is created with one (ADR-0042)`);
    const returns: SupplierCreditNoteApproved['returns'][number][] = [];
    for (const line of returning) {
      const posted = await this.stock.postIn(tx, actorId, {
        movementType: 'SUPPLIER_RETURN',
        productId: line.productId!,
        stockUnitId: line.returnStockUnitId,
        branchId: credit.branchId,
        fromLocationId: line.returnLocationId!,
        toLocationId: supplierLocation,
        qty: Quantity.parse(line.qtyBase!),
        reasonCode: credit.returnReasonCode,
        sourceDocumentId: credit.id,
        sourceLineRef: line.id,
        occurredAt: at,
      });
      returns.push({ lineNo: line.lineNo, movementId: posted.id, productId: line.productId!, qty: Quantity.parse(line.qtyBase!).toDecimalString(), costPesewas: posted.value.toJsonInteger() });
    }
    return returns;
  }

  /** A credit note entered against an approved invoice, within what it has left (FR-PUR-011). */
  private async createCreditNote(tx: Transaction, actor: Actor, body: SupplierInvoiceCreate): Promise<StoredResponse<SupplierInvoiceView>> {
    if (body.originalInvoiceId === undefined) throw new SupplierInvoiceInvalidError([{ field: '/originalInvoiceId', rule: 'ORIGINAL_REQUIRED' }]);
    const original = await this.store.lockInvoice(tx, body.originalInvoiceId);
    if (original === null) throw new PurReferenceNotFoundError(['/originalInvoiceId']);
    if ((await this.refs.suppliersIn(tx, [body.supplierId])).get(body.supplierId) === undefined) throw new PurReferenceNotFoundError(['/supplierId']);
    const target = judgeCreditTarget(original, { supplierId: body.supplierId, purchaseOrderId: body.purchaseOrderId ?? null, branchId: body.branchId ?? null });
    if (!target.ok) {
      const field = target.error === 'ORDER_DIFFERS' ? '/purchaseOrderId' : target.error === 'BRANCH_DIFFERS' ? '/branchId' : '/originalInvoiceId';
      throw new SupplierInvoiceInvalidError([{ field, rule: target.error }]);
    }
    const order = original.purchaseOrderId === null ? null : await this.store.order(tx, original.purchaseOrderId);
    const built = await this.build(tx, body, order, 0);
    await this.judgeReturns(tx, body, original.branchId);
    await this.judgeHeadroom(tx, original, built.header.grossPesewas, 0n);
    if (await this.store.supplierInvoiceNoTaken(tx, body.supplierId, built.header.supplierInvoiceNo, null)) throw new DuplicateSupplierInvoiceError();
    const id = this.nextId();
    await this.documents.register(tx, { id, docType: DOC_TYPE, ownerModule: 'pur', branchId: original.branchId, actorId: actor.principalId });
    await this.store.insertInvoice(
      tx,
      id,
      { ...built.header, kind: 'CREDIT_NOTE', supplierId: original.supplierId, purchaseOrderId: original.purchaseOrderId, originalInvoiceId: original.id, branchId: original.branchId },
      built.lines,
      actor.principalId,
    );
    const view = await this.view(tx, id);
    await this.audit.record(tx, { module: 'pur', action: 'CREATE', entityType: 'SupplierInvoice', entityId: id, branchId: original.branchId, before: null, after: { ...view } });
    return { status: 201, body: view };
  }

  /** The credit's headroom on its invoice: live credits other than this one's `ownPesewas`, and live payments. */
  private async judgeHeadroom(tx: Transaction, original: InvoiceRecord, creditPesewas: bigint, ownPesewas: bigint): Promise<void> {
    const promised = (await this.store.promised(tx, [original.id])).get(original.id) ?? 0n;
    const live = ((await this.store.liveCredits(tx, [original.id])).get(original.id) ?? 0n) - ownPesewas;
    const judged = judgeCreditNote({ grossPesewas: original.grossPesewas, liveCreditsPesewas: live, promisedPesewas: promised }, creditPesewas);
    if (!judged.ok && judged.error === 'CREDIT_EMPTY') throw new SupplierInvoiceInvalidError([{ field: '/lines', rule: 'CREDIT_EMPTY' }]);
    if (!judged.ok) throw new CreditNoteExceedsInvoiceError(original.grossPesewas - live - promised);
  }

  /** Where returned goods leave from: a physical location of the invoice's branch, with a RETURN reason. */
  private async judgeReturns(tx: Transaction, body: Pick<SupplierInvoiceCreate, 'returnReasonCode' | 'lines'>, branchId: string): Promise<void> {
    const broken: BrokenRule[] = [];
    const named = body.lines.flatMap((l, i) => (l.returnFromLocationId === undefined ? [] : [{ line: l, i }]));
    const locations = await this.refs.locationsIn(tx, named.map((n) => n.line.returnFromLocationId!));
    for (const [i, line] of body.lines.entries()) {
      if (line.returnStockUnitId !== undefined && line.returnFromLocationId === undefined) broken.push({ field: `/lines/${i}/returnFromLocationId`, rule: 'RETURN_LOCATION_REQUIRED' });
    }
    for (const { line, i } of named) {
      const location = locations.get(line.returnFromLocationId!);
      if (location === undefined) throw new PurReferenceNotFoundError([`/lines/${i}/returnFromLocationId`]);
      if (line.productId === undefined && line.purchaseOrderLineId === undefined) broken.push({ field: `/lines/${i}/returnFromLocationId`, rule: 'RETURN_NEEDS_PRODUCT' });
      else if (location.branchId !== branchId) broken.push({ field: `/lines/${i}/returnFromLocationId`, rule: 'LOCATION_OF_ANOTHER_BRANCH' });
      else if (location.isVirtual || !location.isLive) broken.push({ field: `/lines/${i}/returnFromLocationId`, rule: 'NOT_A_RETURN_LOCATION' });
    }
    if (named.length > 0) {
      if (body.returnReasonCode === undefined) broken.push({ field: '/returnReasonCode', rule: 'RETURN_REASON_REQUIRED' });
      else if ((await this.refs.reasonCodesIn(tx, [body.returnReasonCode])).get(body.returnReasonCode)?.domain !== 'RETURN') broken.push({ field: '/returnReasonCode', rule: 'RETURN_REASON_INVALID' });
    }
    if (broken.length > 0) throw new SupplierInvoiceInvalidError(broken);
  }

  /** The invoices as the contract shows them. */
  async views(tx: Transaction, records: readonly InvoiceRecord[]): Promise<SupplierInvoiceView[]> {
    const lines = records.flatMap((r) => r.lines);
    const products = await this.refs.productsIn(tx, lines.flatMap((l) => (l.productId === null ? [] : [l.productId])));
    const categories = await this.refs.taxCategoriesIn(tx, lines.map((l) => l.taxCategoryId));
    const suppliers = await this.refs.suppliersIn(tx, records.map((r) => r.supplierId));
    const orders = await this.documents.refs(tx, records.flatMap((r) => (r.purchaseOrderId === null ? [] : [r.purchaseOrderId])));
    const names = await this.principals.refs(tx, records.map((r) => r.createdBy));
    const files = new Map<string, { id: string; originalName: string; contentType: string }>();
    for (const fileId of new Set(records.flatMap((r) => (r.fileId === null ? [] : [r.fileId])))) {
      const file = (await this.files.find(tx, fileId))!;
      files.set(fileId, { id: file.id, originalName: file.originalName, contentType: file.contentType });
    }
    return records.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      supplier: supplierRef(suppliers.get(r.supplierId)!),
      supplierInvoiceNo: r.supplierInvoiceNo,
      invoiceDate: r.invoiceDate,
      dueDate: r.dueDate,
      purchaseOrder: r.purchaseOrderId === null ? null : orders.get(r.purchaseOrderId)!,
      originalInvoiceId: r.originalInvoiceId,
      netPesewas: pesewas(r.netPesewas),
      taxPesewas: pesewas(r.taxPesewas),
      grossPesewas: pesewas(r.grossPesewas),
      paidPesewas: pesewas(r.paidPesewas),
      creditedPesewas: pesewas(r.creditedPesewas),
      // What is still owed on an invoice (FR-PUR-011, FR-PUR-012); a credit note owes nothing.
      outstandingPesewas: r.kind === 'CREDIT_NOTE' ? 0 : pesewas(invoicePayable(r)),
      currency: 'GHS' as const,
      matchStatus: r.matchStatus,
      approvalRequestId: r.approvalRequestId,
      varianceReason: r.varianceReason,
      returnReasonCode: r.returnReasonCode,
      supplierClaimId: r.supplierClaimId,
      file: r.fileId === null ? null : files.get(r.fileId)!,
      lines: r.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        product: l.productId === null ? null : productRef(products.get(l.productId)!),
        description: l.description,
        purchaseOrderLineId: l.purchaseOrderLineId,
        goodsReceiptLineId: l.goodsReceiptLineId,
        qty: Quantity.parse(l.qty).toDecimalString(),
        uom: l.uom,
        unitPricePesewas: pesewas(l.unitPricePesewas),
        lineNetPesewas: pesewas(l.lineNetPesewas),
        taxCategory: categories.get(l.taxCategoryId)!,
        levies: l.levies.map((levy) => ({
          levyCode: levy.levyCode,
          levyName: levy.levyName,
          treatment: levy.treatment,
          ratePercent: levy.ratePercent,
          basePesewas: pesewas(levy.basePesewas),
          amountPesewas: pesewas(levy.amountPesewas),
          calculatedAmountPesewas: pesewas(levy.calculatedAmountPesewas),
          isReclaimable: levy.isReclaimable,
        })),
        qtyVariance: l.qtyVariance === null ? null : Quantity.parse(l.qtyVariance).toDecimalString(),
        priceVariancePesewas: l.priceVariancePesewas === null ? null : pesewas(l.priceVariancePesewas),
        priceVarianceDirection: l.priceVarianceDirection,
        matchStatus: l.matchStatus,
        matchReasons: l.matchReasons,
        returnFromLocationId: l.returnLocationId,
        returnStockUnitId: l.returnStockUnitId,
        supplierClaimLineId: l.supplierClaimLineId ?? null,
      })),
      branchId: r.branchId,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      createdBy: principalRef(names, r.createdBy),
    }));
  }

  /**
   * A DRAFT credit note drafted from an open claim against the approved invoice that charged its goods (ADR-0076), in
   * the caller's transaction: one line per claim line, in the product's base unit, at the claim line's rejected
   * quantity and claimed value, never keyed; levies from MDM's calculator. Refused when the invoice is not one a credit
   * may reduce, does not carry every order line the claim names, or the supplier did not invoice the claimed goods
   * beyond what was received and what other claims credit (`CLAIM_NOT_INVOICED`): the same eggs are never credited twice.
   * It is submitted and approved as every credit note is.
   */
  async draftClaimCreditIn(
    tx: Transaction,
    actor: Actor,
    claim: ClaimRecord,
    body: { readonly originalInvoiceId: string; readonly supplierInvoiceNo: string; readonly invoiceDate: string },
  ): Promise<SupplierInvoiceView> {
    const original = await this.store.lockInvoice(tx, body.originalInvoiceId);
    if (original === null) throw new PurReferenceNotFoundError(['/originalInvoiceId']);
    const target = judgeCreditTarget(original, { supplierId: claim.supplierId, purchaseOrderId: claim.purchaseOrderId, branchId: claim.branchId });
    if (!target.ok) throw new SupplierClaimInvalidError([{ field: '/originalInvoiceId', rule: target.error }]);
    const orderLineIds = [...new Set(claim.lines.map((l) => l.purchaseOrderLineId))];
    const invoicedHere = new Set(original.lines.flatMap((l) => (l.purchaseOrderLineId === null ? [] : [l.purchaseOrderLineId])));
    const orderLines = new Map((await this.store.lockOrderLines(tx, orderLineIds)).map((l) => [l.id, l] as const));
    const invoiced = await this.store.invoicedQty(tx, orderLineIds, null);
    const credited = await this.claims.creditedQty(tx, orderLineIds, claim.id);
    for (const orderLineId of orderLineIds) {
      const claimQty = Quantity.sum(claim.lines.filter((l) => l.purchaseOrderLineId === orderLineId).map((l) => Quantity.parse(l.qtyRejectedBase)));
      const judged = judgeClaimCredit({
        received: Quantity.parse(orderLines.get(orderLineId)!.qtyReceived),
        invoiced: Quantity.parse(invoiced.get(orderLineId) ?? '0.000'),
        creditedByOtherClaims: Quantity.parse(credited.get(orderLineId) ?? '0.000'),
        claimQty,
      });
      if (!invoicedHere.has(orderLineId) || !judged.ok) throw new SupplierClaimInvalidError([{ field: '/originalInvoiceId', rule: 'CLAIM_NOT_INVOICED' }]);
    }
    const products = await this.refs.productsIn(tx, claim.lines.map((l) => l.productId));
    const drafts: Omit<InvoiceLineRecord, 'levies'>[] = claim.lines.map((l, i) => {
      const product = products.get(l.productId)!;
      return {
        id: this.nextId(),
        lineNo: lineNumber(i),
        productId: l.productId,
        description: `${product.name}: rejected at the door, ${l.rejectionReasonCode}`.slice(0, 200),
        purchaseOrderLineId: l.purchaseOrderLineId,
        goodsReceiptLineId: l.goodsReceiptLineId,
        uom: product.baseUom,
        qty: l.qtyRejectedBase,
        qtyBase: l.qtyRejectedBase,
        unitPricePesewas: 0n,
        lineNetPesewas: l.claimedValuePesewas,
        taxCategoryId: orderLines.get(l.purchaseOrderLineId)!.taxCategoryId,
        expenseCategory: null,
        qtyVariance: null,
        priceVariancePesewas: null,
        priceVarianceDirection: null,
        matchStatus: 'UNMATCHED',
        matchReasons: [],
        returnLocationId: null,
        returnStockUnitId: null,
        supplierClaimLineId: l.id,
      };
    });
    const taxed = await this.tax.calculateIn(tx, {
      taxInclusive: false,
      taxDate: body.invoiceDate,
      lines: drafts.map((l) => ({ lineRef: l.id, taxCategoryId: l.taxCategoryId, amountPesewas: l.lineNetPesewas })),
    });
    const calculated = new Map(taxed.lines.map((l) => [l.lineRef, l] as const));
    const lines: InvoiceLineRecord[] = drafts.map((draft) => ({
      ...draft,
      levies: calculated.get(draft.id)!.levies.map((levy) => ({
        levyId: levy.levyId,
        levyCode: levy.levyCode,
        levyName: levy.levyName,
        treatment: levy.treatment,
        ratePercent: levy.rate.toPercentString(),
        basePesewas: levy.base.pesewas,
        amountPesewas: levy.amount.pesewas,
        calculatedAmountPesewas: levy.amount.pesewas,
        isReclaimable: levy.isReclaimable,
        calcOrder: levy.calcOrder,
      })),
    }));
    const net = lines.reduce((sum, l) => sum + l.lineNetPesewas, 0n);
    const tax = lines.reduce((sum, l) => sum + l.levies.reduce((t, levy) => t + levy.amountPesewas, 0n), 0n);
    await this.judgeHeadroom(tx, original, net + tax, 0n);
    const supplierInvoiceNo = body.supplierInvoiceNo.trim();
    if (await this.store.supplierInvoiceNoTaken(tx, claim.supplierId, supplierInvoiceNo, null)) throw new DuplicateSupplierInvoiceError();
    const id = this.nextId();
    await this.documents.register(tx, { id, docType: DOC_TYPE, ownerModule: 'pur', branchId: original.branchId, actorId: actor.principalId });
    await this.store.insertInvoice(
      tx,
      id,
      {
        supplierInvoiceNo,
        invoiceDate: body.invoiceDate,
        dueDate: body.invoiceDate,
        fileId: null,
        taxSchemeVersionId: taxed.versionId,
        netPesewas: net,
        taxPesewas: tax,
        grossPesewas: net + tax,
        statedGrossPesewas: null,
        returnReasonCode: null,
        kind: 'CREDIT_NOTE',
        supplierId: original.supplierId,
        purchaseOrderId: original.purchaseOrderId,
        originalInvoiceId: original.id,
        branchId: original.branchId,
        supplierClaimId: claim.id,
      },
      lines,
      actor.principalId,
    );
    const view = await this.view(tx, id);
    await this.audit.record(tx, { module: 'pur', action: 'CREATE', entityType: 'SupplierInvoice', entityId: id, branchId: original.branchId, before: null, after: { ...view }, metadata: { supplierClaimId: claim.id } });
    return view;
  }

  /** A claim settled, once, by the invoice that left its goods out or its approved credit note (ADR-0076), audited. */
  async settleClaimIn(tx: Transaction, claim: ClaimRecord, settlement: 'INVOICE' | 'CREDIT_NOTE', invoiceId: string, actorId: string, at: Date): Promise<void> {
    await this.claims.settle(tx, claim.id, settlement, invoiceId, actorId, at);
    await this.audit.record(tx, {
      module: 'pur',
      action: 'SETTLE',
      entityType: 'SupplierClaim',
      entityId: claim.id,
      branchId: claim.branchId,
      before: { status: claim.status, settlement: claim.settlement, settledByInvoiceId: claim.settledByInvoiceId },
      after: { status: 'SETTLED', settlement, settledByInvoiceId: invoiceId },
    });
  }

  // Shared steps.

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
        const record = await this.store.invoice(tx, id);
        return record === null ? {} : { branchId: record.branchId };
      },
      work,
    ).catch(translatePurRefusal);
  }

  /** The invoice locked for a change; one waiting for its credit or variance approval refuses every change (A-172). */
  private async locked(tx: Transaction, id: string, allowed: ReadonlySet<InvoiceStatus>, version: number | null, pendingRequestId: string | null = null): Promise<InvoiceRecord> {
    const invoice = await this.store.lockInvoice(tx, id);
    if (invoice === null) throw new NotFoundError(`no supplier invoice ${id}`);
    if (version !== null && invoice.version !== version) throw new VersionConflictError(`supplier invoice ${id} is at version ${invoice.version}, not ${version}`);
    if (!allowed.has(invoice.status)) throw wrongStatus(`supplier invoice ${id}`, invoice.status);
    const pending = invoice.approvalRequestId !== null && (invoice.status === 'DRAFT' || invoice.status === 'MISMATCH');
    if (pendingRequestId === null && pending) throw new ApprovalPendingError(invoice.approvalRequestId!);
    if (pendingRequestId !== null && (!pending || invoice.approvalRequestId !== pendingRequestId)) throw wrongStatus(`supplier invoice ${id}`, invoice.status);
    return invoice;
  }

  private async orderFor(tx: Transaction, orderId: string | undefined, supplierId: string): Promise<OrderRecord | null> {
    if (orderId === undefined) return null;
    const order = await this.store.order(tx, orderId);
    if (order === null) throw new PurReferenceNotFoundError(['/purchaseOrderId']);
    if (order.supplierId !== supplierId) throw new SupplierInvoiceInvalidError([{ field: '/purchaseOrderId', rule: 'ORDER_OF_ANOTHER_SUPPLIER' }]);
    if (!INVOICEABLE.has(order.status)) throw new SupplierInvoiceInvalidError([{ field: '/purchaseOrderId', rule: 'ORDER_NOT_RECEIVABLE' }]);
    return order;
  }

  /** The supplier's payment terms in days (FR-PUR-001): what an invoice's due date defaults to after its date. */
  private async termsDays(tx: Transaction, supplierId: string): Promise<number> {
    return (await this.register.profile(tx, supplierId, false))?.paymentTermsDays ?? 0;
  }

  /** The header and lines an entry or a change makes: each line priced exactly, its levies calculated and as charged. */
  private async build(
    tx: Transaction,
    body: Pick<SupplierInvoiceCreate, 'supplierInvoiceNo' | 'invoiceDate' | 'dueDate' | 'fileId' | 'statedGrossPesewas' | 'returnReasonCode' | 'lines'>,
    order: OrderRecord | null,
    termsDays: number,
  ): Promise<{ header: InvoiceHeader; lines: InvoiceLineRecord[] }> {
    const broken: BrokenRule[] = [];
    const dueDate = body.dueDate ?? dueDateFrom(body.invoiceDate, termsDays);
    if (dueDate < body.invoiceDate) broken.push({ field: '/dueDate', rule: 'DUE_BEFORE_INVOICE' });
    if (body.fileId !== undefined) {
      const file = await this.files.find(tx, body.fileId);
      if (file === null) throw new PurReferenceNotFoundError(['/fileId']);
      if (file.purpose !== INVOICE_FILE || file.scanStatus !== 'CLEAN') broken.push({ field: '/fileId', rule: 'FILE_NOT_USABLE' });
    }
    if (body.lines.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
    const orderLines = new Map((order?.lines ?? []).map((l) => [l.id, l] as const));
    const products = await this.refs.productsIn(tx, [...body.lines.flatMap((l) => (l.productId === undefined ? [] : [l.productId])), ...(order?.lines ?? []).map((l) => l.productId)]);
    const missing = body.lines.flatMap((l, i) => (l.productId !== undefined && !products.has(l.productId) ? [`/lines/${i}/productId`] : []));
    if (missing.length > 0) throw new PurReferenceNotFoundError(missing);
    const drafts: Omit<InvoiceLineRecord, 'levies'>[] = [];
    for (const [i, input] of body.lines.entries()) {
      let product: ProductFacts | null = input.productId === undefined ? null : products.get(input.productId)!;
      let uom = product?.baseUom ?? null;
      if (input.purchaseOrderLineId !== undefined) {
        const orderLine = orderLines.get(input.purchaseOrderLineId);
        if (order === null) {
          broken.push({ field: `/lines/${i}/purchaseOrderLineId`, rule: 'ORDER_REQUIRED' });
          continue;
        }
        if (orderLine === undefined) {
          broken.push({ field: `/lines/${i}/purchaseOrderLineId`, rule: 'ORDER_LINE_NOT_ON_ORDER' });
          continue;
        }
        if (product !== null && product.id !== orderLine.productId) {
          broken.push({ field: `/lines/${i}/productId`, rule: 'PRODUCT_DIFFERS' });
          continue;
        }
        product = products.get(orderLine.productId)!;
        uom = orderLine.uom;
      }
      const qty = Quantity.parse(input.qty);
      let qtyBase: string | null = null;
      if (product !== null) {
        const base = await this.refs.toBaseIn(tx, product.id, uom!, qty);
        if (!base.ok) {
          broken.push({ field: `/lines/${i}/qty`, rule: base.error });
          continue;
        }
        qtyBase = base.value.toDecimalString();
      }
      const unitPrice = Money.ofPesewas(BigInt(input.unitPricePesewas));
      drafts.push({
        id: this.nextId(),
        lineNo: lineNumber(i),
        productId: product?.id ?? null,
        description: input.description,
        purchaseOrderLineId: input.purchaseOrderLineId ?? null,
        goodsReceiptLineId: input.goodsReceiptLineId ?? null,
        uom,
        qty: qty.toDecimalString(),
        qtyBase,
        unitPricePesewas: unitPrice.pesewas,
        lineNetPesewas: orderLineNet(unitPrice, qty).pesewas,
        taxCategoryId: input.taxCategoryId,
        expenseCategory: input.expenseCategory ?? null,
        qtyVariance: null,
        priceVariancePesewas: null,
        priceVarianceDirection: null,
        matchStatus: 'UNMATCHED',
        matchReasons: [],
        returnLocationId: input.returnFromLocationId ?? null,
        returnStockUnitId: input.returnStockUnitId ?? null,
      });
    }
    if (broken.length > 0) throw new SupplierInvoiceInvalidError(broken);
    const taxed = await this.tax.calculateIn(tx, {
      taxInclusive: false,
      taxDate: body.invoiceDate,
      lines: drafts.map((l) => ({ lineRef: l.id, taxCategoryId: l.taxCategoryId, amountPesewas: l.lineNetPesewas })),
    });
    const calculated = new Map(taxed.lines.map((l) => [l.lineRef, l] as const));
    const lines: InvoiceLineRecord[] = drafts.map((draft, i) => {
      const breakdown = calculated.get(draft.id)!;
      const charged = new Map<string, bigint>();
      for (const [n, levy] of (body.lines[i]!.leviesCharged ?? []).entries()) {
        if (charged.has(levy.levyId)) broken.push({ field: `/lines/${i}/leviesCharged/${n}/levyId`, rule: 'LEVY_REPEATED' });
        else if (!breakdown.levies.some((l) => l.levyId === levy.levyId)) broken.push({ field: `/lines/${i}/leviesCharged/${n}/levyId`, rule: 'LEVY_NOT_IN_SCHEME' });
        charged.set(levy.levyId, BigInt(levy.amountPesewas));
      }
      return {
        ...draft,
        levies: breakdown.levies.map((levy) => ({
          levyId: levy.levyId,
          levyCode: levy.levyCode,
          levyName: levy.levyName,
          treatment: levy.treatment,
          ratePercent: levy.rate.toPercentString(),
          basePesewas: levy.base.pesewas,
          amountPesewas: charged.get(levy.levyId) ?? levy.amount.pesewas,
          calculatedAmountPesewas: levy.amount.pesewas,
          isReclaimable: levy.isReclaimable,
          calcOrder: levy.calcOrder,
        })),
      };
    });
    const net = lines.reduce((sum, l) => sum + l.lineNetPesewas, 0n);
    const tax = lines.reduce((sum, l) => sum + l.levies.reduce((s, levy) => s + levy.amountPesewas, 0n), 0n);
    const stated = body.statedGrossPesewas === undefined ? null : BigInt(body.statedGrossPesewas);
    if (stated !== null && stated !== net + tax) broken.push({ field: '/statedGrossPesewas', rule: 'STATED_TOTAL_DIFFERS' });
    if (broken.length > 0) throw new SupplierInvoiceInvalidError(broken);
    return {
      header: {
        supplierInvoiceNo: body.supplierInvoiceNo.trim(),
        invoiceDate: body.invoiceDate,
        dueDate,
        fileId: body.fileId ?? null,
        taxSchemeVersionId: taxed.versionId,
        netPesewas: net,
        taxPesewas: tax,
        grossPesewas: net + tax,
        statedGrossPesewas: stated,
        returnReasonCode: body.returnReasonCode ?? null,
      },
      lines,
    };
  }

  /** Each line's match against its order line, with the receipt as it stands and what other live invoices hold. */
  private async matched(tx: Transaction, invoice: InvoiceRecord): Promise<LineMatchRecord[]> {
    const orderLineIds = [...new Set(invoice.lines.flatMap((l) => (l.purchaseOrderLineId === null ? [] : [l.purchaseOrderLineId])))];
    const orderLines = new Map((await this.store.lockOrderLines(tx, orderLineIds)).map((l) => [l.id, l] as const));
    const elsewhere = await this.store.invoicedQty(tx, orderLineIds, invoice.id);
    const claimed = await this.claims.claimedQty(tx, orderLineIds);
    // Lines of this invoice on one order line count against each other too, in line order.
    const heldHere = new Map<string, Quantity>();
    return invoice.lines.map((line) => {
      const orderLine = line.purchaseOrderLineId === null ? undefined : orderLines.get(line.purchaseOrderLineId);
      const already = orderLine === undefined ? Quantity.zero() : Quantity.parse(elsewhere.get(orderLine.id) ?? '0.000').plus(heldHere.get(orderLine.id) ?? Quantity.zero());
      const result = matchLine({
        productId: line.productId,
        qtyBase: line.qtyBase === null ? null : Quantity.parse(line.qtyBase),
        unitPrice: Money.ofPesewas(line.unitPricePesewas),
        levies: line.levies.map((levy) => ({ charged: Money.ofPesewas(levy.amountPesewas), calculated: Money.ofPesewas(levy.calculatedAmountPesewas) })),
        order:
          orderLine === undefined
            ? null
            : {
                productId: orderLine.productId,
                unitPrice: Money.ofPesewas(orderLine.unitPricePesewas),
                qtyReceived: Quantity.parse(orderLine.qtyReceived),
                qtyInvoicedElsewhere: already,
                qtyClaimed: Quantity.parse(claimed.get(orderLine.id) ?? '0.000'),
              },
      });
      if (orderLine !== undefined && line.qtyBase !== null) heldHere.set(orderLine.id, (heldHere.get(orderLine.id) ?? Quantity.zero()).plus(Quantity.parse(line.qtyBase)));
      return {
        lineId: line.id,
        matchStatus: result.status,
        reasons: result.reasons,
        qtyVariance: result.qtyVariance?.toDecimalString() ?? null,
        priceVariancePesewas: result.priceVariance?.pesewas ?? null,
        priceVarianceDirection: result.priceVarianceDirection,
      };
    });
  }

  private async view(tx: Transaction, id: string): Promise<SupplierInvoiceView> {
    return (await this.views(tx, [(await this.store.invoice(tx, id))!]))[0]!;
  }

  private async audited(tx: Transaction, action: string, before: InvoiceRecord, metadata: Record<string, unknown> = {}): Promise<SupplierInvoiceView> {
    const beforeView = (await this.views(tx, [before]))[0]!;
    const view = await this.view(tx, before.id);
    await this.audit.record(tx, {
      module: 'pur',
      action,
      entityType: 'SupplierInvoice',
      entityId: before.id,
      branchId: before.branchId,
      before: { ...beforeView },
      after: { ...view },
      metadata: JSON.parse(JSON.stringify(metadata)),
    });
    return view;
  }

  /** Each line at its order price, for 2010 and 5140, and each levy row with its reclaimable flag (FR-PUR-015). */
  private async postingParts(tx: Transaction, invoice: InvoiceRecord): Promise<Pick<SupplierInvoiceApproved, 'lines' | 'levies'>> {
    const orderLines = new Map((await this.store.lockOrderLines(tx, invoice.lines.flatMap((l) => (l.purchaseOrderLineId === null ? [] : [l.purchaseOrderLineId])))).map((l) => [l.id, l] as const));
    // An invoice line carrying a claimed quantity beyond what was received clears 2010 for the received part only: the
    // claimed part never entered stock (ADR-0076). Every other line is valued as before.
    const variances = invoice.kind === 'INVOICE' ? new Map((await this.matched(tx, invoice)).map((r) => [r.lineId, r.qtyVariance] as const)) : new Map<string, string | null>();
    const orderValue = (l: InvoiceLineRecord, price: Money): Money => {
      const variance = variances.get(l.id) ?? null;
      const claimedQty = l.qtyBase === null ? Quantity.zero() : claimedPart(variance === null ? null : Quantity.parse(variance), Quantity.parse(l.qtyBase));
      return claimedQty.isZero() ? orderLineNet(price, Quantity.parse(l.qty)) : receivedPartValue(price, Quantity.parse(l.qty), Quantity.parse(l.qtyBase!), claimedQty);
    };
    return {
      lines: invoice.lines.map((l) => {
        const orderLine = l.purchaseOrderLineId === null ? undefined : orderLines.get(l.purchaseOrderLineId);
        return {
          lineNo: l.lineNo,
          productId: l.productId,
          purchaseOrderLineId: l.purchaseOrderLineId,
          expenseCategory: l.expenseCategory,
          taxCategoryId: l.taxCategoryId,
          netPesewas: pesewas(l.lineNetPesewas),
          orderValuePesewas: orderLine === undefined ? null : pesewas(orderValue(l, Money.ofPesewas(orderLine.unitPricePesewas)).pesewas),
        };
      }),
      levies: invoice.lines.flatMap((l) => l.levies.map((levy) => ({ lineNo: l.lineNo, levyId: levy.levyId, levyCode: levy.levyCode, amountPesewas: pesewas(levy.amountPesewas), isReclaimable: levy.isReclaimable }))),
    };
  }

  /** ◆ The ledger event of an approved invoice (FR-PUR-015), matched or on an approved variance (FR-PUR-010). */
  private async publishApproved(tx: Transaction, invoice: InvoiceRecord, view: SupplierInvoiceView, varianceApprovalRequestId: string | null): Promise<void> {
    const payload: SupplierInvoiceApproved = {
      supplierInvoiceId: invoice.id,
      supplierId: invoice.supplierId,
      supplierInvoiceNo: invoice.supplierInvoiceNo,
      purchaseOrderId: invoice.purchaseOrderId,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      netPesewas: view.netPesewas,
      taxPesewas: view.taxPesewas,
      grossPesewas: view.grossPesewas,
      ...(await this.postingParts(tx, invoice)),
      varianceApprovalRequestId,
    };
    await this.events.publish<SupplierInvoiceApproved>(tx, {
      type: invoice.purchaseOrderId === null ? 'pur.ExpenseInvoiceApproved' : 'pur.SupplierInvoiceMatched',
      subjectType: 'SupplierInvoice',
      subjectId: invoice.id,
      branchId: invoice.branchId,
      payload,
    });
  }
}

/** An invoice carries no credit note fields: no original, no return reason and no line sending goods back. */
function refuseCreditFields(body: { readonly originalInvoiceId?: string | undefined; readonly returnReasonCode?: string | undefined; readonly lines?: readonly InvoiceLineInput[] | undefined }): void {
  const broken: BrokenRule[] = [];
  if (body.originalInvoiceId !== undefined) broken.push({ field: '/originalInvoiceId', rule: 'NOT_FOR_INVOICE' });
  if (body.returnReasonCode !== undefined) broken.push({ field: '/returnReasonCode', rule: 'NOT_FOR_INVOICE' });
  for (const [i, line] of (body.lines ?? []).entries()) {
    if (line.returnFromLocationId !== undefined || line.returnStockUnitId !== undefined) broken.push({ field: `/lines/${i}/returnFromLocationId`, rule: 'NOT_FOR_INVOICE' });
  }
  if (broken.length > 0) throw new SupplierInvoiceInvalidError(broken);
}

/** A stored line as the input that would make it again, for a change that keeps the lines. */
function inputOf(line: InvoiceLineRecord): InvoiceLineInput {
  return {
    productId: line.purchaseOrderLineId === null ? (line.productId ?? undefined) : undefined,
    description: line.description,
    purchaseOrderLineId: line.purchaseOrderLineId ?? undefined,
    goodsReceiptLineId: line.goodsReceiptLineId ?? undefined,
    qty: line.qty,
    unitPricePesewas: pesewas(line.unitPricePesewas),
    taxCategoryId: line.taxCategoryId,
    leviesCharged: line.levies.map((levy) => ({ levyId: levy.levyId, amountPesewas: pesewas(levy.amountPesewas) })),
    expenseCategory: line.expenseCategory ?? undefined,
    returnFromLocationId: line.returnLocationId ?? undefined,
    returnStockUnitId: line.returnStockUnitId ?? undefined,
  };
}
