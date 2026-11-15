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
import type { Authoriser, PrincipalNames } from '../../iam';
import type { MasterDataRefs, ProductFacts, TaxService } from '../../mdm';
import { orderLineNet } from '../domain/purchasing';
import { matchInvoice, matchLine, type MatchReason, type MatchStatus } from '../domain/three-way-match';
import { dueDateFrom } from '../domain/terms';
import type { SupplierInvoiceApproved, SupplierInvoiceMismatched } from '../events';
import {
  DuplicateSupplierInvoiceError,
  PurReferenceNotFoundError,
  SupplierInvoiceInvalidError,
  ThreeWayMatchFailedError,
  translatePurRefusal,
  wrongStatus,
  type BrokenRule,
} from './errors';
import { lineNumber, pesewas, principalRef, productRef, readPage, runPurchaseCommand, supplierRef, wholeBranches, type Page } from './purchase-command';
import type { SupplierRegisterStore } from './supplier-register-store';
import type { InvoiceFilter, InvoiceHeader, InvoiceLineRecord, InvoiceRecord, InvoiceStatus, LineMatchRecord, OrderRecord, PurchasingStore } from './purchasing-store';

const DOC_TYPE = 'SUPPLIER_INVOICE';
const READ = 'pur.supplier_invoice.read';
const CREATE = 'pur.supplier_invoice.create';
const MATCH = 'pur.supplier_invoice.match';
const APPROVE = 'pur.supplier_invoice.approve';
const INVOICE_FILE = 'SUPPLIER_INVOICE';
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
  readonly lines: readonly InvoiceLineInput[];
}

export interface SupplierInvoiceUpdate {
  readonly version: number;
  readonly supplierInvoiceNo?: string | undefined;
  readonly invoiceDate?: string | undefined;
  readonly dueDate?: string | undefined;
  readonly fileId?: string | undefined;
  readonly statedGrossPesewas?: number | undefined;
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
}

/** The contract's `SupplierInvoice`. */
export interface SupplierInvoiceView {
  readonly id: string;
  readonly kind: 'INVOICE' | 'CREDIT_NOTE';
  readonly status: InvoiceStatus;
  readonly supplier: { readonly id: string; readonly supplierNo: string; readonly name: string };
  readonly supplierInvoiceNo: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly purchaseOrder: { readonly id: string; readonly docType: string; readonly number: string | null } | null;
  readonly originalInvoiceId: string | null;
  readonly netPesewas: number;
  readonly taxPesewas: number;
  readonly grossPesewas: number;
  readonly paidPesewas: number;
  readonly outstandingPesewas: number;
  readonly currency: 'GHS';
  readonly matchStatus: MatchStatus;
  readonly file: { readonly id: string; readonly originalName: string; readonly contentType: string } | null;
  readonly lines: readonly SupplierInvoiceLineView[];
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly displayName: string };
}

/**
 * Supplier invoices with the three-way match (FR-PUR-008 to FR-PUR-010, A-164): entered with each line's levies as
 * the supplier charged them beside MDM's calculation on the invoice date (a reclaimable flag on every levy row,
 * ADR-0020), matched line by line against the order line and what was received (SA-08), and approved for payment only
 * when every payable line matches; approval publishes the ledger event for B8. A line in the order line's unit
 * converts to the base unit through `MasterDataRefs.toBaseIn`. Every handler authorises first, scoped to the
 * invoice's branch; every change is audited.
 */
export class SupplierInvoices {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: PurchasingStore,
    private readonly register: SupplierRegisterStore,
    private readonly refs: MasterDataRefs,
    private readonly tax: TaxService,
    private readonly files: FileStore,
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
        const order = body.purchaseOrderId === undefined ? null : await this.store.order(tx, body.purchaseOrderId);
        const branchId = order?.branchId ?? body.branchId;
        return branchId === undefined ? {} : { branchId };
      },
      async (tx) => {
        if (body.kind === 'CREDIT_NOTE') throw new SupplierInvoiceInvalidError([{ field: '/kind', rule: 'CREDIT_NOTE_NOT_AVAILABLE' }]);
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
        await this.store.insertInvoice(tx, id, { ...built.header, kind: 'INVOICE', supplierId: supplier.id, purchaseOrderId: order?.id ?? null, branchId }, built.lines, actor!.principalId);
        const view = await this.view(tx, id);
        await this.audit.record(tx, { module: 'pur', action: 'CREATE', entityType: 'SupplierInvoice', entityId: id, branchId, before: null, after: { ...view } });
        return { status: 201, body: view };
      },
    ).catch(translatePurRefusal);
  }

  update(actor: Actor | undefined, id: string, body: SupplierInvoiceUpdate, idempotencyKey: string): Promise<StoredResponse<SupplierInvoiceView>> {
    return this.write(actor, CREATE, 'updateSupplierInvoice', id, body, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, CHANGEABLE, body.version);
      const order = before.purchaseOrderId === null ? null : await this.store.order(tx, before.purchaseOrderId);
      const built = await this.build(
        tx,
        {
          supplierInvoiceNo: body.supplierInvoiceNo ?? before.supplierInvoiceNo,
          invoiceDate: body.invoiceDate ?? before.invoiceDate,
          dueDate: body.dueDate ?? (body.invoiceDate === undefined ? before.dueDate : undefined),
          fileId: body.fileId ?? before.fileId ?? undefined,
          statedGrossPesewas: body.statedGrossPesewas ?? (before.statedGrossPesewas === null ? undefined : pesewas(before.statedGrossPesewas)),
          lines: body.lines ?? before.lines.map(inputOf),
        },
        order,
        await this.termsDays(tx, before.supplierId),
      );
      if (await this.store.supplierInvoiceNoTaken(tx, before.supplierId, built.header.supplierInvoiceNo, id)) throw new DuplicateSupplierInvoiceError();
      await this.store.replaceInvoice(tx, id, built.header, built.lines, actor!.principalId);
      return { status: 200, body: await this.audited(tx, 'UPDATE', before) };
    });
  }

  match(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<SupplierInvoiceView>> {
    return this.write(actor, MATCH, 'matchSupplierInvoice', id, {}, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, CHANGEABLE, null);
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
      if (before.status === 'DRAFT') throw new ThreeWayMatchFailedError([{ field: '/matchStatus', rule: 'UNMATCHED' }]);
      // The match again, as things are now: a mismatch recorded earlier, or one that appeared since, blocks approval.
      const results = await this.matched(tx, before);
      const failing = results.flatMap((r, i) => r.reasons.map((reason) => ({ field: `/lines/${i}`, rule: reason })));
      if (before.status === 'MISMATCH' || failing.length > 0) {
        throw new ThreeWayMatchFailedError(failing.length > 0 ? failing : [{ field: '/matchStatus', rule: 'MISMATCH' }]);
      }
      await this.store.markInvoiceApproved(tx, id, this.clock.now(), actor!.principalId);
      const view = await this.audited(tx, 'APPROVE', before);
      await this.publishApproved(tx, before, view);
      return { status: 200, body: view };
    });
  }

  cancel(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<SupplierInvoiceView>> {
    return this.write(actor, CREATE, 'cancelSupplierInvoice', id, { reason }, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, CANCELLABLE, null);
      if (((await this.store.promised(tx, [id])).get(id) ?? 0n) > 0n) throw new SupplierInvoiceInvalidError([{ field: '/status', rule: 'PAYMENT_ALLOCATED' }]);
      await this.store.markInvoiceCancelled(tx, id, reason, actor!.principalId);
      return { status: 200, body: await this.audited(tx, 'CANCEL', before, { reason }) };
    });
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
      outstandingPesewas: pesewas(r.grossPesewas - r.paidPesewas),
      currency: 'GHS' as const,
      matchStatus: r.matchStatus,
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
      })),
      branchId: r.branchId,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      createdBy: principalRef(names, r.createdBy),
    }));
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

  private async locked(tx: Transaction, id: string, allowed: ReadonlySet<InvoiceStatus>, version: number | null): Promise<InvoiceRecord> {
    const invoice = await this.store.lockInvoice(tx, id);
    if (invoice === null) throw new NotFoundError(`no supplier invoice ${id}`);
    if (version !== null && invoice.version !== version) throw new VersionConflictError(`supplier invoice ${id} is at version ${invoice.version}, not ${version}`);
    if (!allowed.has(invoice.status)) throw wrongStatus(`supplier invoice ${id}`, invoice.status);
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
    body: Pick<SupplierInvoiceCreate, 'supplierInvoiceNo' | 'invoiceDate' | 'dueDate' | 'fileId' | 'statedGrossPesewas' | 'lines'>,
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
      },
      lines,
    };
  }

  /** Each line's match against its order line, with the receipt as it stands and what other live invoices hold. */
  private async matched(tx: Transaction, invoice: InvoiceRecord): Promise<LineMatchRecord[]> {
    const orderLineIds = [...new Set(invoice.lines.flatMap((l) => (l.purchaseOrderLineId === null ? [] : [l.purchaseOrderLineId])))];
    const orderLines = new Map((await this.store.lockOrderLines(tx, orderLineIds)).map((l) => [l.id, l] as const));
    const elsewhere = await this.store.invoicedQty(tx, orderLineIds, invoice.id);
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
            : { productId: orderLine.productId, unitPrice: Money.ofPesewas(orderLine.unitPricePesewas), qtyReceived: Quantity.parse(orderLine.qtyReceived), qtyInvoicedElsewhere: already },
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

  /** ◆ The ledger event of an approved invoice (FR-PUR-015), with each line at its order price for 2010 and 5140. */
  private async publishApproved(tx: Transaction, invoice: InvoiceRecord, view: SupplierInvoiceView): Promise<void> {
    const orderLines = new Map((await this.store.lockOrderLines(tx, invoice.lines.flatMap((l) => (l.purchaseOrderLineId === null ? [] : [l.purchaseOrderLineId])))).map((l) => [l.id, l] as const));
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
      lines: invoice.lines.map((l) => {
        const orderLine = l.purchaseOrderLineId === null ? undefined : orderLines.get(l.purchaseOrderLineId);
        return {
          lineNo: l.lineNo,
          productId: l.productId,
          purchaseOrderLineId: l.purchaseOrderLineId,
          expenseCategory: l.expenseCategory,
          taxCategoryId: l.taxCategoryId,
          netPesewas: pesewas(l.lineNetPesewas),
          orderValuePesewas: orderLine === undefined ? null : pesewas(orderLineNet(Money.ofPesewas(orderLine.unitPricePesewas), Quantity.parse(l.qty)).pesewas),
        };
      }),
      levies: invoice.lines.flatMap((l) => l.levies.map((levy) => ({ lineNo: l.lineNo, levyId: levy.levyId, levyCode: levy.levyCode, amountPesewas: pesewas(levy.amountPesewas), isReclaimable: levy.isReclaimable }))),
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
  };
}
