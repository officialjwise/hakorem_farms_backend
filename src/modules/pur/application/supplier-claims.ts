import { createUuidV7Generator, Money, Quantity, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRefRecord, DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { GoodsReceipts } from '../../inv';
import type { MasterDataRefs } from '../../mdm';
import { claimLineValue, judgeClaimSettledByInvoice } from '../domain/claim';
import type { SupplierClaimRaised } from '../events';
import { PurReferenceNotFoundError, SupplierClaimInvalidError, translatePurRefusal, wrongStatus, type BrokenRule } from './errors';
import { lineNumber, pesewas, principalRef, productRef, readPage, runPurchaseCommand, supplierRef, wholeBranches, type Page } from './purchase-command';
import type { PurchasingStore } from './purchasing-store';
import type { ClaimFilter, ClaimLineRecord, ClaimRecord, ClaimSettlement, ClaimStatus, SupplierClaimStore } from './supplier-claim-store';
import type { SupplierInvoices, SupplierInvoiceView } from './supplier-invoices';

const DOC_TYPE = 'SUPPLIER_CLAIM';
const READ = 'pur.supplier_invoice.read';
const CREATE = 'pur.supplier_invoice.create';
const MATCH = 'pur.supplier_invoice.match';
/** THREAT_MODEL abuse case 34: rejections inflated at the door to claim a credit the supplier never owed. */
const ABUSE_CASES = [34] as const;

/** The contract's `SupplierClaimLine`. */
export interface SupplierClaimLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly goodsReceiptLineId: string;
  readonly purchaseOrderLineId: string;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly rejectionReasonCode: string;
  readonly baseUom: string;
  readonly qtyDeliveredBase: string;
  readonly qtyAcceptedBase: string;
  readonly qtyRejectedBase: string;
  readonly orderUom: string;
  readonly orderUnitPricePesewas: number;
  readonly lineValuePesewas: number;
  readonly acceptedValuePesewas: number;
  readonly claimedValuePesewas: number;
}

/** The contract's `SupplierClaim`. */
export interface SupplierClaimView {
  readonly id: string;
  readonly status: ClaimStatus;
  readonly supplier: { readonly id: string; readonly publicId: string; readonly name: string };
  readonly purchaseOrder: DocumentRefRecord;
  readonly goodsReceipt: DocumentRefRecord;
  readonly receivedBy: PrincipalRef;
  readonly note: string | null;
  readonly claimedPesewas: number;
  readonly currency: 'GHS';
  readonly lines: readonly SupplierClaimLineView[];
  /** The credit note drafted from the claim and not cancelled, waiting or approved; null if none. */
  readonly creditNote: { readonly id: string; readonly supplierInvoiceNo: string; readonly status: string } | null;
  readonly settlement: ClaimSettlement | null;
  /** The invoice or credit note that settled the claim; null while it is open. */
  readonly settledBy: { readonly id: string; readonly kind: 'INVOICE' | 'CREDIT_NOTE'; readonly supplierInvoiceNo: string } | null;
  readonly settledAt: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: PrincipalRef;
}

export interface ClaimCreditNoteDraft {
  readonly originalInvoiceId: string;
  readonly supplierInvoiceNo: string;
  readonly invoiceDate: string;
}

/**
 * Claims raised from a posted goods receipt's rejected lines (the owner's decision 5, CR-036, ADR-0076). A claim is the
 * receipt's rejected lines at the order price, split exactly with `allocate` between what was accepted and what is
 * claimed, never keyed by hand. It moves no stock and posts nothing, and stays OPEN on the supplier's account until it is
 * settled once:
 * - by the invoice that left the rejected goods out (`settle`); or
 * - by the credit note drafted from it against the invoice that charged them (`draftCreditNote`, then the credit
 *   note's own approval, which settles the claim).
 * Every handler authorises in the handler, scoped to the claim's branch, and every write is idempotent and audited.
 */
export class SupplierClaims {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly claims: SupplierClaimStore,
    private readonly store: PurchasingStore,
    private readonly invoices: SupplierInvoices,
    private readonly receipts: GoodsReceipts,
    private readonly refs: MasterDataRefs,
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

  list(actor: Actor | undefined, filter: ClaimFilter, cursor: string | undefined, limit: number): Promise<Page<SupplierClaimView>> {
    return this.uow.run({ isolation: 'read committed' }, (tx) =>
      readPage<ClaimRecord, SupplierClaimView>(
        tx,
        { authoriser: this.authoriser, cursors: this.cursors },
        actor,
        READ,
        'listSupplierClaims',
        { status: filter.status ?? null, supplierId: filter.supplierId ?? null, purchaseOrderId: filter.purchaseOrderId ?? null, goodsReceiptId: filter.goodsReceiptId ?? null },
        cursor,
        limit,
        (scopes, before, n) => this.claims.listClaims(tx, filter, wholeBranches(scopes), before, n),
        (records) => this.views(tx, records),
      ),
    );
  }

  /**
   * `listGoodsReceiptClaims`: the receipt answers its claims (CR-036 point 2). The receipt is checked first, at its own
   * branch, so a receipt of a branch the caller does not hold answers like one that does not exist.
   */
  listForReceipt(actor: Actor | undefined, goodsReceiptId: string, cursor: string | undefined, limit: number): Promise<Page<SupplierClaimView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const receipt = await this.receipts.factsIn(tx, goodsReceiptId);
      await this.authoriser.authorise(tx, actor, READ, receipt === null ? {} : { branchId: receipt.branchId });
      if (receipt === null) throw new NotFoundError(`no goods receipt ${goodsReceiptId}`);
      const filter: ClaimFilter = { goodsReceiptId };
      return readPage<ClaimRecord, SupplierClaimView>(
        tx,
        { authoriser: this.authoriser, cursors: this.cursors },
        actor,
        READ,
        'listGoodsReceiptClaims',
        { goodsReceiptId },
        cursor,
        limit,
        (scopes, before, n) => this.claims.listClaims(tx, filter, wholeBranches(scopes), before, n),
        (records) => this.views(tx, records),
      );
    });
  }

  get(actor: Actor | undefined, id: string): Promise<SupplierClaimView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.claims.claim(tx, id);
      await this.authoriser.authorise(tx, actor, READ, record === null ? {} : { branchId: record.branchId });
      if (record === null) throw new NotFoundError(`no supplier claim ${id}`);
      return (await this.views(tx, [record]))[0]!;
    });
  }

  /**
   * `raiseSupplierClaim`: one claim per posted purchase receipt with rejected lines, each rejected line at its order line's
   * price, from the base quantities INV stored (A-263) and the line's rejection reason (A-269). Nothing is moved or
   * posted; `pur.SupplierClaimRaised` is published for the daily exception report (abuse case 34).
   */
  raise(actor: Actor | undefined, goodsReceiptId: string, body: { readonly note?: string | undefined }, idempotencyKey: string): Promise<StoredResponse<SupplierClaimView>> {
    return runPurchaseCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      CREATE,
      'raiseSupplierClaim',
      { goodsReceiptId, ...body },
      idempotencyKey,
      async (tx) => {
        const facts = await this.receipts.factsIn(tx, goodsReceiptId);
        return facts === null ? {} : { branchId: facts.branchId };
      },
      async (tx) => {
        const receipt = await this.receipts.factsIn(tx, goodsReceiptId);
        if (receipt === null) throw new NotFoundError(`no goods receipt ${goodsReceiptId}`);
        if (receipt.status !== 'POSTED') throw new SupplierClaimInvalidError([{ field: '/goodsReceiptId', rule: 'RECEIPT_NOT_POSTED' }]);
        if (receipt.kind !== 'PURCHASE' || receipt.supplierId === null) throw new SupplierClaimInvalidError([{ field: '/goodsReceiptId', rule: 'NOT_A_PURCHASE' }]);
        if (receipt.purchaseOrderId === null) throw new SupplierClaimInvalidError([{ field: '/goodsReceiptId', rule: 'NO_ORDER' }]);
        if ((await this.claims.claimOfReceipt(tx, goodsReceiptId)) !== null) throw new SupplierClaimInvalidError([{ field: '/goodsReceiptId', rule: 'CLAIM_EXISTS' }]);
        const rejected = receipt.lines.filter((l) => !Quantity.parse(l.qtyRejectedBase).isZero());
        if (rejected.length === 0) throw new SupplierClaimInvalidError([{ field: '/goodsReceiptId', rule: 'NOTHING_REJECTED' }]);
        const order = (await this.store.order(tx, receipt.purchaseOrderId))!;
        const orderLines = new Map(order.lines.map((l) => [l.id, l] as const));
        const broken: BrokenRule[] = [];
        const lines: ClaimLineRecord[] = [];
        for (const line of rejected) {
          const index = receipt.lines.indexOf(line);
          const orderLine = line.purchaseOrderLineId === null ? undefined : orderLines.get(line.purchaseOrderLineId);
          if (orderLine === undefined) {
            broken.push({ field: `/lines/${index}`, rule: 'NO_ORDER_LINE' });
            continue;
          }
          const value = claimLineValue({
            unitPrice: Money.ofPesewas(orderLine.unitPricePesewas),
            qtyOrdered: Quantity.parse(orderLine.qtyOrdered),
            qtyOrderedBase: Quantity.parse(orderLine.qtyOrderedBase),
            qtyAcceptedBase: Quantity.parse(line.qtyReceivedBase),
            qtyRejectedBase: Quantity.parse(line.qtyRejectedBase),
          });
          if (value.claimed.isZero()) {
            broken.push({ field: `/lines/${index}`, rule: 'NOTHING_TO_CLAIM' });
            continue;
          }
          lines.push({
            id: this.nextId(),
            lineNo: lineNumber(lines.length),
            goodsReceiptLineId: line.id,
            purchaseOrderLineId: orderLine.id,
            productId: line.productId,
            rejectionReasonCode: line.rejectionReasonCode!,
            qtyAcceptedBase: Quantity.parse(line.qtyReceivedBase).toDecimalString(),
            qtyRejectedBase: Quantity.parse(line.qtyRejectedBase).toDecimalString(),
            lineValuePesewas: value.lineValue.pesewas,
            acceptedValuePesewas: value.accepted.pesewas,
            claimedValuePesewas: value.claimed.pesewas,
          });
        }
        if (broken.length > 0) throw new SupplierClaimInvalidError(broken);
        const id = this.nextId();
        const now = this.clock.now();
        const claimed = lines.reduce((sum, l) => sum + l.claimedValuePesewas, 0n);
        await this.documents.register(tx, { id, docType: DOC_TYPE, ownerModule: 'pur', branchId: receipt.branchId, actorId: actor!.principalId });
        await this.claims.insertClaim(tx, {
          id,
          supplierId: receipt.supplierId,
          purchaseOrderId: receipt.purchaseOrderId,
          goodsReceiptId,
          receivedBy: receipt.postedBy!,
          note: body.note?.trim() ?? null,
          claimedPesewas: claimed,
          branchId: receipt.branchId,
          createdAt: now,
          createdBy: actor!.principalId,
          lines,
        });
        const view = await this.view(tx, id);
        await this.audit.record(tx, { module: 'pur', action: 'CREATE', entityType: 'SupplierClaim', entityId: id, branchId: receipt.branchId, before: null, after: { ...view } });
        await this.events.publish<SupplierClaimRaised>(tx, {
          type: 'pur.SupplierClaimRaised',
          subjectType: 'SupplierClaim',
          subjectId: id,
          branchId: receipt.branchId,
          payload: {
            supplierClaimId: id,
            supplierId: receipt.supplierId,
            purchaseOrderId: receipt.purchaseOrderId,
            goodsReceiptId,
            receivedBy: receipt.postedBy!,
            raisedBy: actor!.principalId,
            claimedPesewas: pesewas(claimed),
            lines: lines.map((l) => ({
              lineNo: l.lineNo,
              productId: l.productId,
              rejectionReasonCode: l.rejectionReasonCode,
              qtyAcceptedBase: l.qtyAcceptedBase,
              qtyRejectedBase: l.qtyRejectedBase,
              claimedValuePesewas: pesewas(l.claimedValuePesewas),
            })),
            abuseCases: [...ABUSE_CASES],
          },
        });
        return { status: 201, body: view };
      },
    ).catch(translatePurRefusal);
  }

  /** `draftSupplierClaimCreditNote`: the claim's credit note as a DRAFT, against the approved invoice that charged its goods. */
  draftCreditNote(actor: Actor | undefined, id: string, body: ClaimCreditNoteDraft, idempotencyKey: string): Promise<StoredResponse<SupplierInvoiceView>> {
    return this.write(actor, CREATE, 'draftSupplierClaimCreditNote', id, body, idempotencyKey, async (tx) => {
      const claim = await this.open(tx, id);
      const credit = await this.invoices.draftClaimCreditIn(tx, actor!, claim, body);
      return { status: 201, body: credit };
    });
  }

  /**
   * `settleSupplierClaim`: the claim is settled by an approved invoice of its order that left the rejected goods out:
   * no live invoice holds more of any order line the claim names than was received and what credit notes of other
   * claims cover (`CLAIM_INVOICED` otherwise: the supplier charged them, so a credit note settles the claim instead).
   */
  settle(actor: Actor | undefined, id: string, body: { readonly supplierInvoiceId: string }, idempotencyKey: string): Promise<StoredResponse<SupplierClaimView>> {
    return this.write(actor, MATCH, 'settleSupplierClaim', id, body, idempotencyKey, async (tx) => {
      const claim = await this.open(tx, id);
      const invoice = await this.store.lockInvoice(tx, body.supplierInvoiceId);
      if (invoice === null) throw new PurReferenceNotFoundError(['/supplierInvoiceId']);
      if (invoice.kind !== 'INVOICE' || (invoice.status !== 'APPROVED' && invoice.status !== 'PAID')) {
        throw new SupplierClaimInvalidError([{ field: '/supplierInvoiceId', rule: 'INVOICE_NOT_APPROVED' }]);
      }
      if (invoice.purchaseOrderId !== claim.purchaseOrderId) throw new SupplierClaimInvalidError([{ field: '/supplierInvoiceId', rule: 'ORDER_DIFFERS' }]);
      const orderLineIds = [...new Set(claim.lines.map((l) => l.purchaseOrderLineId))];
      const invoicedHere = new Set(invoice.lines.flatMap((l) => (l.purchaseOrderLineId === null ? [] : [l.purchaseOrderLineId])));
      if (orderLineIds.some((l) => !invoicedHere.has(l))) throw new SupplierClaimInvalidError([{ field: '/supplierInvoiceId', rule: 'ORDER_LINE_NOT_INVOICED' }]);
      const orderLines = new Map((await this.store.lockOrderLines(tx, orderLineIds)).map((l) => [l.id, l] as const));
      const invoiced = await this.store.invoicedQty(tx, orderLineIds, null);
      const credited = await this.claims.creditedQty(tx, orderLineIds, claim.id);
      for (const orderLineId of orderLineIds) {
        const judged = judgeClaimSettledByInvoice({
          received: Quantity.parse(orderLines.get(orderLineId)!.qtyReceived),
          invoiced: Quantity.parse(invoiced.get(orderLineId) ?? '0.000'),
          creditedByOtherClaims: Quantity.parse(credited.get(orderLineId) ?? '0.000'),
        });
        if (!judged.ok) throw new SupplierClaimInvalidError([{ field: '/supplierInvoiceId', rule: judged.error }]);
      }
      await this.invoices.settleClaimIn(tx, claim, 'INVOICE', invoice.id, actor!.principalId, this.clock.now());
      return { status: 200, body: await this.view(tx, id) };
    });
  }

  /** The claims as the contract shows them. */
  async views(tx: Transaction, records: readonly ClaimRecord[]): Promise<SupplierClaimView[]> {
    const lines = records.flatMap((r) => r.lines);
    const products = await this.refs.productsIn(tx, lines.map((l) => l.productId));
    const suppliers = await this.refs.suppliersIn(tx, records.map((r) => r.supplierId));
    const documents = await this.documents.numberedRefs(tx, records.flatMap((r) => [r.purchaseOrderId, r.goodsReceiptId]));
    const names = await this.principals.refs(tx, records.flatMap((r) => [r.createdBy, r.receivedBy]));
    const orderLines = new Map((await this.store.orderLinesIn(tx, lines.map((l) => l.purchaseOrderLineId))).map((l) => [l.id, l] as const));
    const credits = await this.claims.liveCreditNotes(tx, records.map((r) => r.id));
    const settling = new Map((await this.store.invoices(tx, records.flatMap((r) => (r.settledByInvoiceId === null ? [] : [r.settledByInvoiceId])))).map((i) => [i.id, i] as const));
    return records.map((r) => {
      const settledBy = r.settledByInvoiceId === null ? undefined : settling.get(r.settledByInvoiceId);
      return {
        id: r.id,
        status: r.status,
        supplier: supplierRef(suppliers.get(r.supplierId)!),
        purchaseOrder: documents.get(r.purchaseOrderId)!,
        goodsReceipt: documents.get(r.goodsReceiptId)!,
        receivedBy: principalRef(names, r.receivedBy),
        note: r.note,
        claimedPesewas: pesewas(r.claimedPesewas),
        currency: 'GHS' as const,
        lines: r.lines.map((l) => {
          const orderLine = orderLines.get(l.purchaseOrderLineId)!;
          const product = products.get(l.productId)!;
          return {
            id: l.id,
            lineNo: l.lineNo,
            goodsReceiptLineId: l.goodsReceiptLineId,
            purchaseOrderLineId: l.purchaseOrderLineId,
            product: productRef(product),
            rejectionReasonCode: l.rejectionReasonCode,
            baseUom: product.baseUom,
            qtyDeliveredBase: Quantity.parse(l.qtyAcceptedBase).plus(Quantity.parse(l.qtyRejectedBase)).toDecimalString(),
            qtyAcceptedBase: Quantity.parse(l.qtyAcceptedBase).toDecimalString(),
            qtyRejectedBase: Quantity.parse(l.qtyRejectedBase).toDecimalString(),
            orderUom: orderLine.uom,
            orderUnitPricePesewas: pesewas(orderLine.unitPricePesewas),
            lineValuePesewas: pesewas(l.lineValuePesewas),
            acceptedValuePesewas: pesewas(l.acceptedValuePesewas),
            claimedValuePesewas: pesewas(l.claimedValuePesewas),
          };
        }),
        creditNote: credits.get(r.id) ?? null,
        settlement: r.settlement,
        settledBy: settledBy === undefined ? null : { id: settledBy.id, kind: settledBy.kind, supplierInvoiceNo: settledBy.supplierInvoiceNo },
        settledAt: r.postedAt?.toISOString() ?? null,
        branchId: r.branchId,
        version: r.version,
        createdAt: r.createdAt.toISOString(),
        createdBy: principalRef(names, r.createdBy),
      };
    });
  }

  private async view(tx: Transaction, id: string): Promise<SupplierClaimView> {
    return (await this.views(tx, [(await this.claims.claim(tx, id))!]))[0]!;
  }

  /** The claim locked for settling: OPEN, and with no credit note drafted from it that is not cancelled. */
  private async open(tx: Transaction, id: string): Promise<ClaimRecord> {
    const claim = await this.claims.lockClaim(tx, id);
    if (claim === null) throw new NotFoundError(`no supplier claim ${id}`);
    if (claim.status !== 'OPEN') throw wrongStatus(`supplier claim ${id}`, claim.status);
    if ((await this.claims.liveCreditNotes(tx, [id])).has(id)) throw new SupplierClaimInvalidError([{ field: '/status', rule: 'CREDIT_NOTE_EXISTS' }]);
    return claim;
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
        const record = await this.claims.claim(tx, id);
        return record === null ? {} : { branchId: record.branchId };
      },
      work,
    ).catch(translatePurRefusal);
  }
}
