import { createHash } from 'node:crypto';
import { createUuidV7Generator, Money, Quantity, Rate, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Settings } from '../../../platform/settings/settings';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames } from '../../iam';
import type { GoodsReceiptPosted } from '../../inv/events';
import type { MasterDataRefs, TaxService } from '../../mdm';
import { flagOrderSplitting, splitLookbackStart, type SplitSuspect } from '../domain/order-splitting';
import { judgeOrderAction, judgeReceipt, orderLimitJudgement, orderLineNet, outstanding, receivedStatus, type OrderAction, type OrderStatus } from '../domain/purchasing';
import { dueDateFrom } from '../domain/terms';
import type { PurchaseOrderApproved, PurchaseOrderSent } from '../events';
import { PurchaseOrderInvalidError, PurReferenceNotFoundError, ReceiptExceedsOrderError, ReceiptOrderMismatchError, translatePurRefusal, wrongStatus, type BrokenRule } from './errors';
import { lineNumber, locationRef, pesewas, principalRef, productRef, readPage, runPurchaseCommand, supplierRef, type ApprovalPendingView, type Page } from './purchase-command';
import type { OrderFilter, OrderHeader, OrderLineRecord, OrderRecord, PurchasingStore } from './purchasing-store';

export const PURCHASE_ORDER_KIND = 'PURCHASE_ORDER';
/** The setting that holds the purchase order approval limit (FR-PUR-005, A-168), changed only through AUD's `updateSetting`. */
export const APPROVAL_LIMIT_SETTING = 'pur.purchase_order.approval_limit_pesewas';
/** Its documented default when no row exists: FR-PUR-005's seed, above 200,000 pesewas needs a second person. */
export const DEFAULT_APPROVAL_LIMIT_PESEWAS = 200_000;
const DOC_TYPE = 'PURCHASE_ORDER';
const READ = 'pur.purchase_order.read';
const CREATE = 'pur.purchase_order.create';
const SEND = 'pur.purchase_order.send';
const CLOSE = 'pur.purchase_order.close';
/** Where goods may be delivered to: a physical location that holds stock, never in-transit (as a goods receipt). */
const NOT_RECEIVING: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);
/** Statuses an order receives goods in (FR-PUR-007). */
const RECEIVING: ReadonlySet<OrderStatus> = new Set(['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED']);

/** The contract's `PurchaseOrderLineInput`, parsed at the boundary; `uom` is the unit the line is bought by (A-164). */
export interface OrderLineInput {
  readonly productId: string;
  readonly description?: string | undefined;
  readonly uom?: string | undefined;
  readonly qtyOrdered: string;
  readonly unitPricePesewas: number;
  readonly overReceiptTolerancePercent?: string | undefined;
  readonly expenseCategory?: string | undefined;
}

export interface PurchaseOrderCreate {
  readonly supplierId: string;
  readonly deliverToLocationId: string;
  readonly orderDate: string;
  readonly expectedOn?: string | undefined;
  readonly taxInclusive?: boolean | undefined;
  readonly lines: readonly OrderLineInput[];
}

export interface PurchaseOrderUpdate {
  readonly version: number;
  readonly expectedOn?: string | undefined;
  readonly lines?: readonly OrderLineInput[] | undefined;
}

export interface PurchaseOrderSend {
  readonly channels: readonly ('EMAIL' | 'WHATSAPP')[];
  readonly recipient?: string | undefined;
}

/** The contract's `PurchaseOrderLine`: ordering terms in the line's unit, progress in the product's base unit. */
export interface PurchaseOrderLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly description: string | null;
  readonly qtyOrdered: string;
  readonly qtyReceived: string;
  readonly qtyInvoiced: string;
  readonly uom: string;
  readonly baseUom: string;
  readonly qtyOrderedBase: string;
  readonly qtyOutstanding: string;
  readonly unitPricePesewas: number;
  readonly lineNetPesewas: number;
  readonly overReceiptTolerancePercent: string;
  readonly expenseCategory: string | null;
}

/** The contract's `PurchaseOrder`. */
export interface PurchaseOrderView {
  readonly id: string;
  readonly orderNo: string | null;
  readonly status: OrderStatus;
  readonly supplier: { readonly id: string; readonly publicId: string; readonly name: string };
  readonly deliverToLocation: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string };
  readonly orderDate: string;
  readonly expectedOn: string | null;
  readonly taxInclusive: boolean;
  readonly netPesewas: number;
  readonly taxPesewas: number;
  readonly grossPesewas: number;
  readonly currency: 'GHS';
  readonly approvalRequestId: string | null;
  readonly sentAt: string | null;
  readonly lines: readonly PurchaseOrderLineView[];
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly displayName: string };
}

/** Three decimal places, as `platform.qty` and the contract's `Quantity` carry it. */
const qtyText = (text: string) => Quantity.parse(text).toDecimalString();

function orderHash(order: OrderRecord): string {
  const payload = {
    supplierId: order.supplierId,
    deliverToLocationId: order.deliverToLocationId,
    orderDate: order.orderDate,
    expectedOn: order.expectedOn,
    grossPesewas: order.grossPesewas.toString(),
    lines: order.lines.map((l) => [l.lineNo, l.productId, l.uom, l.qtyOrdered, l.unitPricePesewas.toString(), l.lineNetPesewas.toString(), l.taxPesewas.toString(), l.tolerancePercent]),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Purchase orders (FR-PUR-005 to FR-PUR-007, A-164): drafted with exact line totals and levies from MDM's tax
 * calculator, submitted against the PURCHASE_ORDER approval limit (above it a different person approves, through IAM,
 * and the database refuses an order sent without that approval), sent, received through INV's goods receipts (a
 * transactional subscriber keeps each line's received quantity and refuses an over-receipt), and closed or cancelled.
 * A line bought by another unit than the product's base unit converts through `MasterDataRefs.toBaseIn` (B06u). Every
 * handler authorises first, scoped to the delivery location's branch and location; every change is audited.
 */
export class PurchaseOrders implements ApprovalHandler {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: PurchasingStore,
    private readonly refs: MasterDataRefs,
    private readonly tax: TaxService,
    private readonly approvals: Approvals,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly settings: Settings,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /**
   * Orders that look split to stay under the approval limit (owner, 2026-11-15, A-168): runs by one maker to one
   * supplier, each just under the limit it was judged by, submitted within the window, among orders submitted from
   * `from` (less the window, so a run that starts before it is seen whole) to `to`. B12's daily exception report reads
   * this; it is the published rule, not a screen.
   */
  async splitSuspectsIn(tx: Transaction, from: Date, to: Date): Promise<SplitSuspect[]> {
    const orders = await this.store.submittedOrders(tx, splitLookbackStart(from), to);
    return flagOrderSplitting(orders).filter((s) => s.lastAt >= from);
  }

  list(actor: Actor | undefined, filter: OrderFilter, cursor: string | undefined, limit: number): Promise<Page<PurchaseOrderView>> {
    return this.uow.run({ isolation: 'read committed' }, (tx) =>
      readPage<OrderRecord, PurchaseOrderView>(
        tx,
        { authoriser: this.authoriser, cursors: this.cursors },
        actor,
        READ,
        'listPurchaseOrders',
        { status: filter.status ?? null, supplierId: filter.supplierId ?? null, from: filter.from ?? null, to: filter.to ?? null },
        cursor,
        limit,
        (scopes, before, n) => this.store.listOrders(tx, filter, scopes, before, n),
        (records) => this.views(tx, records),
      ),
    );
  }

  get(actor: Actor | undefined, id: string): Promise<PurchaseOrderView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.store.order(tx, id);
      await this.authoriser.authorise(tx, actor, READ, record === null ? {} : { branchId: record.branchId, locationId: record.deliverToLocationId });
      if (record === null) throw new NotFoundError(`no purchase order ${id}`);
      return (await this.views(tx, [record]))[0]!;
    });
  }

  async create(actor: Actor | undefined, body: PurchaseOrderCreate, idempotencyKey: string): Promise<StoredResponse<PurchaseOrderView>> {
    return runPurchaseCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      CREATE,
      'createPurchaseOrder',
      body,
      idempotencyKey,
      (tx) => this.locationScope(tx, body.deliverToLocationId),
      async (tx) => ({ status: 201, body: await this.createIn(tx, actor!, body) }),
    );
  }

  /**
   * A draft order made inside a caller's transaction, by a caller that already authorised the maker for
   * `pur.purchase_order.create` at the delivery location: a requisition's conversion (FR-PUR-004).
   */
  async createIn(tx: Transaction, actor: Actor, body: PurchaseOrderCreate): Promise<PurchaseOrderView> {
    const header = await this.header(tx, body);
    const lines = await this.pricedLines(tx, body.orderDate, body.lines);
    const id = this.nextId();
    await this.documents.register(tx, { id, docType: DOC_TYPE, ownerModule: 'pur', branchId: header.branchId, actorId: actor.principalId });
    await this.store.insertOrder(tx, id, { ...header, ...lines.totals, taxSchemeVersionId: lines.versionId }, lines.records, actor.principalId);
    const view = await this.view(tx, id);
    await this.audit.record(tx, { module: 'pur', action: 'CREATE', entityType: 'PurchaseOrder', entityId: id, branchId: view.branchId, before: null, after: { ...view } });
    return view;
  }

  /** The branch and location an order delivered to `locationId` is authorised against. */
  scopeOf(tx: Transaction, locationId: string): Promise<{ branchId?: string; locationId?: string }> {
    return this.locationScope(tx, locationId);
  }

  update(actor: Actor | undefined, id: string, body: PurchaseOrderUpdate, idempotencyKey: string): Promise<StoredResponse<PurchaseOrderView>> {
    return this.write(actor, CREATE, 'updatePurchaseOrder', id, body, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, 'UPDATE', body.version);
      const expectedOn = body.expectedOn === undefined ? before.expectedOn : body.expectedOn;
      if (expectedOn !== null && expectedOn < before.orderDate) throw new PurchaseOrderInvalidError([{ field: '/expectedOn', rule: 'EXPECTED_BEFORE_ORDER' }]);
      const priced =
        body.lines === undefined
          ? { records: before.lines, totals: { netPesewas: before.netPesewas, taxPesewas: before.taxPesewas, grossPesewas: before.grossPesewas }, versionId: before.taxSchemeVersionId }
          : await this.pricedLines(tx, before.orderDate, body.lines);
      const header: OrderHeader = { ...before, expectedOn, ...priced.totals, taxSchemeVersionId: priced.versionId };
      await this.store.replaceOrder(tx, id, header, priced.records, actor!.principalId);
      return { status: 200, body: await this.audited(tx, 'UPDATE', before) };
    });
  }

  submit(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<PurchaseOrderView | ApprovalPendingView>> {
    return this.write<PurchaseOrderView | ApprovalPendingView>(actor, CREATE, 'submitPurchaseOrder', id, {}, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, 'SUBMIT', null);
      const supplier = (await this.refs.suppliersIn(tx, [before.supplierId])).get(before.supplierId)!;
      if (!supplier.isLive) throw new PurchaseOrderInvalidError([{ field: '/supplierId', rule: 'SUPPLIER_NOT_ACTIVE' }]);
      const now = this.clock.now();
      // The approval limit is a setting in force at the branch now (owner, 2026-11-15, A-168), read fresh, never cached.
      const limit = BigInt(await this.settings.integerAt(APPROVAL_LIMIT_SETTING, DEFAULT_APPROVAL_LIMIT_PESEWAS, now, before.branchId));
      const judgement = orderLimitJudgement(before.grossPesewas, limit);
      if (!judgement.required) {
        await this.store.markOrderJudged(tx, id, { status: 'APPROVED', thresholdPesewas: judgement.thresholdPesewas, approvalRequestId: null, at: now }, actor!.principalId);
        const view = await this.audited(tx, 'APPROVE', before, { thresholdPesewas: pesewas(judgement.thresholdPesewas) });
        await this.publishApproved(tx, view, null);
        return { status: 200, body: view };
      }
      const summary = `Purchase order to ${supplier.name}: ${before.lines.length} line(s), ${before.grossPesewas} pesewas`;
      const request = await this.approvals.request(tx, actor, {
        kind: PURCHASE_ORDER_KIND,
        branchId: before.branchId,
        subjectDocumentId: id,
        payloadHash: orderHash(before),
        amountPesewas: before.grossPesewas,
        summary,
      });
      await this.store.markOrderJudged(tx, id, { status: 'PENDING_APPROVAL', thresholdPesewas: judgement.thresholdPesewas, approvalRequestId: request.id, at: now }, actor!.principalId);
      await this.audited(tx, 'SUBMIT', before, { approvalRequestId: request.id, thresholdPesewas: pesewas(judgement.thresholdPesewas) });
      return {
        status: 202,
        body: { status: 'PENDING_APPROVAL', approvalRequestId: request.id, kind: PURCHASE_ORDER_KIND, subject: { id, docType: DOC_TYPE, number: null }, summary, requestedAt: request.requestedAt.toISOString() },
      };
    });
  }

  send(actor: Actor | undefined, id: string, body: PurchaseOrderSend, idempotencyKey: string): Promise<StoredResponse<PurchaseOrderView>> {
    return this.write(actor, SEND, 'sendPurchaseOrder', id, body, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, 'SEND', null);
      await this.store.markOrderSent(tx, id, this.clock.now(), actor!.principalId);
      const view = await this.audited(tx, 'SEND', before, { channels: [...body.channels] });
      await this.events.publish<PurchaseOrderSent>(tx, {
        type: 'pur.PurchaseOrderSent',
        subjectType: 'PurchaseOrder',
        subjectId: id,
        branchId: view.branchId,
        payload: { purchaseOrderId: id, supplierId: view.supplier.id, channels: [...body.channels], recipient: body.recipient ?? null, grossPesewas: view.grossPesewas },
      });
      return { status: 200, body: view };
    });
  }

  close(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<PurchaseOrderView>> {
    return this.end(actor, id, 'CLOSE', reason, idempotencyKey);
  }

  cancel(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<PurchaseOrderView>> {
    return this.end(actor, id, 'CANCEL', reason, idempotencyKey);
  }

  /** ApprovalHandler: the order as it is now; a change since the request voids the approval. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const order = await this.store.order(tx, subjectDocumentId);
    if (order === null) throw new NotFoundError(`no purchase order ${subjectDocumentId}`);
    return orderHash(order);
  }

  /** ApprovalHandler: approves the order in the approval's transaction, as the checker who let it happen. */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const before = await this.pending(tx, request.subjectDocumentId);
    await this.store.markOrderDecided(tx, before.id, 'APPROVED', this.clock.now(), request.decidedBy!);
    const view = await this.audited(tx, 'APPROVE', before, { approvalRequestId: request.id });
    await this.publishApproved(tx, view, request.id);
  }

  /** ApprovalHandler: a refused or withdrawn order goes back to DRAFT, to be corrected and submitted again. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const before = await this.pending(tx, request.subjectDocumentId);
    await this.store.markOrderDecided(tx, before.id, 'DRAFT', this.clock.now(), request.decidedBy ?? request.requestedBy);
    await this.audited(tx, 'REJECT', before, { approvalRequestId: request.id, decision: request.status });
  }

  /**
   * `inv.GoodsReceiptPosted`, in the receipt's transaction (FR-PUR-007): each receipt line that names an order line
   * adds its accepted quantity to that line, never past ordered plus tolerance, and the order becomes
   * PARTIALLY_RECEIVED or RECEIVED. A refusal rolls the whole receipt back.
   */
  readonly received = async (tx: Transaction, event: EventEnvelope): Promise<void> => {
    const receipt = event.payload as unknown as GoodsReceiptPosted;
    await this.recordReceiptFacts(tx, receipt, event.actorId);
    const named = receipt.lines.map((line, index) => ({ line, index })).filter((l) => l.line.purchaseOrderLineId !== null);
    if (named.length === 0) return;
    if (receipt.purchaseOrderId === null) {
      throw new ReceiptOrderMismatchError(named.map((l) => ({ field: `/lines/${l.index}/purchaseOrderLineId`, rule: 'NO_ORDER' })));
    }
    const order = await this.store.lockOrder(tx, receipt.purchaseOrderId);
    if (order === null) throw new ReceiptOrderMismatchError([{ field: '/purchaseOrderId', rule: 'NO_ORDER' }]);
    if (order.supplierId !== receipt.supplierId) throw new ReceiptOrderMismatchError([{ field: '/supplierId', rule: 'OTHER_SUPPLIER' }]);
    if (!RECEIVING.has(order.status)) throw new ReceiptOrderMismatchError([{ field: '/purchaseOrderId', rule: 'ORDER_NOT_OPEN' }]);
    const lines = new Map((await this.store.lockOrderLines(tx, named.map((l) => l.line.purchaseOrderLineId!))).map((l) => [l.id, l] as const));
    const mismatched: BrokenRule[] = [];
    const exceeded: BrokenRule[] = [];
    const received = new Map<string, Quantity>();
    for (const { line, index } of named) {
      const orderLine = lines.get(line.purchaseOrderLineId!);
      const field = `/lines/${index}/purchaseOrderLineId`;
      if (orderLine === undefined || orderLine.purchaseOrderId !== order.id) {
        mismatched.push({ field, rule: 'NOT_ON_ORDER' });
        continue;
      }
      if (orderLine.productId !== line.productId) {
        mismatched.push({ field, rule: 'PRODUCT_DIFFERS' });
        continue;
      }
      const current = received.get(orderLine.id) ?? Quantity.parse(orderLine.qtyReceived);
      const judged = judgeReceipt(
        { qtyOrderedBase: Quantity.parse(orderLine.qtyOrderedBase), qtyReceived: current, tolerance: Rate.parsePercent(orderLine.tolerancePercent) },
        Quantity.parse(line.qtyReceived),
      );
      if (!judged.ok) exceeded.push({ field: `/lines/${index}/qtyReceived`, rule: judged.error });
      else received.set(orderLine.id, judged.value);
    }
    if (mismatched.length > 0) throw new ReceiptOrderMismatchError(mismatched);
    if (exceeded.length > 0) throw new ReceiptExceedsOrderError(exceeded);
    for (const [lineId, qty] of received) await this.store.setReceived(tx, lineId, qty.toDecimalString());
    const after = order.lines.map((l) => ({ qtyOrderedBase: Quantity.parse(l.qtyOrderedBase), qtyReceived: received.get(l.id) ?? Quantity.parse(l.qtyReceived) }));
    await this.store.markOrderReceived(tx, order.id, receivedStatus(after), event.actorId);
    await this.audited(tx, 'RECEIVE', order, { goodsReceiptId: receipt.goodsReceiptId });
  };

  /**
   * The facts supplier scores read (FR-PUR-014, A-173), kept in the receipt's transaction: each line of a purchase
   * receipt from a supplier, accepted and rejected, the day it arrived and the day it was promised (the order's
   * expected date, else its date plus the supplier's lead time, else none).
   */
  private async recordReceiptFacts(tx: Transaction, receipt: GoodsReceiptPosted, actorId: string): Promise<void> {
    if (receipt.kind !== 'PURCHASE' || receipt.supplierId === null) return;
    const order = receipt.purchaseOrderId === null ? null : await this.store.order(tx, receipt.purchaseOrderId);
    const leadTime = order === null || order.expectedOn !== null ? null : await this.store.supplierLeadTimeDays(tx, receipt.supplierId);
    const promisedOn = order === null ? null : (order.expectedOn ?? (leadTime === null ? null : dueDateFrom(order.orderDate, leadTime)));
    const receivedOn = toBusinessDate(new Date(receipt.receivedAt));
    await this.store.insertReceiptFacts(
      tx,
      receipt.lines.map((line) => ({
        goodsReceiptLineId: line.goodsReceiptLineId,
        goodsReceiptId: receipt.goodsReceiptId,
        supplierId: receipt.supplierId!,
        purchaseOrderId: order?.id ?? null,
        productId: line.productId,
        receivedOn,
        promisedOn,
        qtyAccepted: line.qtyReceived,
        qtyRejected: line.qtyRejected,
        branchId: receipt.branchId,
      })),
      actorId,
    );
  }

  /** The orders as the contract shows them, for this module's invoices too. */
  async views(tx: Transaction, records: readonly OrderRecord[]): Promise<PurchaseOrderView[]> {
    const lines = records.flatMap((r) => r.lines);
    const products = await this.refs.productsIn(tx, lines.map((l) => l.productId));
    const suppliers = await this.refs.suppliersIn(tx, records.map((r) => r.supplierId));
    const locations = await this.refs.locationsIn(tx, records.map((r) => r.deliverToLocationId));
    const names = await this.principals.refs(tx, records.map((r) => r.createdBy));
    const invoiced = await this.store.invoicedQty(tx, lines.map((l) => l.id), null);
    return records.map((r) => ({
      id: r.id,
      orderNo: r.orderNo,
      status: r.status,
      supplier: supplierRef(suppliers.get(r.supplierId)!),
      deliverToLocation: locationRef(locations.get(r.deliverToLocationId)!),
      orderDate: r.orderDate,
      expectedOn: r.expectedOn,
      taxInclusive: r.taxInclusive,
      netPesewas: pesewas(r.netPesewas),
      taxPesewas: pesewas(r.taxPesewas),
      grossPesewas: pesewas(r.grossPesewas),
      currency: 'GHS' as const,
      approvalRequestId: r.approvalRequestId,
      sentAt: r.sentAt === null ? null : r.sentAt.toISOString(),
      lines: r.lines.map((l) => {
        const product = products.get(l.productId)!;
        return {
          id: l.id,
          lineNo: l.lineNo,
          product: productRef(product),
          description: l.description,
          qtyOrdered: qtyText(l.qtyOrdered),
          qtyReceived: qtyText(l.qtyReceived),
          qtyInvoiced: qtyText(invoiced.get(l.id) ?? '0'),
          uom: l.uom,
          baseUom: product.baseUom,
          qtyOrderedBase: qtyText(l.qtyOrderedBase),
          qtyOutstanding: outstanding({ qtyOrderedBase: Quantity.parse(l.qtyOrderedBase), qtyReceived: Quantity.parse(l.qtyReceived) }).toDecimalString(),
          unitPricePesewas: pesewas(l.unitPricePesewas),
          lineNetPesewas: pesewas(l.lineNetPesewas),
          overReceiptTolerancePercent: l.tolerancePercent,
          expenseCategory: l.expenseCategory,
        };
      }),
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
        const record = await this.store.order(tx, id);
        return record === null ? {} : { branchId: record.branchId, locationId: record.deliverToLocationId };
      },
      (tx) => work(tx).catch(translatePurRefusal),
    );
  }

  private end(actor: Actor | undefined, id: string, action: 'CLOSE' | 'CANCEL', reason: string, idempotencyKey: string): Promise<StoredResponse<PurchaseOrderView>> {
    return this.write(actor, CLOSE, action === 'CLOSE' ? 'closePurchaseOrder' : 'cancelPurchaseOrder', id, { reason }, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, action, null);
      const status = action === 'CLOSE' ? 'CLOSED' : 'CANCELLED';
      await this.store.markOrderEnded(tx, id, status, reason, actor!.principalId);
      const outstandingLines = before.lines.map((l) => ({
        lineNo: l.lineNo,
        qtyOutstanding: outstanding({ qtyOrderedBase: Quantity.parse(l.qtyOrderedBase), qtyReceived: Quantity.parse(l.qtyReceived) }).toDecimalString(),
      }));
      return { status: 200, body: await this.audited(tx, action, before, { reason, outstanding: outstandingLines }) };
    });
  }

  private async locked(tx: Transaction, id: string, action: OrderAction, version: number | null): Promise<OrderRecord> {
    const order = await this.store.lockOrder(tx, id);
    if (order === null) throw new NotFoundError(`no purchase order ${id}`);
    if (version !== null && order.version !== version) throw new VersionConflictError(`purchase order ${id} is at version ${order.version}, not ${version}`);
    const anyReceived = order.lines.some((l) => !Quantity.parse(l.qtyReceived).isZero());
    const judged = judgeOrderAction(order.status, action, anyReceived);
    if (!judged.ok) {
      if (judged.error === 'WRONG_STATUS') throw wrongStatus(`purchase order ${id}`, order.status);
      throw new PurchaseOrderInvalidError([{ field: '/status', rule: judged.error }]);
    }
    return order;
  }

  private async pending(tx: Transaction, id: string): Promise<OrderRecord> {
    const order = await this.store.lockOrder(tx, id);
    if (order === null) throw new NotFoundError(`no purchase order ${id}`);
    if (order.status !== 'PENDING_APPROVAL') throw wrongStatus(`purchase order ${id}`, order.status);
    return order;
  }

  private async locationScope(tx: Transaction, locationId: string): Promise<{ branchId?: string; locationId?: string }> {
    const location = (await this.refs.locationsIn(tx, [locationId])).get(locationId);
    return location === undefined ? {} : { branchId: location.branchId, locationId: location.id };
  }

  private async header(tx: Transaction, body: PurchaseOrderCreate): Promise<Omit<OrderHeader, 'netPesewas' | 'taxPesewas' | 'grossPesewas' | 'taxSchemeVersionId'>> {
    const supplier = (await this.refs.suppliersIn(tx, [body.supplierId])).get(body.supplierId);
    const location = (await this.refs.locationsIn(tx, [body.deliverToLocationId])).get(body.deliverToLocationId);
    const missing = [...(supplier === undefined ? ['/supplierId'] : []), ...(location === undefined ? ['/deliverToLocationId'] : [])];
    if (missing.length > 0) throw new PurReferenceNotFoundError(missing);
    const broken: BrokenRule[] = [];
    if (!supplier!.isLive) broken.push({ field: '/supplierId', rule: 'SUPPLIER_NOT_ACTIVE' });
    if (!location!.isLive || location!.isVirtual || NOT_RECEIVING.has(location!.kind)) broken.push({ field: '/deliverToLocationId', rule: 'NOT_A_RECEIVING_LOCATION' });
    if (body.taxInclusive === true) broken.push({ field: '/taxInclusive', rule: 'TAX_INCLUSIVE_NOT_AVAILABLE' });
    if (body.expectedOn !== undefined && body.expectedOn < body.orderDate) broken.push({ field: '/expectedOn', rule: 'EXPECTED_BEFORE_ORDER' });
    if (broken.length > 0) throw new PurchaseOrderInvalidError(broken);
    return {
      supplierId: supplier!.id,
      deliverToLocationId: location!.id,
      orderDate: body.orderDate,
      expectedOn: body.expectedOn ?? null,
      taxInclusive: false,
      branchId: location!.branchId,
    };
  }

  /** Lines checked against master data, priced exactly and taxed by MDM's calculator on the order date. */
  private async pricedLines(
    tx: Transaction,
    orderDate: string,
    inputs: readonly OrderLineInput[],
  ): Promise<{ records: OrderLineRecord[]; totals: { netPesewas: bigint; taxPesewas: bigint; grossPesewas: bigint }; versionId: string }> {
    if (inputs.length === 0) throw new PurchaseOrderInvalidError([{ field: '/lines', rule: 'NO_LINES' }]);
    const products = await this.refs.productsIn(tx, inputs.map((l) => l.productId));
    const missing = inputs.flatMap((l, i) => (products.has(l.productId) ? [] : [`/lines/${i}/productId`]));
    if (missing.length > 0) throw new PurReferenceNotFoundError(missing);
    const broken: BrokenRule[] = [];
    const seen = new Set<string>();
    const lines: Omit<OrderLineRecord, 'taxPesewas'>[] = [];
    for (const [i, input] of inputs.entries()) {
      const product = products.get(input.productId)!;
      const uom = input.uom ?? product.baseUom;
      const key = `${product.id}/${uom}`;
      if (seen.has(key)) broken.push({ field: `/lines/${i}/productId`, rule: 'LINE_REPEATED' });
      seen.add(key);
      if (!product.isLive) broken.push({ field: `/lines/${i}/productId`, rule: 'PRODUCT_NOT_ACTIVE' });
      else if (!product.isPurchasable) broken.push({ field: `/lines/${i}/productId`, rule: 'NOT_PURCHASABLE' });
      const qty = Quantity.parse(input.qtyOrdered);
      const base = await this.refs.toBaseIn(tx, product.id, uom, qty);
      if (!base.ok) {
        broken.push({ field: `/lines/${i}/${base.error === 'INEXACT_QUANTITY' ? 'qtyOrdered' : 'uom'}`, rule: base.error });
        continue;
      }
      const unitPrice = Money.ofPesewas(BigInt(input.unitPricePesewas));
      lines.push({
        id: this.nextId(),
        lineNo: lineNumber(i),
        productId: product.id,
        description: input.description ?? null,
        uom,
        qtyOrdered: qty.toDecimalString(),
        qtyOrderedBase: base.value.toDecimalString(),
        unitPricePesewas: unitPrice.pesewas,
        lineNetPesewas: orderLineNet(unitPrice, qty).pesewas,
        taxCategoryId: product.taxCategoryId,
        qtyReceived: '0.000',
        tolerancePercent: input.overReceiptTolerancePercent ?? '0',
        expenseCategory: input.expenseCategory ?? null,
      });
    }
    if (broken.length > 0) throw new PurchaseOrderInvalidError(broken);
    const taxed = await this.tax.calculateIn(tx, {
      taxInclusive: false,
      taxDate: orderDate,
      lines: lines.map((l) => ({ lineRef: l.id, taxCategoryId: l.taxCategoryId, amountPesewas: l.lineNetPesewas })),
    });
    const taxOf = new Map(taxed.lines.map((l) => [l.lineRef, l.tax.pesewas] as const));
    const records = lines.map((l) => ({ ...l, taxPesewas: taxOf.get(l.id)! }));
    return {
      records,
      totals: { netPesewas: taxed.totals.net.pesewas, taxPesewas: taxed.totals.tax.pesewas, grossPesewas: taxed.totals.gross.pesewas },
      versionId: taxed.versionId,
    };
  }

  private async view(tx: Transaction, id: string): Promise<PurchaseOrderView> {
    return (await this.views(tx, [(await this.store.order(tx, id))!]))[0]!;
  }

  private async audited(tx: Transaction, action: string, before: OrderRecord, metadata: Record<string, unknown> = {}): Promise<PurchaseOrderView> {
    const beforeView = (await this.views(tx, [before]))[0]!;
    const view = await this.view(tx, before.id);
    await this.audit.record(tx, {
      module: 'pur',
      action,
      entityType: 'PurchaseOrder',
      entityId: before.id,
      branchId: before.branchId,
      before: { ...beforeView },
      after: { ...view },
      metadata: JSON.parse(JSON.stringify(metadata)),
    });
    return view;
  }

  private async publishApproved(tx: Transaction, view: PurchaseOrderView, approvalRequestId: string | null): Promise<void> {
    await this.events.publish<PurchaseOrderApproved>(tx, {
      type: 'pur.PurchaseOrderApproved',
      subjectType: 'PurchaseOrder',
      subjectId: view.id,
      branchId: view.branchId,
      payload: { purchaseOrderId: view.id, supplierId: view.supplier.id, grossPesewas: view.grossPesewas, approvalRequestId, expectedOn: view.expectedOn },
    });
  }
}
