import { createUuidV7Generator, Money, Quantity, toBusinessDate, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRefRecord, DocumentRegistry } from '../../../platform/documents/document-registry';
import { InvalidStateTransitionError, NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { LocationFacts, MasterDataRefs, ProductFacts } from '../../mdm';
import { checkReceiptLines, type ReceiptKind, type ReceiptRuleBroken } from '../domain/goods-receipt';
import { splitEvenly } from '../domain/valuation/pool-lines';
import type { GoodsReceiptPosted, StockUnitRegistered } from '../events';
import { isInTheFuture, ordinal, pageProbe } from './counting';
import { GoodsReceiptInvalidError, InvReferenceNotFoundError } from './errors';
import type {
  AnimalPurpose,
  AnimalSex,
  GoodsReceiptStore,
  ReadScope,
  ReceiptFilters,
  ReceiptLineRecord,
  ReceiptRecord,
  ReceiptStatus,
} from './goods-receipt-store';
import type { Stock } from './stock';
import type { WeightSource } from './stock-store';

export interface AnimalArrivalInput {
  readonly tagNo: string;
  readonly sex: AnimalSex;
  readonly breed?: string | undefined;
  readonly weightKg?: string | undefined;
  readonly weightSource?: WeightSource | undefined;
  readonly dateOfBirth?: string | undefined;
  readonly purpose?: AnimalPurpose | undefined;
}

export interface ReceiptLineInput {
  readonly productId: string;
  readonly purchaseOrderLineId?: string | undefined;
  readonly qtyReceived: string;
  readonly qtyRejected?: string | undefined;
  readonly weightKg?: string | undefined;
  readonly weightSource?: WeightSource | undefined;
  readonly valuePesewas: bigint;
  readonly batchNo?: string | undefined;
  readonly expiresOn?: string | undefined;
  readonly animals?: readonly AnimalArrivalInput[] | undefined;
}

export interface GoodsReceiptCreateRequest {
  readonly kind: ReceiptKind;
  readonly supplierId?: string | undefined;
  readonly locationId: string;
  readonly purchaseOrderId?: string | undefined;
  readonly deliveryNoteRef?: string | undefined;
  readonly receivedAt: Date;
  readonly notes?: string | undefined;
  readonly lines: readonly ReceiptLineInput[];
}

/**
 * How a caller inside INV drafts and posts a receipt. Only the `OPENING_STOCK` import sheet sets `openingStock`: an
 * opening balance enters through the import's dry run, its two permissions and its once-per-branch rule, never as a
 * goods receipt over HTTP, which stays refused (`OPENING_NOT_AVAILABLE`, A-136 (a), decided in A-147).
 */
export interface ReceiptOptions {
  readonly openingStock?: true;
}

export interface GoodsReceiptUpdateRequest {
  readonly version: number;
  readonly deliveryNoteRef?: string | undefined;
  readonly receivedAt?: Date | undefined;
  readonly notes?: string | undefined;
  readonly lines?: readonly ReceiptLineInput[] | undefined;
}

interface Ref3 {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface GoodsReceiptLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly purchaseOrderLineId: string | null;
  readonly qtyReceived: string;
  readonly qtyRejected: string;
  readonly uom: string;
  readonly weightKg: string | null;
  readonly weightSource: WeightSource | null;
  readonly valuePesewas: number;
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' } | null;
  readonly batchNo: string | null;
  readonly expiresOn: string | null;
  readonly animals: ReadonlyArray<{
    readonly tagNo: string;
    readonly sex: AnimalSex;
    readonly breed: string | null;
    readonly weightKg: string | null;
    readonly weightSource: WeightSource | null;
    readonly dateOfBirth: string | null;
    readonly purpose: AnimalPurpose;
    readonly stockUnitId: string | null;
  }>;
}

export interface GoodsReceiptView {
  readonly id: string;
  readonly receiptNo: string | null;
  readonly kind: ReceiptKind;
  readonly status: ReceiptStatus;
  readonly supplier: { readonly id: string; readonly supplierNo: string; readonly name: string } | null;
  readonly location: Ref3 & { readonly kind: string };
  readonly purchaseOrder: DocumentRefRecord | null;
  readonly deliveryNoteRef: string | null;
  readonly receivedAt: string;
  readonly notes: string | null;
  readonly lines: readonly GoodsReceiptLineView[];
  readonly totalValuePesewas: number;
  readonly currency: 'GHS';
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: PrincipalRef;
  readonly postedAt: string | null;
  readonly postedBy: PrincipalRef | null;
}

export interface Page<V> {
  readonly data: readonly V[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/** The movement type and the virtual location each kind of receipt brings stock in from (ADR-0002). */
const RECEIPT_SOURCE: Readonly<Record<ReceiptKind, { readonly movementType: string; readonly virtualKind: string }>> = {
  PURCHASE: { movementType: 'RECEIPT_PURCHASE', virtualKind: 'SUPPLIER' },
  HARVEST: { movementType: 'RECEIPT_HARVEST', virtualKind: 'PRODUCTION' },
  OPENING: { movementType: 'OPENING_BALANCE', virtualKind: 'OPENING' },
};
/** Where stock may be received: a physical location that holds stock, never in-transit (FR-INV-010). */
const NOT_RECEIVING: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);
const PURCHASE_ORDER_TYPE = 'PURCHASE_ORDER';

const SYSTEM_PRINCIPAL_NAME: PrincipalRef = { id: '', displayName: 'Unknown' };

/**
 * Goods receipts (FR-INV-005, FR-INV-009): a receipt is drafted, changed while a DRAFT, and posted or cancelled.
 * Posting registers the stock units (an animal per tag, a lot per batch), writes one receipt movement per unit or
 * untracked line from the branch's virtual supplier or production location through `Stock.postIn`, in the same
 * serializable transaction, and publishes `inv.StockUnitRegistered` for each unit; the movement trigger values and
 * books the stock, and each movement publishes its own ledger event. Every handler authorises first, scoped to the
 * receipt's branch and receiving location (a storekeeper granted at the cold room cannot receive into the pens), and
 * every write is idempotent and audited with before and after. A receipt of kind OPENING is refused over HTTP: opening
 * stock is loaded only by the `OPENING_STOCK` import, which drafts and posts its receipts here with `openingStock`,
 * from the branch's virtual OPENING location as `OPENING_BALANCE` movements (A-136, A-147, ADR-0050).
 */
export class GoodsReceipts {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: GoodsReceiptStore,
    private readonly refs: MasterDataRefs,
    private readonly stock: Stock,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filters: ReceiptFilters, cursor: string | undefined, limit: number): Promise<Page<GoodsReceiptView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.goods_receipt.read');
      const scopes: ReadScope[] = (await this.authoriser.scopes(tx, actor!, 'inv.goods_receipt.read')).map((s) => ({ branchId: s.branchId, locationId: s.locationId }));
      const binding = {
        operationId: 'listGoodsReceipts',
        principalId: actor!.principalId,
        filters: { ...filters },
      };
      const after = cursor === undefined ? null : ((this.cursors.decode(cursor, binding)['id'] as string | undefined) ?? null);
      const found = await this.store.receipts(tx, filters, scopes, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return {
        data: await this.views(tx, data),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore },
      };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<GoodsReceiptView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.store.receipt(tx, id);
      await this.authoriser.authorise(tx, actor, 'inv.goods_receipt.read', record === null ? {} : { branchId: record.branchId, locationId: record.locationId });
      if (record === null) throw new NotFoundError(`no goods receipt ${id}`);
      return (await this.views(tx, [record]))[0]!;
    });
  }

  create(actor: Actor | undefined, body: GoodsReceiptCreateRequest, idempotencyKey: string): Promise<StoredResponse<GoodsReceiptView>> {
    return this.write(
      actor,
      'inv.goods_receipt.create',
      'createGoodsReceipt',
      body,
      idempotencyKey,
      async (tx) => {
        const location = (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
        return location === undefined ? {} : { branchId: location.branchId, locationId: location.id };
      },
      async (tx) => ({ status: 201, body: await this.createIn(tx, actor!, body) }),
    );
  }

  /** Drafts a receipt in the caller's transaction, every rule of createGoodsReceipt applied and audited; the caller authorised it. */
  async createIn(tx: Transaction, actor: Actor, body: GoodsReceiptCreateRequest, options: ReceiptOptions = {}): Promise<GoodsReceiptView> {
    const location = await this.receivingLocation(tx, body.locationId);
    await this.checkHeader(tx, body, false, options);
    await this.checkLines(tx, body.kind, body.receivedAt, body.lines);
    const id = this.nextId();
    await this.documents.register(tx, { id, docType: 'GOODS_RECEIPT', ownerModule: 'inv', branchId: location.branchId, actorId: actor.principalId });
    await this.store.insertHeader(
      tx,
      id,
      {
        kind: body.kind,
        supplierId: body.supplierId ?? null,
        locationId: location.id,
        orderDocumentId: body.purchaseOrderId ?? null,
        deliveryNoteRef: body.deliveryNoteRef ?? null,
        receivedAt: body.receivedAt,
        notes: body.notes ?? null,
        branchId: location.branchId,
      },
      actor.principalId,
    );
    await this.insertLines(tx, id, body.lines);
    const view = await this.view(tx, id);
    await this.audit.record(tx, { module: 'inv', action: 'CREATE', entityType: 'GoodsReceipt', entityId: id, branchId: location.branchId, before: null, after: { ...view } });
    return view;
  }

  update(actor: Actor | undefined, id: string, body: GoodsReceiptUpdateRequest, idempotencyKey: string): Promise<StoredResponse<GoodsReceiptView>> {
    return this.write(
      actor,
      'inv.goods_receipt.create',
      'updateGoodsReceipt',
      { id, ...body },
      idempotencyKey,
      (tx) => this.scopeOf(tx, id),
      async (tx) => {
        const before = await this.lockedDraft(tx, id, body.version);
        const receivedAt = body.receivedAt ?? before.receivedAt;
        if (body.lines !== undefined) {
          await this.checkLines(tx, before.kind, receivedAt, body.lines);
        } else if (body.receivedAt !== undefined) {
          await this.checkLines(tx, before.kind, receivedAt, before.lines.map(lineInputOf));
        }
        const set: Record<string, unknown> = {};
        if (body.deliveryNoteRef !== undefined) set['delivery_note_ref'] = body.deliveryNoteRef;
        if (body.receivedAt !== undefined) set['received_at'] = body.receivedAt;
        if (body.notes !== undefined) set['notes'] = body.notes;
        // The version moves on every accepted change, lines included, so a stale screen cannot overwrite them.
        if (!(await this.store.updateHeader(tx, id, body.version, set, actor!.principalId))) {
          throw new VersionConflictError(`goods receipt ${id} changed while it was updated`);
        }
        if (body.lines !== undefined) {
          await this.store.clearLines(tx, id);
          await this.insertLines(tx, id, body.lines);
        }
        const beforeView = (await this.views(tx, [before]))[0]!;
        const view = await this.view(tx, id);
        await this.audit.record(tx, { module: 'inv', action: 'UPDATE', entityType: 'GoodsReceipt', entityId: id, branchId: view.branchId, before: { ...beforeView }, after: { ...view } });
        return { status: 200, body: view };
      },
    );
  }

  cancel(actor: Actor | undefined, id: string, body: { readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<GoodsReceiptView>> {
    return this.write(
      actor,
      'inv.goods_receipt.create',
      'cancelGoodsReceipt',
      { id, ...body },
      idempotencyKey,
      (tx) => this.scopeOf(tx, id),
      async (tx) => {
        const before = await this.lockedDraft(tx, id, null);
        await this.store.markCancelled(tx, id, body.reason, actor!.principalId);
        const beforeView = (await this.views(tx, [before]))[0]!;
        const view = await this.view(tx, id);
        await this.audit.record(tx, { module: 'inv', action: 'CANCEL', entityType: 'GoodsReceipt', entityId: id, branchId: view.branchId, before: { ...beforeView }, after: { ...view, reason: body.reason } });
        return { status: 200, body: view };
      },
    );
  }

  post(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<GoodsReceiptView>> {
    return this.write(
      actor,
      'inv.goods_receipt.post',
      'postGoodsReceipt',
      { id },
      idempotencyKey,
      (tx) => this.scopeOf(tx, id),
      async (tx) => ({ status: 200, body: await this.postIn(tx, actor!, id) }),
    );
  }

  /**
   * Posts a DRAFT receipt in the caller's serializable transaction; the caller authorised `inv.goods_receipt.post`
   * for its branch and location. The rules are checked again against master data as it is now.
   */
  async postIn(tx: Transaction, actor: Actor, id: string, options: ReceiptOptions = {}): Promise<GoodsReceiptView> {
    const receipt = await this.lockedDraft(tx, id, null);
    const location = await this.receivingLocation(tx, receipt.locationId);
    await this.checkHeader(tx, { kind: receipt.kind, supplierId: receipt.supplierId ?? undefined, purchaseOrderId: receipt.orderDocumentId ?? undefined }, true, options);
    await this.checkLines(tx, receipt.kind, receipt.receivedAt, receipt.lines.map(lineInputOf));
    const source = RECEIPT_SOURCE[receipt.kind];
    const from = await this.refs.virtualLocationIn(tx, location.branchId, source.virtualKind);
    if (from === null) {
      throw new Error(`branch ${location.branchId} has no virtual ${source.virtualKind} location; every branch is created with one (ADR-0042)`);
    }
    const products = await this.refs.productsIn(tx, receipt.lines.map((l) => l.productId));
    const receivedOn = toBusinessDate(receipt.receivedAt);
    const now = this.clock.now();
    const inUse: ReceiptRuleBroken[] = [];
    for (const [index, line] of receipt.lines.entries()) {
      const product = products.get(line.productId)!;
      const identifiers = product.tracking === 'SERIAL' ? line.animals.map((a) => a.tagNo) : product.tracking === 'LOT' ? [line.batchNo!] : [];
      const taken = new Set(await this.store.activeIdentifiers(tx, line.productId, identifiers));
      if (product.tracking === 'SERIAL') {
        line.animals.forEach((a, n) => taken.has(a.tagNo) && inUse.push({ field: `/lines/${index}/animals/${n}/tagNo`, rule: 'TAG_IN_USE' }));
      } else if (taken.size > 0) {
        inUse.push({ field: `/lines/${index}/batchNo`, rule: 'BATCH_IN_USE' });
      }
    }
    if (inUse.length > 0) throw new GoodsReceiptInvalidError(inUse);

    for (const line of receipt.lines) {
      const product = products.get(line.productId)!;
      const base = {
        movementType: source.movementType,
        productId: line.productId,
        branchId: location.branchId,
        fromLocationId: from,
        toLocationId: location.id,
        costElement: 'PURCHASE' as const,
        sourceDocumentId: id,
        sourceLineRef: line.id,
        occurredAt: receipt.receivedAt,
      };
      if (product.tracking === 'SERIAL') {
        const shares = splitEvenly(Money.ofPesewas(line.valuePesewas), line.animals.length);
        for (const [n, animal] of line.animals.entries()) {
          const unitId = await this.registerUnit(tx, actor, receipt, product, animal.tagNo, null, null, animal.weightKg);
          await this.store.setAnimalUnit(tx, animal.id, unitId);
          await this.stock.postIn(tx, actor.principalId, {
            ...base,
            stockUnitId: unitId,
            qty: Quantity.ofUnits(1n),
            weight: animal.weightKg === null ? null : { kg: Weight.parseKg(animal.weightKg), source: animal.weightSource! },
            value: shares[n]!,
          });
          await this.publishUnit(tx, receipt, product, unitId, animal.tagNo, line, animal);
        }
        continue;
      }
      let unitId: string | null = null;
      if (product.tracking === 'LOT') {
        unitId = await this.registerUnit(tx, actor, receipt, product, line.batchNo!, receipt.kind === 'HARVEST' ? receivedOn : null, line.expiresOn, null);
        await this.store.setLineUnit(tx, line.id, unitId);
      }
      await this.stock.postIn(tx, actor.principalId, {
        ...base,
        stockUnitId: unitId,
        qty: Quantity.parse(line.qtyReceived),
        weight: line.weightKg === null ? null : { kg: Weight.parseKg(line.weightKg), source: line.weightSource! },
        value: Money.ofPesewas(line.valuePesewas),
      });
      if (unitId !== null) await this.publishUnit(tx, receipt, product, unitId, line.batchNo!, line, null);
    }
    await this.events.publish<GoodsReceiptPosted>(tx, {
      type: 'inv.GoodsReceiptPosted',
      subjectType: 'GoodsReceipt',
      subjectId: id,
      branchId: receipt.branchId,
      occurredAt: receipt.receivedAt,
      payload: {
        goodsReceiptId: id,
        kind: receipt.kind,
        branchId: receipt.branchId,
        locationId: receipt.locationId,
        supplierId: receipt.supplierId,
        purchaseOrderId: receipt.orderDocumentId,
        receivedAt: receipt.receivedAt.toISOString(),
        lines: receipt.lines.map((l) => ({ goodsReceiptLineId: l.id, productId: l.productId, purchaseOrderLineId: l.orderLineRef, qtyReceived: l.qtyReceived, qtyRejected: l.qtyRejected })),
      },
    });
    await this.store.markPosted(tx, id, now, actor.principalId);
    const beforeView = (await this.views(tx, [receipt]))[0]!;
    const view = await this.view(tx, id);
    await this.audit.record(tx, { module: 'inv', action: 'POST', entityType: 'GoodsReceipt', entityId: id, branchId: view.branchId, before: { ...beforeView }, after: { ...view } });
    return view;
  }

  // Shared steps.

  private async write<T>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    request: object,
    idempotencyKey: string,
    scope: (tx: Transaction) => Promise<{ branchId?: string; locationId?: string }>,
    work: (tx: Transaction) => Promise<StoredResponse<T>>,
  ): Promise<StoredResponse<T>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission, await scope(tx));
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
      if (claim.kind === 'REPLAY') {
        return claim.response as StoredResponse<T>;
      }
      const response = await work(tx);
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** The branch and receiving location a write on a receipt is scoped to; an unknown receipt is 404 after the unscoped check. */
  private async scopeOf(tx: Transaction, id: string): Promise<{ branchId?: string; locationId?: string }> {
    const record = await this.store.receipt(tx, id);
    return record === null ? {} : { branchId: record.branchId, locationId: record.locationId };
  }

  private async lockedDraft(tx: Transaction, id: string, version: number | null): Promise<ReceiptRecord> {
    const state = await this.store.lock(tx, id);
    if (state === null) throw new NotFoundError(`no goods receipt ${id}`);
    if (state.status !== 'DRAFT') throw new InvalidStateTransitionError(`goods receipt ${id} is ${state.status}`);
    if (version !== null && state.version !== version) throw new VersionConflictError(`goods receipt ${id} is at version ${state.version}, not ${version}`);
    return (await this.store.receipt(tx, id))!;
  }

  private async receivingLocation(tx: Transaction, locationId: string): Promise<LocationFacts> {
    const location = (await this.refs.locationsIn(tx, [locationId])).get(locationId);
    if (location === undefined || !location.isLive) throw new InvReferenceNotFoundError(['/locationId']);
    if (location.isVirtual || NOT_RECEIVING.has(location.kind)) {
      throw new GoodsReceiptInvalidError([{ field: '/locationId', rule: 'NOT_A_RECEIVING_LOCATION' }]);
    }
    return location;
  }

  private async checkHeader(
    tx: Transaction,
    header: { readonly kind: ReceiptKind; readonly supplierId?: string | undefined; readonly purchaseOrderId?: string | undefined },
    posting = false,
    options: ReceiptOptions = {},
  ): Promise<void> {
    if (header.kind === 'OPENING' && options.openingStock !== true) {
      throw new GoodsReceiptInvalidError([{ field: '/kind', rule: 'OPENING_NOT_AVAILABLE' }]);
    }
    if (header.kind === 'PURCHASE' && header.supplierId === undefined) {
      throw new GoodsReceiptInvalidError([{ field: '/supplierId', rule: 'SUPPLIER_REQUIRED' }]);
    }
    if (header.kind !== 'PURCHASE' && header.supplierId !== undefined) {
      throw new GoodsReceiptInvalidError([{ field: '/supplierId', rule: 'NOT_FOR_THIS_KIND' }]);
    }
    if (header.supplierId !== undefined) {
      const supplier = (await this.refs.suppliersIn(tx, [header.supplierId])).get(header.supplierId);
      if (supplier === undefined || (!posting && !supplier.isLive)) throw new InvReferenceNotFoundError(['/supplierId']);
      if (!supplier.isLive) throw new GoodsReceiptInvalidError([{ field: '/supplierId', rule: 'SUPPLIER_NOT_ACTIVE' }]);
    }
    if (header.purchaseOrderId !== undefined && (await this.documents.refs(tx, [header.purchaseOrderId])).get(header.purchaseOrderId)?.docType !== PURCHASE_ORDER_TYPE) {
      throw new InvReferenceNotFoundError(['/purchaseOrderId']);
    }
  }

  private async checkLines(tx: Transaction, kind: ReceiptKind, receivedAt: Date, lines: readonly ReceiptLineInput[]): Promise<void> {
    if (isInTheFuture(receivedAt, this.clock.now())) throw new GoodsReceiptInvalidError([{ field: '/receivedAt', rule: 'IN_THE_FUTURE' }]);
    if (lines.length === 0) throw new GoodsReceiptInvalidError([{ field: '/lines', rule: 'NO_LINES' }]);
    const products = await this.refs.productsIn(tx, lines.map((l) => l.productId));
    const missing = lines.flatMap((l, index) => (products.has(l.productId) ? [] : [`/lines/${index}/productId`]));
    if (missing.length > 0) throw new InvReferenceNotFoundError(missing);
    const broken: ReceiptRuleBroken[] = [];
    lines.forEach((l, index) => {
      if ((l.weightKg === undefined) !== (l.weightSource === undefined)) broken.push({ field: `/lines/${index}/weightSource`, rule: 'WEIGHT_NEEDS_SOURCE' });
      (l.animals ?? []).forEach((a, n) => {
        if ((a.weightKg === undefined) !== (a.weightSource === undefined)) broken.push({ field: `/lines/${index}/animals/${n}/weightSource`, rule: 'WEIGHT_NEEDS_SOURCE' });
      });
    });
    broken.push(
      ...checkReceiptLines({
        kind,
        receivedOn: toBusinessDate(receivedAt),
        lines: lines.map((l) => ({
          productId: l.productId,
          product: products.get(l.productId)!,
          draft: {
            qtyReceived: Quantity.parse(l.qtyReceived),
            value: Money.ofPesewas(l.valuePesewas),
            batchNo: l.batchNo ?? null,
            expiresOn: l.expiresOn ?? null,
            animalTags: (l.animals ?? []).map((a) => a.tagNo),
          },
        })),
      }),
    );
    if (broken.length > 0) throw new GoodsReceiptInvalidError(broken);
  }

  private async insertLines(tx: Transaction, receiptId: string, lines: readonly ReceiptLineInput[]): Promise<void> {
    for (const [index, line] of lines.entries()) {
      const lineId = this.nextId();
      await this.store.insertLine(tx, receiptId, {
        id: lineId,
        lineNo: ordinal(index),
        productId: line.productId,
        orderLineRef: line.purchaseOrderLineId ?? null,
        qtyReceived: Quantity.parse(line.qtyReceived).toDecimalString(),
        qtyRejected: Quantity.parse(line.qtyRejected ?? '0').toDecimalString(),
        weightKg: line.weightKg === undefined ? null : Weight.parseKg(line.weightKg).toKgString(),
        weightSource: line.weightSource ?? null,
        valuePesewas: line.valuePesewas,
        batchNo: line.batchNo ?? null,
        expiresOn: line.expiresOn ?? null,
      });
      for (const [n, animal] of (line.animals ?? []).entries()) {
        await this.store.insertAnimal(tx, lineId, {
          id: this.nextId(),
          seqNo: ordinal(n),
          tagNo: animal.tagNo,
          sex: animal.sex,
          breed: animal.breed ?? null,
          weightKg: animal.weightKg === undefined ? null : Weight.parseKg(animal.weightKg).toKgString(),
          weightSource: animal.weightSource ?? null,
          dateOfBirth: animal.dateOfBirth ?? null,
          purpose: animal.purpose ?? 'GROWING',
        });
      }
    }
  }

  private async registerUnit(
    tx: Transaction,
    actor: Actor,
    receipt: ReceiptRecord,
    product: ProductFacts,
    identifier: string,
    producedOn: string | null,
    expiresOn: string | null,
    weightKg: string | null,
  ): Promise<string> {
    const unitId = this.nextId();
    await this.store.insertStockUnit(
      tx,
      {
        id: unitId,
        productId: product.id,
        tracking: product.tracking as 'SERIAL' | 'LOT',
        branchId: receipt.branchId,
        identifier,
        producedOn,
        expiresOn,
        storageTempClass: product.storageTempClass,
        supplierId: receipt.supplierId,
        sourceDocumentId: receipt.id,
        lastWeightKg: weightKg,
        lastWeighedAt: weightKg === null ? null : receipt.receivedAt,
      },
      actor.principalId,
    );
    return unitId;
  }

  private async publishUnit(
    tx: Transaction,
    receipt: ReceiptRecord,
    product: ProductFacts,
    unitId: string,
    identifier: string,
    line: ReceiptLineRecord,
    animal: ReceiptLineRecord['animals'][number] | null,
  ): Promise<void> {
    await this.events.publish<StockUnitRegistered>(tx, {
      type: 'inv.StockUnitRegistered',
      subjectType: 'StockUnit',
      subjectId: unitId,
      branchId: receipt.branchId,
      occurredAt: receipt.receivedAt,
      payload: {
        stockUnitId: unitId,
        productId: product.id,
        tracking: product.tracking as 'SERIAL' | 'LOT',
        identifier,
        locationId: receipt.locationId,
        supplierId: receipt.supplierId,
        sourceDocumentId: receipt.id,
        sourceLineRef: line.id,
        expiresOn: line.expiresOn,
        animal:
          animal === null
            ? null
            : { sex: animal.sex, breed: animal.breed, weightKg: animal.weightKg, weightSource: animal.weightSource, dateOfBirth: animal.dateOfBirth, purpose: animal.purpose },
      },
    });
  }

  private async view(tx: Transaction, id: string): Promise<GoodsReceiptView> {
    return (await this.views(tx, [(await this.store.receipt(tx, id))!]))[0]!;
  }

  private async views(tx: Transaction, records: readonly ReceiptRecord[]): Promise<GoodsReceiptView[]> {
    const lines = records.flatMap((r) => r.lines);
    const products = await this.refs.productsIn(tx, lines.map((l) => l.productId));
    const locations = await this.refs.locationsIn(tx, records.map((r) => r.locationId));
    const suppliers = await this.refs.suppliersIn(tx, records.flatMap((r) => (r.supplierId === null ? [] : [r.supplierId])));
    const units = await this.store.unitRefs(tx, lines.flatMap((l) => (l.stockUnitId === null ? [] : [l.stockUnitId])));
    const principals = await this.principals.refs(tx, records.flatMap((r) => [r.createdBy, ...(r.postedBy === null ? [] : [r.postedBy])]));
    const orders = await this.documents.refs(tx, records.flatMap((r) => (r.orderDocumentId === null ? [] : [r.orderDocumentId])));
    return records.map((r) => {
      const location = locations.get(r.locationId)!;
      const supplier = r.supplierId === null ? null : suppliers.get(r.supplierId)!;
      return {
        id: r.id,
        receiptNo: r.receiptNo,
        kind: r.kind,
        status: r.status,
        supplier: supplier === null ? null : { id: supplier.id, supplierNo: supplier.supplierNo, name: supplier.name },
        location: { id: location.id, code: location.code, name: location.name, kind: location.kind },
        purchaseOrder: r.orderDocumentId === null ? null : (orders.get(r.orderDocumentId) ?? null),
        deliveryNoteRef: r.deliveryNoteRef,
        receivedAt: r.receivedAt.toISOString(),
        notes: r.notes,
        lines: r.lines.map((l) => {
          const product = products.get(l.productId)!;
          const unit = l.stockUnitId === null ? null : units.get(l.stockUnitId)!;
          return {
            id: l.id,
            lineNo: l.lineNo,
            product: { id: product.id, sku: product.sku, name: product.name },
            purchaseOrderLineId: l.orderLineRef,
            qtyReceived: l.qtyReceived,
            qtyRejected: l.qtyRejected,
            uom: product.baseUom,
            weightKg: l.weightKg,
            weightSource: l.weightSource,
            valuePesewas: Money.ofPesewas(l.valuePesewas).toJsonInteger(),
            stockUnit: unit === null ? null : { id: unit.id, identifier: unit.identifier, tracking: unit.tracking },
            batchNo: l.batchNo,
            expiresOn: l.expiresOn,
            animals: l.animals.map((a) => ({
              tagNo: a.tagNo,
              sex: a.sex,
              breed: a.breed,
              weightKg: a.weightKg,
              weightSource: a.weightSource,
              dateOfBirth: a.dateOfBirth,
              purpose: a.purpose,
              stockUnitId: a.stockUnitId,
            })),
          };
        }),
        totalValuePesewas: Money.sum(r.lines.map((l) => Money.ofPesewas(l.valuePesewas))).toJsonInteger(),
        currency: 'GHS',
        branchId: r.branchId,
        version: r.version,
        createdAt: r.createdAt.toISOString(),
        createdBy: principals.get(r.createdBy) ?? { ...SYSTEM_PRINCIPAL_NAME, id: r.createdBy },
        postedAt: r.postedAt?.toISOString() ?? null,
        postedBy: r.postedBy === null ? null : (principals.get(r.postedBy) ?? { ...SYSTEM_PRINCIPAL_NAME, id: r.postedBy }),
      };
    });
  }
}

/** A stored line as the input the rules check, for a re-check at posting or after a date change. */
function lineInputOf(line: ReceiptLineRecord): ReceiptLineInput {
  return {
    productId: line.productId,
    qtyReceived: line.qtyReceived,
    valuePesewas: line.valuePesewas,
    weightKg: line.weightKg ?? undefined,
    weightSource: line.weightSource ?? undefined,
    batchNo: line.batchNo ?? undefined,
    expiresOn: line.expiresOn ?? undefined,
    animals: line.animals.map((a) => ({
      tagNo: a.tagNo,
      sex: a.sex,
      weightKg: a.weightKg ?? undefined,
      weightSource: a.weightSource ?? undefined,
    })),
  };
}
