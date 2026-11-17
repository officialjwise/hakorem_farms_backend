import { createHash } from 'node:crypto';
import { escPosWithReprintMarker } from '../../../platform/documents/escpos-writer';
import { withReprintMarker } from '../../../platform/documents/pdf-writer';
import { createUuidV7Generator, Money, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { databaseErrorOf, IsolationLevelError, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { NotFoundError, UnauthenticatedError } from '../../../platform/errors/api-error';
import type { AsyncConsumer, DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { DocumentNotArchivedError, DOCUMENT_ARCHIVED, type DocumentArchived, type Documents } from '../../doc';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { MasterDataRefs, TaxService } from '../../mdm';
import {
  checkIssue,
  correctable,
  documentTotals,
  fiscalYearOf,
  levyTotals,
  lineAnchor,
  noteReasonRule,
  planCreditLines,
  priceVariance,
  seriesLockKey,
  type BillingKind,
  type BrokenRule,
  type LineKind,
  type LinePricing,
  creditRefundableOf,
} from '../domain/billing';
import { lineNumber, pageProbe } from '../domain/line-numbers';
import { renderDataOf } from '../domain/render-data';
import type { BillingDocumentPayload, CreditNoteIssued, DebitNoteIssued } from '../events';
import type { BillingStore, DocumentFilter, DocumentRecord, DraftHeader, LevyRecord, LineRecord, OpenItemFilter, OpenItemRecord, ReprintRecord, SettlementRecord } from './billing-store';
import { AllocationExceedsOutstandingError, BilReferenceNotFoundError, BillingDocumentInvalidError, CreditNoteExceedsOriginalError } from './errors';

export const CREDIT_NOTE_KIND = 'CREDIT_NOTE';
/** THREAT_MODEL section 4, case 31: a customer credit note used to take money or hide a shortage (A-200). */
export const CREDIT_NOTE_ABUSE_CASE = 31;
export const INVOICE_ISSUED = 'bil.InvoiceIssued';
export const CREDIT_NOTE_ISSUED = 'bil.CreditNoteIssued';
export const DEBIT_NOTE_ISSUED = 'bil.DebitNoteIssued';
export const PROFORMA_ISSUED = 'bil.ProformaIssued';
/** BIL's ◆ events, declared to the bus so the boot assertion holds FIN to a handler and rules for each (ADR-0056). */
export const BIL_LEDGER_EVENTS = [INVOICE_ISSUED, CREDIT_NOTE_ISSUED, DEBIT_NOTE_ISSUED] as const;
const READ = 'bil.document.read';
const CREDIT = 'bil.credit_note.create';
/** The reasons a credit note raised on its own takes (A-200 (c)). */
const CREDIT_REASON_DOMAINS = ['REFUND', 'RETURN'] as const;
/** A credit note issued in a higher module's approved correction may also give a sale's void reason. */
const IN_TRANSACTION_CREDIT_REASON_DOMAINS = ['REFUND', 'RETURN', 'VOID'] as const;
const DEBIT = 'bil.debit_note.create';
const REPRINT = 'bil.document.reprint';
const BILLING_KINDS: readonly string[] = ['PROFORMA', 'INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE'];
/** The determination group of a charge with no product: by-products and other goods (4030, A-200). */
const OTHER_GROUP = 'OTHER';
const DELIVERY_GROUP = 'SERVICE';
const ONE = '1.000';
const ADJUSTMENT_UOM = 'UNIT';

/** One line of a sale to bill, as the selling module priced it (ADR-0001, ADR-0021). */
export interface IssueLineRequest {
  readonly lineKind: LineKind;
  readonly productId?: string | null;
  /** As printed; a product line defaults to the product's name. */
  readonly description?: string;
  /** The animal or lot sold, as INV names it, for traceability from the invoice. */
  readonly stockUnit?: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' } | null;
  readonly orderLineRef?: string | null;
  /** Decimal string, three places; for a catch-weight line, the weighed kilograms (FR-BIL-005). */
  readonly quantity: string;
  /** A product line defaults to the product's base unit. */
  readonly uom?: string;
  readonly weightKg?: string | null;
  readonly unitPricePesewas: bigint;
  /** What the engine or quote resolved; defaults to the agreed price. */
  readonly resolvedUnitPricePesewas?: bigint;
  readonly discountPesewas?: bigint;
  /** A product line defaults to the product's tax category. */
  readonly taxCategoryId?: string;
}

/** What `issueIn` bills: an invoice, a receipt or a proforma, in the caller's serializable transaction. */
export interface IssueRequest {
  readonly kind: 'INVOICE' | 'RECEIPT' | 'PROFORMA';
  readonly branchId: string;
  readonly customerId?: string | null;
  readonly customerTin?: string | null;
  readonly billingAddress?: string | null;
  readonly orderDocumentId?: string | null;
  readonly dueDate?: string | null;
  readonly taxInclusive: boolean;
  /** The reference an offline device printed (ADR-0015), stored beside the official number. */
  readonly provisionalRef?: string | null;
  readonly occurredAt?: Date | null;
  readonly lines: readonly IssueLineRequest[];
}

export interface CreditNoteRequest {
  readonly reasonCode: string;
  readonly note?: string | undefined;
  readonly lines: readonly { readonly lineId: string; readonly quantity?: string | undefined; readonly amountPesewas?: number | undefined }[];
}

export interface DebitNoteRequest {
  readonly reasonCode: string;
  readonly note?: string | undefined;
  readonly lines: readonly { readonly description: string; readonly amountPesewas: number; readonly taxCategoryId: string }[];
}

type Ref = { readonly id: string; readonly docType: string; readonly number: string | null };

/** The contract's `BillingDocument`. */
export interface BillingDocumentView {
  readonly id: string;
  readonly kind: BillingKind;
  readonly status: 'DRAFT' | 'ISSUED';
  readonly documentNo: string | null;
  readonly provisionalRef: string | null;
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string } | null;
  readonly customerName: string | null;
  readonly customerTin: string | null;
  readonly billingAddress: string | null;
  readonly order: Ref | null;
  readonly originalDocument: Ref | null;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly taxInclusive: boolean;
  readonly taxSchemeVersionId: string;
  readonly netPesewas: number;
  readonly taxPesewas: number;
  readonly grossPesewas: number;
  readonly currency: 'GHS';
  readonly levyTotals: readonly { readonly levyCode: string; readonly levyName: string; readonly amountPesewas: number }[];
  readonly lines: readonly BillingLineView[];
  readonly settlement: {
    readonly allocatedPesewas: number;
    readonly creditedPesewas: number;
    readonly outstandingPesewas: number;
    readonly refundedPesewas: number;
    readonly refundablePesewas: number;
    readonly paymentStatus: SettlementRecord['paymentStatus'];
    readonly settledAt: string | null;
    readonly asOf: string;
  };
  readonly certification: { readonly certifiedTaxPesewas: number; readonly certifiedGrossPesewas: number; readonly reference: string } | null;
  readonly reasonCode: string | null;
  readonly archivedDocumentId: string | null;
  readonly contentHash: string | null;
  readonly issuedAt: string | null;
  readonly occurredAt: string | null;
  readonly reprintCount: number;
  readonly branchId: string;
}

export interface BillingLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly lineKind: LineKind;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string } | null;
  readonly description: string;
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' } | null;
  readonly quantity: string;
  readonly uom: string;
  readonly weightKg: string | null;
  readonly unitPricePesewas: number;
  readonly resolvedUnitPricePesewas: number;
  readonly discountPesewas: number;
  readonly taxCategory: { readonly id: string; readonly code: string; readonly name: string };
  readonly lineNetPesewas: number;
  readonly lineTaxPesewas: number;
  readonly lineGrossPesewas: number;
  readonly levies: readonly {
    readonly levyCode: string;
    readonly levyName: string;
    readonly treatment: LevyRecord['treatment'];
    readonly ratePercent: string;
    readonly basePesewas: number;
    readonly amountPesewas: number;
  }[];
}

export interface ApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: string;
  readonly subject: { readonly id: string; readonly docType: string; readonly number: null };
  readonly summary: string;
  readonly requestedAt: string;
}

/** The contract's `ReprintResult`: the archived bytes with the marker, inline (A-202). */
export interface ReprintView {
  readonly copyNo: number;
  readonly channel: 'THERMAL' | 'PDF';
  readonly url: null;
  readonly escPosBase64: string | null;
  readonly pdfBase64: string | null;
  readonly expiresAt: null;
}

/** The contract's `ReprintLog`. */
export interface ReprintLogView {
  readonly copyNo: number;
  readonly channel: ReprintRecord['channel'];
  readonly actor: PrincipalRef;
  readonly recordedAt: string;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

export type DocumentQuery = Omit<DocumentFilter, 'branchIds'>;

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();

/** A line with its pricing figures as the tax calculator needs them. */
interface PricedLine {
  readonly ref: string;
  readonly record: Omit<LineRecord, 'lineNetPesewas' | 'lineTaxPesewas' | 'lineGrossPesewas' | 'levies'>;
  readonly anchor: Money;
  readonly variance: bigint;
}

/**
 * Billing (FR-BIL-001 to FR-BIL-012, ADR-0015, ADR-0020): invoices, receipts and proformas issued by a selling module
 * through `issueIn` in its own serializable transaction, and credit and debit notes against them. Every document's
 * levy rows come from MDM's tax calculator; its number is allocated by `platform.allocate_number` in the issuing
 * transaction, so a rollback leaves no gap; its totals are sums of its line integers; once issued it never changes
 * (the database holds all three). Issuing publishes the document's ◆ event and the ledger posts it in the same
 * transaction. Credit notes wait for a different person's approval (`CREDIT_NOTE`).
 */
export class Billing {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: BillingStore,
    private readonly refs: MasterDataRefs,
    private readonly tax: TaxService,
    private readonly numbers: NumberSeries,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly approvals: Approvals,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly archive: Documents,
    private readonly principals: PrincipalNames,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /**
   * The locks a command names in `seriesLocks` before it issues a document of this kind today at the branch, so that
   * concurrent issuers queue instead of retrying (ADR-0005, A-186): the document's series, and the journal's for a
   * kind that posts.
   */
  seriesLocksFor(kind: BillingKind, branchId: string, register?: string): string[] {
    const today = toBusinessDate(this.clock.now());
    const own = seriesLockKey(kind, branchId, today, register);
    return kind === 'PROFORMA' ? [own] : [own, `JOURNAL:${fiscalYearOf(today)}:${branchId}`];
  }

  /**
   * Issues an invoice, a receipt or a proforma in the caller's serializable transaction (the port B9a's sale posting
   * calls, like `TaxService.calculateIn`). It authorises nothing: the caller's command has authorised the sale. The
   * number is allocated in this transaction, so if the caller rolls back the number returns to the series.
   */
  async issueIn(tx: Transaction, actor: Actor | undefined, request: IssueRequest): Promise<BillingDocumentView> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    if (actor === undefined) throw new UnauthenticatedError('a billing document needs an actor');
    const issueDate = toBusinessDate(this.clock.now());
    const customerId = request.customerId ?? null;
    const broken = checkIssue({ kind: request.kind, customerId, issueDate, dueDate: request.dueDate ?? null, lineCount: request.lines.length });
    const customer = customerId === null ? undefined : (await this.refs.customersIn(tx, [customerId])).get(customerId);
    const missing: string[] = [];
    if (customerId !== null && customer === undefined) missing.push('/customerId');
    else if (customer !== undefined && !customer.isLive) broken.push({ field: '/customerId', rule: 'CUSTOMER_NOT_ACTIVE' });
    if ((await this.refs.branchesIn(tx, [request.branchId])).size === 0) missing.push('/branchId');
    const productIds = request.lines.flatMap((l) => (l.productId === undefined || l.productId === null ? [] : [l.productId]));
    const products = await this.refs.productsIn(tx, productIds);
    const priced: PricedLine[] = [];
    request.lines.forEach((line, i) => {
      const field = `/lines/${i}`;
      const product = line.productId === undefined || line.productId === null ? undefined : products.get(line.productId);
      if (line.productId !== undefined && line.productId !== null && product === undefined) {
        missing.push(`${field}/productId`);
        return;
      }
      if ((line.lineKind === 'PRODUCT') !== (product !== undefined)) broken.push({ field: `${field}/productId`, rule: 'PRODUCT_LINE_NEEDS_PRODUCT' });
      const taxCategoryId = line.taxCategoryId ?? product?.taxCategoryId;
      const description = (line.description ?? product?.name ?? '').trim();
      if (taxCategoryId === undefined) broken.push({ field: `${field}/taxCategoryId`, rule: 'TAX_CATEGORY_REQUIRED' });
      if (description === '') broken.push({ field: `${field}/description`, rule: 'DESCRIPTION_REQUIRED' });
      const quantity = Quantity.parse(line.quantity);
      if (quantity.isZero() || quantity.isNegative()) {
        broken.push({ field: `${field}/quantity`, rule: 'QUANTITY_NOT_POSITIVE' });
        return;
      }
      const pricing: LinePricing = {
        unitPrice: Money.ofPesewas(line.unitPricePesewas),
        resolvedUnitPrice: Money.ofPesewas(line.resolvedUnitPricePesewas ?? line.unitPricePesewas),
        quantity,
        discount: Money.ofPesewas(line.discountPesewas ?? 0n),
      };
      const anchor = lineAnchor(pricing);
      if (anchor === null) {
        broken.push({ field: `${field}/discountPesewas`, rule: 'DISCOUNT_EXCEEDS_LINE' });
        return;
      }
      if (taxCategoryId === undefined || description === '') return;
      priced.push({
        ref: String(lineNumber(i)),
        anchor,
        variance: priceVariance(pricing),
        record: {
          id: this.nextId(),
          lineNo: lineNumber(i),
          lineKind: line.lineKind,
          productId: product?.id ?? null,
          description,
          stockUnit: line.stockUnit ?? null,
          orderLineRef: line.orderLineRef ?? null,
          creditsLineId: null,
          qty: quantity.toDecimalString(),
          uom: line.uom ?? product?.baseUom ?? ADJUSTMENT_UOM,
          weightKg: line.weightKg ?? null,
          unitPricePesewas: pricing.unitPrice.pesewas,
          resolvedUnitPricePesewas: pricing.resolvedUnitPrice.pesewas,
          discountPesewas: pricing.discount.pesewas,
          taxCategoryId,
          glGroup: product?.glGroup ?? (line.lineKind === 'DELIVERY_FEE' ? DELIVERY_GROUP : OTHER_GROUP),
        },
      });
    });
    if (missing.length > 0) throw new BilReferenceNotFoundError(missing);
    if (broken.length > 0) throw new BillingDocumentInvalidError(broken);
    const { versionId, lines } = await this.taxed(tx, request.taxInclusive, issueDate, priced);
    const header: DraftHeader = {
      id: this.nextId(),
      kind: request.kind,
      branchId: request.branchId,
      provisionalRef: request.provisionalRef ?? null,
      customerId,
      customerName: customer?.name ?? null,
      customerTin: request.customerTin ?? null,
      billingAddress: request.billingAddress ?? null,
      orderDocumentId: request.orderDocumentId ?? null,
      originalDocumentId: null,
      issueDate,
      dueDate: request.dueDate ?? null,
      taxInclusive: request.taxInclusive,
      taxSchemeVersionId: versionId,
      reasonCode: null,
      note: null,
      occurredAt: request.occurredAt ?? null,
      actorId: actor.principalId,
    };
    await this.writeDraft(tx, header, lines);
    return this.issueDraft(tx, header.id, actor.principalId, null, new Map(priced.map((p) => [p.record.id, p.variance] as const)));
  }

  /**
   * A payment's allocation applied to, or taken off, an issued invoice, receipt or debit note's settlement summary, in
   * the allocating transaction (A-200): the port PAY calls, so BIL alone writes `bil.document_settlement`. The database
   * refuses an allocation beyond the document's outstanding amount (`ck_document_settlement_outstanding`), which arrives
   * as `AllocationExceedsOutstandingError`. Answers what the document has left outstanding. It authorises nothing. The
   * summary is settled and as of this clock's instant, passed in (ADR-0067).
   */
  async settleIn(tx: Transaction, documentId: string, amountPesewas: bigint, direction: 'APPLY' | 'UNAPPLY'): Promise<bigint> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    try {
      const { rows } = await tx.query<{ outstanding: string }>('SELECT bil.apply_settlement($1, $2, $3, $4)::text AS outstanding', [documentId, amountPesewas.toString(), direction, this.clock.now()]);
      return BigInt(rows[0]!.outstanding);
    } catch (error) {
      const failure = databaseErrorOf(error);
      if (failure?.code === 'HK010' && failure.constraint === 'ck_document_settlement_outstanding') throw new AllocationExceedsOutstandingError(documentId);
      throw error;
    }
  }

  /**
   * The open items PAY's `listOpenItems` shows (FR-PAY-009): issued invoices, receipts and debit notes with something
   * outstanding at the branches given, newest first, with the total outstanding over everything the filter matches.
   * Read in the caller's transaction; it authorises nothing.
   */
  async openItemsIn(tx: Transaction, filter: OpenItemFilter, beforeId: string | null, limit: number): Promise<{ readonly rows: OpenItemRecord[]; readonly totalOutstandingPesewas: bigint }> {
    if (filter.branchIds.length === 0) return { rows: [], totalOutstandingPesewas: 0n };
    return this.store.openItems(tx, filter, beforeId, limit);
  }

  /** Documents by id as the contract shows them, in the caller's transaction; unknown ids are absent. It authorises nothing (ORD's order view, A-224). */
  async viewsIn(tx: Transaction, ids: readonly string[]): Promise<BillingDocumentView[]> {
    if (ids.length === 0) return [];
    return this.views(tx, await this.store.documents(tx, ids));
  }

  /**
   * What a payment needs to know of the documents it would settle, read in the caller's transaction (A-210): kind,
   * status, branch, customer, number and what each has outstanding. Unknown ids are absent. It authorises nothing.
   */
  async settleableIn(tx: Transaction, ids: readonly string[]): Promise<Map<string, SettleableDocument>> {
    if (ids.length === 0) return new Map();
    const records = await this.store.documents(tx, ids);
    const settlements = await this.store.settlements(tx, [...new Set(records.flatMap((r) => (r.originalDocumentId === null ? [r.id] : [r.id, r.originalDocumentId])))]);
    return new Map(
      records.map((r) => {
        const settlement = settlements.get(r.id);
        const refundable = settlement === undefined ? 0n : refundableOf(r, settlement, r.originalDocumentId === null ? undefined : settlements.get(r.originalDocumentId));
        return [
          r.id,
          {
            id: r.id,
            kind: r.kind,
            status: r.status,
            branchId: r.branchId,
            customerId: r.customerId,
            documentNo: r.documentNo,
            outstandingPesewas: settlement?.outstandingPesewas ?? 0n,
            originalDocumentId: r.originalDocumentId,
            createdBy: r.createdBy,
            refundablePesewas: refundable,
          },
        ] as const;
      }),
    );
  }

  list(actor: Actor | undefined, query: DocumentQuery, cursor: string | undefined, limit: number): Promise<Page<BillingDocumentView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const filters = { ...query };
      const binding = { operationId: 'listBillingDocuments', principalId: actor!.principalId, filters };
      const afterId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const ids = await this.store.list(tx, { ...query, branchIds }, afterId, pageProbe(limit));
      const data = await this.views(tx, await this.store.documents(tx, ids.slice(0, limit)));
      const hasMore = ids.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<BillingDocumentView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const record = await this.documentOf(tx, id, false);
      await this.authoriser.authorise(tx, actor, READ, { branchId: record.branchId });
      return (await this.views(tx, [record]))[0]!;
    });
  }

  /**
   * `issueCreditNote` (FR-BIL-007): a credit note against an issued invoice or receipt, never more than it has left
   * uncredited, its levies recomputed by the original's scheme from what it credits. It is drafted and waits for a
   * holder of `bil.credit_note.approve` other than its maker (`CREDIT_NOTE`, every amount, A-200); the approval
   * issues and posts it. Answers 202, or 201 if the policy ever lets one through at once.
   */
  issueCreditNote(actor: Actor | undefined, originalId: string, body: CreditNoteRequest, idempotencyKey: string): Promise<StoredResponse<BillingDocumentView | ApprovalPendingView>> {
    const locks = (branchId: string) => this.seriesLocksFor('CREDIT_NOTE', branchId);
    return this.command<CreditNoteRequest, BillingDocumentView | ApprovalPendingView>(actor, CREDIT, 'issueCreditNote', originalId, body, idempotencyKey, locks, async (tx, original) => {
      const { header, gross } = await this.draftCreditIn(tx, original, body, actor!.principalId, CREDIT_REASON_DOMAINS);
      const judged = await this.approvals.judgeIn(tx, CREDIT_NOTE_KIND, original.branchId, gross);
      if (!judged.required) {
        return { status: 201, body: await this.issueDraft(tx, header.id, actor!.principalId, null) };
      }
      const [draft] = await this.store.documents(tx, [header.id]);
      const summary = `Credit ${gross} pesewas against ${original.documentNo} to ${original.customerName ?? 'a walk-in customer'} (${body.reasonCode})`;
      const request = await this.approvals.request(tx, actor, {
        kind: CREDIT_NOTE_KIND,
        branchId: original.branchId,
        subjectDocumentId: header.id,
        payloadHash: draftHash(draft!),
        amountPesewas: gross,
        summary,
      });
      await this.store.markPending(tx, header.id, request.id, actor!.principalId);
      await this.audit.record(tx, {
        module: 'bil',
        action: 'SUBMIT',
        entityType: 'BillingDocument',
        entityId: header.id,
        branchId: original.branchId,
        before: null,
        after: { ...auditShape(draft!), approvalRequestId: request.id },
      });
      return {
        status: 202,
        body: {
          status: 'PENDING_APPROVAL',
          approvalRequestId: request.id,
          kind: CREDIT_NOTE_KIND,
          subject: { id: header.id, docType: 'CREDIT_NOTE', number: null },
          summary,
          requestedAt: request.requestedAt.toISOString(),
        },
      };
    });
  }

  /**
   * A credit note issued at once in the caller's serializable transaction, the correction of a higher module's own
   * approved document (ORD's void of a sale, B09a continued 2c): the caller has authorised its command and decided, with
   * its own approval by a different person, that the credit may be made, so no `CREDIT_NOTE` approval is asked here.
   * The same rules hold as `issueCreditNote`'s: an issued invoice or receipt, never more than it has left uncredited,
   * its levies recomputed by the original's scheme; a `VOID` reason is admitted beside `REFUND` and `RETURN`. The
   * caller declares `seriesLocksFor('CREDIT_NOTE', branch)`. It authorises nothing.
   */
  async creditIn(tx: Transaction, actorId: string, originalId: string, body: CreditNoteRequest, approvalRequestId: string): Promise<BillingDocumentView> {
    return translateRefusal(async () => {
      const original = await this.documentOf(tx, originalId, true);
      if (!correctable(original)) throw new BillingDocumentInvalidError([{ field: null, rule: 'ORIGINAL_NOT_CORRECTABLE' }]);
      const { header } = await this.draftCreditIn(tx, original, body, actorId, IN_TRANSACTION_CREDIT_REASON_DOMAINS);
      return this.issueDraft(tx, header.id, actorId, approvalRequestId);
    });
  }

  /** An issued document's lines by the order line each was raised for (ORD's returns, A-228). It authorises nothing. */
  async linesByOrderLineIn(tx: Transaction, documentId: string): Promise<ReadonlyMap<string, string>> {
    const [record] = await this.store.documents(tx, [documentId]);
    return new Map((record?.lines ?? []).flatMap((l) => (l.orderLineRef === null ? [] : [[l.orderLineRef, l.id] as const])));
  }

  /**
   * What a credit note of these lines would take back of an issued original, by `issueCreditNote`'s rules, without
   * writing anything: each credited line's gross and the total (ORD's return before it is approved, A-228). It refuses
   * as the credit would. It authorises nothing.
   */
  async creditPreviewIn(tx: Transaction, originalId: string, body: CreditNoteRequest): Promise<CreditPreview> {
    return translateRefusal(async () => {
      const original = await this.documentOf(tx, originalId, false);
      if (!correctable(original)) throw new BillingDocumentInvalidError([{ field: null, rule: 'ORIGINAL_NOT_CORRECTABLE' }]);
      const { lines, gross } = await this.planCreditIn(tx, original, body, IN_TRANSACTION_CREDIT_REASON_DOMAINS);
      return { grossPesewas: gross, lines: lines.map((l) => ({ lineId: l.creditsLineId!, grossPesewas: l.lineGrossPesewas })) };
    });
  }

  /** The credit note's draft against an issued original, written and not yet issued, with its gross. */
  private async draftCreditIn(tx: Transaction, original: DocumentRecord, body: CreditNoteRequest, makerId: string, domains: readonly string[]): Promise<{ readonly header: DraftHeader; readonly gross: bigint }> {
    const { versionId, lines, gross } = await this.planCreditIn(tx, original, body, domains);
    // Never due before it is drafted, as a debit note (A-223): a credit against an overdue invoice is due today.
    const today = toBusinessDate(this.clock.now());
    const due = original.dueDate === null ? null : original.dueDate < today ? today : original.dueDate;
    const header = this.noteHeader(original, 'CREDIT_NOTE', versionId, body.reasonCode, body.note, makerId, due);
    await this.writeDraft(tx, header, lines);
    return { header, gross };
  }

  /** The credit note's lines against an issued original, priced and taxed by the original's terms, and its gross. */
  private async planCreditIn(tx: Transaction, original: DocumentRecord, body: CreditNoteRequest, domains: readonly string[]): Promise<{ readonly versionId: string; readonly lines: LineRecord[]; readonly gross: bigint }> {
    const reason = (await this.refs.reasonCodesIn(tx, [body.reasonCode])).get(body.reasonCode);
    const broken: BrokenRule[] = [...noteReasonRule('CREDIT_NOTE', reason, body.note ?? null, domains)];
    const anchorOf = (l: LineRecord) => (original.taxInclusive ? l.lineGrossPesewas : l.lineNetPesewas);
    const credited = await this.store.creditedAnchors(
      tx,
      original.lines.map((l) => l.id),
      original.taxInclusive,
    );
    const creditable = original.lines.map((l) => ({
      id: l.id,
      pricing: {
        unitPrice: Money.ofPesewas(l.unitPricePesewas),
        resolvedUnitPrice: Money.ofPesewas(l.resolvedUnitPricePesewas),
        quantity: Quantity.parse(l.qty),
        discount: Money.ofPesewas(l.discountPesewas),
      },
      anchor: Money.ofPesewas(anchorOf(l)),
      creditedAnchor: Money.ofPesewas(credited.get(l.id) ?? 0n),
    }));
    const inputs = body.lines.map((l) => ({
      lineId: l.lineId,
      quantity: l.quantity === undefined ? undefined : Quantity.parse(l.quantity),
      amount: l.amountPesewas === undefined ? undefined : Money.fromJsonInteger(l.amountPesewas),
    }));
    const { plans, broken: lineRules } = planCreditLines(creditable, inputs);
    broken.push(...lineRules);
    if (broken.length > 0) throw new BillingDocumentInvalidError(broken);
    const byId = new Map(original.lines.map((l) => [l.id, l] as const));
    const priced: PricedLine[] = plans.map((plan, i) => {
      const source = byId.get(plan.lineId)!;
      return {
        ref: String(lineNumber(i)),
        anchor: plan.anchor,
        variance: 0n,
        record: {
          ...source,
          id: this.nextId(),
          lineNo: lineNumber(i),
          orderLineRef: null,
          creditsLineId: source.id,
          qty: plan.pricing.quantity.toDecimalString(),
          discountPesewas: plan.pricing.discount.pesewas,
          resolvedUnitPricePesewas: source.unitPricePesewas,
        },
      };
    });
    // The original's tax date gives its scheme version: a credit takes back exactly what was charged (ADR-0020).
    const { versionId, lines } = await this.taxed(tx, original.taxInclusive, original.issueDate, priced);
    const gross = documentTotals(lines.map(figures)).gross.pesewas;
    if (original.creditedPesewas + gross > original.grossPesewas) throw new CreditNoteExceedsOriginalError(original.grossPesewas - original.creditedPesewas);
    return { versionId, lines, gross };
  }

  /** IAM's handler for `CREDIT_NOTE`: the approved draft is issued and posted, numbered in the approval's transaction. */
  readonly creditNoteApprovals: ApprovalHandler = {
    currentPayloadHash: async (tx, subjectDocumentId) => {
      const [draft] = await this.store.documents(tx, [subjectDocumentId], true);
      if (draft === undefined) throw new NotFoundError(`billing document ${subjectDocumentId} does not exist`);
      return draftHash(draft);
    },
    onApproved: async (tx: Transaction, request: ApprovalRecord) => {
      await this.issueDraft(tx, request.subjectDocumentId, request.decidedBy ?? request.requestedBy, request.id);
    },
  };

  /**
   * `issueDebitNote` (FR-BIL-007): a charge added to an issued invoice or receipt, each line taxed by today's scheme
   * in the original's pricing (net if it was tax-exclusive, gross if inclusive), issued and posted at once.
   */
  issueDebitNote(actor: Actor | undefined, originalId: string, body: DebitNoteRequest, idempotencyKey: string): Promise<StoredResponse<BillingDocumentView>> {
    const locks = (branchId: string) => this.seriesLocksFor('DEBIT_NOTE', branchId);
    return this.command(actor, DEBIT, 'issueDebitNote', originalId, body, idempotencyKey, locks, async (tx, original) => {
      const reason = (await this.refs.reasonCodesIn(tx, [body.reasonCode])).get(body.reasonCode);
      const broken: BrokenRule[] = [...noteReasonRule('DEBIT_NOTE', reason, body.note ?? null)];
      if (body.lines.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
      const categories = await this.refs.taxCategoriesIn(
        tx,
        body.lines.map((l) => l.taxCategoryId),
      );
      const missing = body.lines.flatMap((l, i) => (categories.has(l.taxCategoryId) ? [] : [`/lines/${i}/taxCategoryId`]));
      if (missing.length > 0) throw new BilReferenceNotFoundError(missing);
      body.lines.forEach((l, i) => {
        if (l.amountPesewas <= 0) broken.push({ field: `/lines/${i}/amountPesewas`, rule: 'AMOUNT_NOT_POSITIVE' });
      });
      if (broken.length > 0) throw new BillingDocumentInvalidError(broken);
      const priced: PricedLine[] = body.lines.map((l, i) => {
        const amount = Money.fromJsonInteger(l.amountPesewas);
        return {
          ref: String(lineNumber(i)),
          anchor: amount,
          variance: 0n,
          record: {
            id: this.nextId(),
            lineNo: lineNumber(i),
            lineKind: 'ADJUSTMENT',
            productId: null,
            description: l.description.trim(),
            stockUnit: null,
            orderLineRef: null,
            creditsLineId: null,
            qty: ONE,
            uom: ADJUSTMENT_UOM,
            weightKg: null,
            unitPricePesewas: amount.pesewas,
            resolvedUnitPricePesewas: amount.pesewas,
            discountPesewas: 0n,
            taxCategoryId: l.taxCategoryId,
            glGroup: OTHER_GROUP,
          },
        };
      });
      const today = toBusinessDate(this.clock.now());
      const { versionId, lines } = await this.taxed(tx, original.taxInclusive, today, priced);
      const due = original.dueDate === null ? null : original.dueDate < today ? today : original.dueDate;
      const header = this.noteHeader(original, 'DEBIT_NOTE', versionId, body.reasonCode, body.note, actor!.principalId, due);
      await this.writeDraft(tx, header, lines);
      return { status: 201, body: await this.issueDraft(tx, header.id, actor!.principalId, null) };
    });
  }

  /**
   * BIL's consumer of `doc.DocumentArchived` (ADR-0061): an issued billing document learns its archived rendering and
   * keeps the SHA-256 of its bytes as its content hash, both once (`ck_billing_document_frozen`).
   */
  readonly archiveLinks: AsyncConsumer = {
    name: 'bil.archive-link',
    eventTypes: [DOCUMENT_ARCHIVED],
    isolation: 'read committed',
    handle: async (tx, event) => {
      const archived = event.payload as unknown as DocumentArchived;
      if (!BILLING_KINDS.includes(archived.docType)) return;
      await this.store.linkArchive(tx, archived.businessDocumentId, archived.archivedDocumentId, Buffer.from(archived.sha256, 'hex'));
    },
  };

  /**
   * `reprintBillingDocument` (FR-BIL-009): the archived bytes, checked against their SHA-256, with a marker naming the
   * next copy number, logged in `bil.reprint_log`. Never a new document and never a new number; nothing is rendered
   * again, so the figures, the party and the template are the ones issued.
   */
  async reprint(actor: Actor | undefined, id: string, body: { readonly channel: 'THERMAL' | 'PDF' }, idempotencyKey: string): Promise<StoredResponse<ReprintView>> {
    const archived = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, REPRINT);
      const record = await this.documentOf(tx, id, false);
      await this.authoriser.authorise(tx, actor, REPRINT, { branchId: record.branchId });
      if (record.status !== 'ISSUED') throw new NotFoundError(`billing document ${id} is not issued`);
      if (record.archivedDocumentId === null) throw new DocumentNotArchivedError('RENDERING');
      return (await this.archive.archivedIn(tx, [record.archivedDocumentId]))[0]!;
    });
    // Read and hash-checked outside any transaction; served only if the bytes are the ones archived.
    const original = await this.archive.content(archived, body.channel);
    return this.uow.run({ isolation: 'serializable', seriesLocks: [`REPRINT:${id}`] }, async (tx) => {
      await this.authoriser.authorise(tx, actor, REPRINT, { branchId: archived.branchId });
      const claim = await this.idempotency.claim(tx, { operationId: 'reprintBillingDocument', principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ReprintView>;
      const copyNo = await this.store.appendReprint(tx, { id: this.nextId(), billingDocumentId: id, channel: body.channel, actorId: actor!.principalId, at: this.clock.now() });
      const marker = `REPRINT ${copyNo}`;
      const bytes = body.channel === 'PDF' ? withReprintMarker(original, marker) : escPosWithReprintMarker(original, marker);
      await this.audit.record(tx, {
        module: 'bil',
        action: 'REPRINT',
        entityType: 'BillingDocument',
        entityId: id,
        branchId: archived.branchId,
        before: null,
        after: { copyNo, channel: body.channel, archivedDocumentId: archived.id },
      });
      const response = {
        status: 200,
        body: {
          copyNo,
          channel: body.channel,
          url: null,
          escPosBase64: body.channel === 'THERMAL' ? bytes.toString('base64') : null,
          pdfBase64: body.channel === 'PDF' ? bytes.toString('base64') : null,
          expiresAt: null,
        },
      };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** `listBillingDocumentReprints`: every copy by number, who made it and when. */
  listReprints(actor: Actor | undefined, id: string, cursor: string | undefined, limit: number): Promise<Page<ReprintLogView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const record = await this.documentOf(tx, id, false);
      await this.authoriser.authorise(tx, actor, READ, { branchId: record.branchId });
      const binding = { operationId: 'listBillingDocumentReprints', principalId: actor!.principalId, filters: { id } };
      const after = cursor === undefined ? undefined : this.cursors.decode(cursor, binding)['copyNo'];
      const rows = await this.store.reprints(tx, id, after === undefined ? null : Number(after), pageProbe(limit));
      const page = rows.slice(0, limit);
      const names = await this.principals.refs(tx, [...new Set(page.map((r) => r.actorId))]);
      const data = page.map((r) => ({ copyNo: r.copyNo, channel: r.channel, actor: names.get(r.actorId) ?? { id: r.actorId, displayName: 'Unknown' }, recordedAt: r.recordedAt.toISOString() }));
      const hasMore = rows.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { copyNo: String(last.copyNo) }) : null, limit, hasMore } };
    });
  }

  /** What the document's template renders: the issued document as printed (FR-BIL-004). */
  private async renderData(tx: Transaction, record: DocumentRecord, view: BillingDocumentView): Promise<Record<string, unknown>> {
    const branch = (await this.refs.branchesIn(tx, [record.branchId])).get(record.branchId)!;
    return renderDataOf({
      kind: record.kind,
      documentNo: record.documentNo!,
      provisionalRef: record.provisionalRef,
      issueDate: record.issueDate,
      dueDate: record.dueDate,
      branch: { code: branch.code, name: branch.name },
      customer: record.customerName === null ? null : { name: record.customerName, tin: record.customerTin, address: record.billingAddress },
      original: view.originalDocument?.number === undefined || view.originalDocument.number === null ? null : { documentNo: view.originalDocument.number },
      reasonCode: record.reasonCode,
      taxInclusive: record.taxInclusive,
      netPesewas: record.netPesewas,
      taxPesewas: record.taxPesewas,
      grossPesewas: record.grossPesewas,
      levyTotals: view.levyTotals.map((t) => ({ levyCode: t.levyCode, levyName: t.levyName, amountPesewas: BigInt(t.amountPesewas) })),
      lines: record.lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        identifier: l.stockUnit?.identifier ?? null,
        quantity: l.qty,
        uom: l.uom,
        weightKg: l.weightKg,
        unitPricePesewas: l.unitPricePesewas,
        discountPesewas: l.discountPesewas,
        netPesewas: l.lineNetPesewas,
        taxPesewas: l.lineTaxPesewas,
        grossPesewas: l.lineGrossPesewas,
        levies: l.levies.map((v) => ({ levyCode: v.levyCode, levyName: v.levyName, treatment: v.treatment, ratePercent: v.ratePercent, basePesewas: v.basePesewas, amountPesewas: v.amountPesewas })),
      })),
    });
  }

  /** A credit or debit note's header: the original's branch, customer and printed party, never edited since. */
  private noteHeader(
    original: DocumentRecord,
    kind: 'CREDIT_NOTE' | 'DEBIT_NOTE',
    versionId: string,
    reasonCode: string,
    note: string | undefined,
    actorId: string,
    dueDate: string | null,
  ): DraftHeader {
    return {
      id: this.nextId(),
      kind,
      branchId: original.branchId,
      provisionalRef: null,
      customerId: original.customerId,
      customerName: original.customerName,
      customerTin: original.customerTin,
      billingAddress: original.billingAddress,
      orderDocumentId: original.orderDocumentId,
      originalDocumentId: original.id,
      issueDate: toBusinessDate(this.clock.now()),
      dueDate,
      taxInclusive: original.taxInclusive,
      taxSchemeVersionId: versionId,
      reasonCode,
      note: note === undefined || note.trim() === '' ? null : note.trim(),
      occurredAt: null,
      actorId,
    };
  }

  /** A note command: authorised first, idempotent, at the original's branch, serializable with its series locked. */
  private async command<B extends object, R>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    originalId: string,
    body: B,
    idempotencyKey: string,
    locks: (branchId: string) => string[],
    work: (tx: Transaction, original: DocumentRecord) => Promise<StoredResponse<R>>,
  ): Promise<StoredResponse<R>> {
    const branchId = await this.uow.run({ isolation: 'read committed' }, async (tx) => (await this.store.documents(tx, [originalId]))[0]?.branchId ?? null);
    return this.uow.run({ isolation: 'serializable', seriesLocks: branchId === null ? [] : locks(branchId) }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request: { originalId, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<R>;
      const original = await this.documentOf(tx, originalId, true);
      await this.authoriser.authorise(tx, actor, permission, { branchId: original.branchId });
      if (!correctable(original)) throw new BillingDocumentInvalidError([{ field: null, rule: 'ORIGINAL_NOT_CORRECTABLE' }]);
      const response = await translateRefusal(() => work(tx, original));
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private async documentOf(tx: Transaction, id: string, forUpdate: boolean): Promise<DocumentRecord> {
    const [record] = await this.store.documents(tx, [id], forUpdate);
    if (record === undefined) throw new NotFoundError(`billing document ${id} does not exist`);
    return record;
  }

  /** Every line's levy rows from MDM's calculator, one per levy including those at zero (ADR-0020). */
  private async taxed(tx: Transaction, taxInclusive: boolean, taxDate: string, priced: readonly PricedLine[]): Promise<{ versionId: string; lines: LineRecord[] }> {
    const calculation = await this.tax.calculateIn(tx, {
      taxInclusive,
      taxDate,
      lines: priced.map((p) => ({ lineRef: p.ref, taxCategoryId: p.record.taxCategoryId, amountPesewas: p.anchor.pesewas })),
    });
    const byRef = new Map(calculation.lines.map((l) => [l.lineRef, l] as const));
    const lines = priced.map((p): LineRecord => {
      const breakdown = byRef.get(p.ref)!;
      return {
        ...p.record,
        lineNetPesewas: breakdown.net.pesewas,
        lineTaxPesewas: breakdown.tax.pesewas,
        lineGrossPesewas: breakdown.gross.pesewas,
        levies: breakdown.levies.map((levy) => ({
          levyId: levy.levyId,
          levyCode: levy.levyCode,
          levyName: levy.levyName,
          treatment: levy.treatment,
          // The rate actually applied: nothing is charged while the business is not registered (A-033).
          ratePercent: breakdown.registered ? levy.rate.toPercentString() : '0',
          basePesewas: levy.base.pesewas,
          amountPesewas: levy.amount.pesewas,
          calcOrder: levy.calcOrder,
        })),
      };
    });
    return { versionId: calculation.versionId, lines };
  }

  private async writeDraft(tx: Transaction, header: DraftHeader, lines: readonly LineRecord[]): Promise<void> {
    await this.documents.register(tx, { id: header.id, docType: header.kind, ownerModule: 'bil', branchId: header.branchId, actorId: header.actorId });
    await this.store.insertDraft(tx, header, lines);
  }

  /**
   * Issues a draft: its number from the series in this transaction, its totals the sums of its lines, its ◆ event
   * (posted by the ledger here and now), its audit event. `variances` are the lines' price variances (an invoice).
   */
  private async issueDraft(tx: Transaction, id: string, actorId: string, approvalRequestId: string | null, variances: ReadonlyMap<string, bigint> = new Map()): Promise<BillingDocumentView> {
    const draft = await this.documentOf(tx, id, true);
    const issueDate = toBusinessDate(this.clock.now());
    const branch = (await this.refs.branchesIn(tx, [draft.branchId])).get(draft.branchId)!;
    const documentNo = await this.numbers.allocateIn(tx, { docType: draft.kind, fiscalYear: fiscalYearOf(issueDate), branchId: draft.branchId, branchCode: branch.code, documentId: id });
    const totals = documentTotals(draft.lines.map(figures));
    // A draft approved on a later day is never due before its issue date (A-223, `ck_billing_document_due`).
    const dueDate = draft.dueDate !== null && draft.dueDate < issueDate ? issueDate : draft.dueDate;
    await this.store.issue(tx, id, {
      documentNo,
      netPesewas: totals.net.pesewas,
      taxPesewas: totals.tax.pesewas,
      grossPesewas: totals.gross.pesewas,
      issueDate,
      dueDate,
      issuedAt: this.clock.now(),
      actorId,
    });
    const payload: BillingDocumentPayload = {
      billingDocumentId: id,
      kind: draft.kind,
      documentNo,
      branchId: draft.branchId,
      customerId: draft.customerId,
      orderDocumentId: draft.orderDocumentId,
      originalDocumentId: draft.originalDocumentId,
      issueDate,
      dueDate,
      taxInclusive: draft.taxInclusive,
      taxSchemeVersionId: draft.taxSchemeVersionId,
      netPesewas: json(totals.net.pesewas),
      taxPesewas: json(totals.tax.pesewas),
      grossPesewas: json(totals.gross.pesewas),
      lines: draft.lines.map((l) => ({
        lineNo: l.lineNo,
        lineKind: l.lineKind,
        productId: l.productId,
        glGroup: l.glGroup,
        netPesewas: json(l.lineNetPesewas),
        taxPesewas: json(l.lineTaxPesewas),
        grossPesewas: json(l.lineGrossPesewas),
        discountPesewas: json(l.discountPesewas),
        priceVariancePesewas: Number(variances.get(l.id) ?? 0n),
        stockUnitId: l.stockUnit?.id ?? null,
      })),
      levies: draft.lines.flatMap((l) => l.levies.map((levy) => ({ lineNo: l.lineNo, levyId: levy.levyId, levyCode: levy.levyCode, amountPesewas: json(levy.amountPesewas) }))),
    };
    const type = draft.kind === 'CREDIT_NOTE' ? CREDIT_NOTE_ISSUED : draft.kind === 'DEBIT_NOTE' ? DEBIT_NOTE_ISSUED : draft.kind === 'PROFORMA' ? PROFORMA_ISSUED : INVOICE_ISSUED;
    const extra =
      draft.kind === 'CREDIT_NOTE'
        ? ({ reasonCode: draft.reasonCode!, approvalRequestId, abuseCases: [CREDIT_NOTE_ABUSE_CASE] } satisfies Pick<CreditNoteIssued, 'reasonCode' | 'approvalRequestId' | 'abuseCases'>)
        : draft.kind === 'DEBIT_NOTE'
          ? ({ reasonCode: draft.reasonCode! } satisfies Pick<DebitNoteIssued, 'reasonCode'>)
          : {};
    await this.events.publish(tx, { type, subjectType: 'BillingDocument', subjectId: id, branchId: draft.branchId, payload: { ...payload, ...extra } });
    const [issued] = await this.store.documents(tx, [id]);
    const [view] = await this.views(tx, [issued!]);
    // Rendered and archived by DOC's worker after this transaction commits (FR-DOC-003): never inside it.
    await this.archive.requestRenderIn(tx, { businessDocumentId: id, docType: draft.kind, documentNo, branchId: draft.branchId, renderData: await this.renderData(tx, issued!, view!) });
    await this.audit.record(tx, { module: 'bil', action: 'ISSUE', entityType: 'BillingDocument', entityId: id, branchId: draft.branchId, before: null, after: { ...view!, approvalRequestId } });
    return view!;
  }

  private async views(tx: Transaction, records: readonly DocumentRecord[]): Promise<BillingDocumentView[]> {
    const customers = await this.refs.customersIn(
      tx,
      records.flatMap((r) => (r.customerId === null ? [] : [r.customerId])),
    );
    const lines = records.flatMap((r) => r.lines);
    const products = await this.refs.productsIn(
      tx,
      lines.flatMap((l) => (l.productId === null ? [] : [l.productId])),
    );
    const categories = await this.refs.taxCategoriesIn(tx, [...new Set(lines.map((l) => l.taxCategoryId))]);
    const orders = await this.documents.refs(
      tx,
      records.flatMap((r) => (r.orderDocumentId === null ? [] : [r.orderDocumentId])),
    );
    const originals = new Map(
      (
        await this.store.documents(
          tx,
          records.flatMap((r) => (r.originalDocumentId === null ? [] : [r.originalDocumentId])),
        )
      ).map((o) => [o.id, o] as const),
    );
    const settlements = await this.store.settlements(tx, [...new Set([...records.map((r) => r.id), ...originals.keys()])]);
    const reprints = await this.store.reprintCounts(
      tx,
      records.map((r) => r.id),
    );
    return records.map((r) => {
      const customer = r.customerId === null ? undefined : customers.get(r.customerId);
      const settlement = settlements.get(r.id);
      const original = r.originalDocumentId === null ? undefined : originals.get(r.originalDocumentId);
      const order = r.orderDocumentId === null ? undefined : orders.get(r.orderDocumentId);
      return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        documentNo: r.documentNo,
        provisionalRef: r.provisionalRef,
        customer: customer === undefined ? null : { id: customer.id, publicId: customer.publicId, name: customer.name },
        customerName: r.customerName,
        customerTin: r.customerTin,
        billingAddress: r.billingAddress,
        order: order === undefined ? null : { id: order.id, docType: order.docType, number: order.number },
        originalDocument: original === undefined ? null : { id: original.id, docType: original.kind, number: original.documentNo },
        issueDate: r.status === 'ISSUED' ? r.issueDate : null,
        dueDate: r.dueDate,
        taxInclusive: r.taxInclusive,
        taxSchemeVersionId: r.taxSchemeVersionId,
        netPesewas: json(r.netPesewas),
        taxPesewas: json(r.taxPesewas),
        grossPesewas: json(r.grossPesewas),
        currency: 'GHS',
        levyTotals: levyTotals(
          r.lines.flatMap((l) => l.levies.map((levy) => ({ levyCode: levy.levyCode, levyName: levy.levyName, calcOrder: levy.calcOrder, amount: Money.ofPesewas(levy.amountPesewas) }))),
        ).map((t) => ({
          levyCode: t.levyCode,
          levyName: t.levyName,
          amountPesewas: t.amount.toJsonInteger(),
        })),
        lines: r.lines.map((l) => {
          const product = l.productId === null ? undefined : products.get(l.productId);
          const category = categories.get(l.taxCategoryId)!;
          return {
            id: l.id,
            lineNo: l.lineNo,
            lineKind: l.lineKind,
            product: product === undefined ? null : { id: product.id, sku: product.sku, name: product.name },
            description: l.description,
            stockUnit: l.stockUnit,
            quantity: l.qty,
            uom: l.uom,
            weightKg: l.weightKg,
            unitPricePesewas: json(l.unitPricePesewas),
            resolvedUnitPricePesewas: json(l.resolvedUnitPricePesewas),
            discountPesewas: json(l.discountPesewas),
            taxCategory: { id: category.id, code: category.code, name: category.name },
            lineNetPesewas: json(l.lineNetPesewas),
            lineTaxPesewas: json(l.lineTaxPesewas),
            lineGrossPesewas: json(l.lineGrossPesewas),
            levies: l.levies.map((levy) => ({
              levyCode: levy.levyCode,
              levyName: levy.levyName,
              treatment: levy.treatment,
              ratePercent: levy.ratePercent,
              basePesewas: json(levy.basePesewas),
              amountPesewas: json(levy.amountPesewas),
            })),
          };
        }),
        settlement:
          settlement === undefined
            ? {
                allocatedPesewas: 0,
                creditedPesewas: 0,
                outstandingPesewas: 0,
                refundedPesewas: 0,
                refundablePesewas: 0,
                paymentStatus: 'NOT_APPLICABLE',
                settledAt: null,
                asOf: (r.issuedAt ?? this.clock.now()).toISOString(),
              }
            : {
                allocatedPesewas: json(settlement.allocatedPesewas),
                creditedPesewas: json(settlement.creditedPesewas),
                outstandingPesewas: json(settlement.outstandingPesewas),
                refundedPesewas: json(settlement.refundedPesewas),
                refundablePesewas: json(refundableOf(r, settlement, r.originalDocumentId === null ? undefined : settlements.get(r.originalDocumentId))),
                paymentStatus: settlement.paymentStatus,
                settledAt: settlement.settledAt?.toISOString() ?? null,
                asOf: settlement.asOf.toISOString(),
              },
        certification:
          r.certification === null ? null : { certifiedTaxPesewas: json(r.certification.taxPesewas), certifiedGrossPesewas: json(r.certification.grossPesewas), reference: r.certification.reference },
        reasonCode: r.reasonCode,
        archivedDocumentId: r.archivedDocumentId,
        contentHash: r.contentHash === null ? null : r.contentHash.toString('hex'),
        issuedAt: r.issuedAt?.toISOString() ?? null,
        occurredAt: r.occurredAt?.toISOString() ?? null,
        reprintCount: reprints.get(r.id) ?? 0,
        branchId: r.branchId,
      };
    });
  }
}

function figures(l: LineRecord): { net: Money; tax: Money; gross: Money } {
  return { net: Money.ofPesewas(l.lineNetPesewas), tax: Money.ofPesewas(l.lineTaxPesewas), gross: Money.ofPesewas(l.lineGrossPesewas) };
}

/** What a credit note would take back (`Billing.creditPreviewIn`): each credited original line's gross, and the total. */
export interface CreditPreview {
  readonly grossPesewas: bigint;
  readonly lines: readonly { readonly lineId: string; readonly grossPesewas: bigint }[];
}

/** A billing document as a payment sees it (`Billing.settleableIn`). */
export interface SettleableDocument {
  readonly id: string;
  readonly kind: string;
  readonly status: 'DRAFT' | 'ISSUED';
  readonly branchId: string;
  readonly customerId: string | null;
  readonly documentNo: string | null;
  readonly outstandingPesewas: bigint;
  /** The document a credit or debit note corrects. */
  readonly originalDocumentId: string | null;
  /** Who raised it: a credit note's maker never approves a refund against it (ADR-0066). */
  readonly createdBy: string;
  /** What a refund may still draw on (ADR-0066): see `refundableOf`. */
  readonly refundablePesewas: bigint;
}

/** `creditRefundableOf` over a stored document and its settlement rows. */
function refundableOf(record: Pick<DocumentRecord, 'kind' | 'status' | 'grossPesewas'>, settlement: SettlementRecord, original: SettlementRecord | undefined): bigint {
  return creditRefundableOf(
    { kind: record.kind, issued: record.status === 'ISSUED', grossPesewas: record.grossPesewas, refundedPesewas: settlement.refundedPesewas, refundablePesewas: settlement.refundablePesewas },
    original?.refundablePesewas ?? null,
  );
}

/** What a credit note's approval binds to: the draft as priced, line by line and levy by levy. */
function draftHash(d: DocumentRecord): string {
  const payload = {
    kind: d.kind,
    originalDocumentId: d.originalDocumentId,
    customerId: d.customerId,
    reasonCode: d.reasonCode,
    taxSchemeVersionId: d.taxSchemeVersionId,
    lines: d.lines.map((l) => [
      l.creditsLineId,
      l.qty,
      l.discountPesewas.toString(),
      l.lineNetPesewas.toString(),
      l.lineGrossPesewas.toString(),
      l.levies.map((t) => [t.levyId, t.amountPesewas.toString()]),
    ]),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function auditShape(d: DocumentRecord): Record<string, unknown> {
  return {
    kind: d.kind,
    originalDocumentId: d.originalDocumentId,
    reasonCode: d.reasonCode,
    note: d.note,
    lines: d.lines.map((l) => ({ creditsLineId: l.creditsLineId, qty: l.qty, lineNetPesewas: json(l.lineNetPesewas), lineGrossPesewas: json(l.lineGrossPesewas) })),
  };
}

/** The database's credit cap, refused as the API names it. */
async function translateRefusal<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const failure = databaseErrorOf(error);
    if (failure?.code === 'HK010' && failure.constraint === 'ck_billing_document_credit_cap') throw new CreditNoteExceedsOriginalError(null);
    throw error;
  }
}
