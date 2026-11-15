import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { judgeRequisitionAction, planConversion, type RequisitionAction, type RequisitionStatus } from '../domain/requisition';
import type { RequisitionSubmitted } from '../events';
import { PurchaseRequisitionInvalidError, PurReferenceNotFoundError, translatePurRefusal, wrongStatus, type BrokenRule } from './errors';
import type { PurchaseOrders, PurchaseOrderView } from './purchase-orders';
import { locationRef, principalRef, productRef, readPage, runPurchaseCommand, type Page } from './purchase-command';
import type { RequisitionFilter, RequisitionLineRecord, RequisitionRecord, SupplierRegisterStore } from './supplier-register-store';

const DOC_TYPE = 'PURCHASE_REQUISITION';
const READ = 'pur.requisition.read';
const CREATE = 'pur.requisition.create';
const APPROVE = 'pur.requisition.approve';
const ORDER_CREATE = 'pur.purchase_order.create';

export interface RequisitionLineInput {
  readonly productId: string;
  readonly qty: string;
  readonly note?: string | undefined;
}

export interface PurchaseRequisitionCreate {
  readonly locationId?: string | undefined;
  readonly neededBy?: string | undefined;
  readonly justification?: string | undefined;
  readonly lines: readonly RequisitionLineInput[];
}

export interface PurchaseRequisitionUpdate {
  readonly version: number;
  readonly neededBy?: string | undefined;
  readonly justification?: string | undefined;
  readonly lines?: readonly RequisitionLineInput[] | undefined;
}

export interface RequisitionConvert {
  readonly supplierId: string;
  readonly deliverToLocationId: string;
  readonly expectedOn?: string | undefined;
  readonly lines: readonly { readonly lineId: string; readonly unitPricePesewas: number; readonly qty?: string | undefined }[];
}

/** The contract's `PurchaseRequisition`. */
export interface PurchaseRequisitionView {
  readonly id: string;
  readonly requisitionNo: string | null;
  readonly status: RequisitionStatus;
  readonly requestedBy: { readonly id: string; readonly displayName: string };
  readonly location: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string } | null;
  readonly neededBy: string | null;
  readonly justification: string | null;
  readonly rejectReason: string | null;
  readonly lines: readonly {
    readonly id: string;
    readonly lineNo: number;
    readonly product: { readonly id: string; readonly sku: string; readonly name: string };
    readonly qty: string;
    readonly uom: string;
    readonly note: string | null;
  }[];
  readonly purchaseOrder: { readonly id: string; readonly docType: 'PURCHASE_ORDER'; readonly number: string | null } | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly displayName: string };
}

/**
 * Purchase requisitions (FR-PUR-004): a storekeeper or farm hand asks for products, quantities in their base unit and a
 * needed-by date, at the location their grant names; a manager rejects the submitted requisition with a reason or
 * converts it into a draft purchase order, which then follows the order's own approval limit. A rejected requisition
 * is never converted, and a converted one names its order. Every handler authorises first; every change is audited.
 */
export class Requisitions {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: SupplierRegisterStore,
    private readonly orders: PurchaseOrders,
    private readonly refs: MasterDataRefs,
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

  list(actor: Actor | undefined, filter: RequisitionFilter, cursor: string | undefined, limit: number): Promise<Page<PurchaseRequisitionView>> {
    return this.uow.run({ isolation: 'read committed' }, (tx) =>
      readPage<RequisitionRecord, PurchaseRequisitionView>(
        tx,
        { authoriser: this.authoriser, cursors: this.cursors },
        actor,
        READ,
        'listPurchaseRequisitions',
        { status: filter.status ?? null, requestedBy: filter.requestedBy ?? null },
        cursor,
        limit,
        (scopes, before, n) => this.store.listRequisitions(tx, filter, scopes, before, n),
        (records) => this.views(tx, records),
      ),
    );
  }

  get(actor: Actor | undefined, id: string): Promise<PurchaseRequisitionView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.store.requisition(tx, id, false);
      await this.authoriser.authorise(tx, actor, READ, record === null ? {} : scopeOf(record));
      if (record === null) throw new NotFoundError(`no purchase requisition ${id}`);
      return (await this.views(tx, [record]))[0]!;
    });
  }

  create(actor: Actor | undefined, body: PurchaseRequisitionCreate, idempotencyKey: string): Promise<StoredResponse<PurchaseRequisitionView>> {
    return runPurchaseCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      CREATE,
      'createPurchaseRequisition',
      body,
      idempotencyKey,
      (tx) => this.whereWanted(tx, actor, body.locationId),
      async (tx) => {
        const where = await this.whereWanted(tx, actor, body.locationId);
        if (where.branchId === undefined) throw new PurchaseRequisitionInvalidError([{ field: '/locationId', rule: 'LOCATION_REQUIRED' }]);
        const lines = await this.checkedLines(tx, body.lines, body.neededBy);
        const id = this.nextId();
        await this.documents.register(tx, { id, docType: DOC_TYPE, ownerModule: 'pur', branchId: where.branchId, actorId: actor!.principalId });
        await this.store.insertRequisition(
          tx,
          id,
          { locationId: where.locationId ?? null, neededBy: body.neededBy ?? null, justification: body.justification?.trim() ?? null, branchId: where.branchId },
          lines,
          actor!.principalId,
        );
        const view = await this.view(tx, id);
        await this.audit.record(tx, { module: 'pur', action: 'CREATE', entityType: 'PurchaseRequisition', entityId: id, branchId: view.branchId, before: null, after: { ...view } });
        return { status: 201, body: view };
      },
    ).catch(translatePurRefusal);
  }

  update(actor: Actor | undefined, id: string, body: PurchaseRequisitionUpdate, idempotencyKey: string): Promise<StoredResponse<PurchaseRequisitionView>> {
    return this.write(actor, CREATE, 'updatePurchaseRequisition', id, body, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, 'UPDATE', body.version);
      const neededBy = body.neededBy ?? before.neededBy;
      const lines = body.lines === undefined ? null : await this.checkedLines(tx, body.lines, neededBy ?? undefined);
      if (lines === null && body.neededBy !== undefined) await this.checkedLines(tx, [], body.neededBy, false);
      await this.store.updateRequisition(tx, id, { neededBy, justification: body.justification?.trim() ?? before.justification }, lines, actor!.principalId);
      return { status: 200, body: await this.audited(tx, 'UPDATE', before) };
    });
  }

  submit(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<PurchaseRequisitionView>> {
    return this.write(actor, CREATE, 'submitPurchaseRequisition', id, {}, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, 'SUBMIT', null);
      await this.store.markRequisition(tx, id, 'SUBMITTED', {}, actor!.principalId);
      const view = await this.audited(tx, 'SUBMIT', before);
      await this.events.publish<RequisitionSubmitted>(tx, {
        type: 'pur.RequisitionSubmitted',
        subjectType: 'PurchaseRequisition',
        subjectId: id,
        branchId: before.branchId,
        payload: { requisitionId: id, requestedBy: before.requestedBy, locationId: before.locationId, neededBy: before.neededBy, lines: before.lines.map((l) => ({ productId: l.productId, qty: l.qty })) },
      });
      return { status: 200, body: view };
    });
  }

  reject(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<PurchaseRequisitionView>> {
    return this.write(actor, APPROVE, 'rejectPurchaseRequisition', id, { reason }, idempotencyKey, async (tx) => {
      const before = await this.locked(tx, id, 'REJECT', null);
      await this.store.markRequisition(tx, id, 'REJECTED', { rejectReason: reason.trim() }, actor!.principalId);
      return { status: 200, body: await this.audited(tx, 'REJECT', before, { reason }) };
    });
  }

  /**
   * Converts a submitted requisition into a draft purchase order in one transaction (FR-PUR-004). The converter needs
   * both the contract's `pur.purchase_order.create` at the delivery location and `pur.requisition.approve` at the
   * requisition's own scope, so the requester's storekeeper grant alone cannot turn a request into an order (A-166).
   */
  convert(actor: Actor | undefined, id: string, body: RequisitionConvert, idempotencyKey: string): Promise<StoredResponse<PurchaseOrderView>> {
    return runPurchaseCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      ORDER_CREATE,
      'convertPurchaseRequisition',
      { id, ...body },
      idempotencyKey,
      (tx) => this.orders.scopeOf(tx, body.deliverToLocationId),
      async (tx) => {
        const record = await this.store.requisition(tx, id, true);
        await this.authoriser.authorise(tx, actor, APPROVE, record === null ? {} : scopeOf(record));
        const before = await this.locked(tx, id, 'CONVERT', null);
        const planned = planConversion(before.lines, body.lines);
        if (!planned.ok) throw new PurchaseRequisitionInvalidError(planned.error);
        const order = await this.orders.createIn(tx, actor!, {
          supplierId: body.supplierId,
          deliverToLocationId: body.deliverToLocationId,
          orderDate: toBusinessDate(this.clock.now()),
          expectedOn: body.expectedOn,
          lines: planned.value,
        });
        await this.store.markRequisition(tx, id, 'CONVERTED', { purchaseOrderId: order.id }, actor!.principalId);
        await this.audited(tx, 'CONVERT', before, { purchaseOrderId: order.id });
        return { status: 201, body: order };
      },
    ).catch(translatePurRefusal);
  }

  async views(tx: Transaction, records: readonly RequisitionRecord[]): Promise<PurchaseRequisitionView[]> {
    const products = await this.refs.productsIn(tx, records.flatMap((r) => r.lines.map((l) => l.productId)));
    const locations = await this.refs.locationsIn(tx, records.flatMap((r) => (r.locationId === null ? [] : [r.locationId])));
    const names = await this.principals.refs(tx, records.flatMap((r) => [r.requestedBy, r.createdBy]));
    return records.map((r) => ({
      id: r.id,
      requisitionNo: r.requisitionNo,
      status: r.status,
      requestedBy: principalRef(names, r.requestedBy),
      location: r.locationId === null ? null : locationRef(locations.get(r.locationId)!),
      neededBy: r.neededBy,
      justification: r.justification,
      rejectReason: r.rejectReason,
      lines: r.lines.map((l) => {
        const product = products.get(l.productId)!;
        return { id: l.id, lineNo: l.lineNo, product: productRef(product), qty: l.qty, uom: product.baseUom, note: l.note };
      }),
      purchaseOrder: r.purchaseOrderId === null ? null : { id: r.purchaseOrderId, docType: 'PURCHASE_ORDER' as const, number: null },
      branchId: r.branchId,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      createdBy: principalRef(names, r.createdBy),
    }));
  }

  /**
   * Where a requisition is wanted: the location named, or else the one scope the requester's grants give
   * (a location grant, or a branch-wide grant). With several scopes and no location the branch is unknown.
   */
  private async whereWanted(tx: Transaction, actor: Actor | undefined, locationId: string | undefined): Promise<{ branchId?: string; locationId?: string }> {
    if (locationId !== undefined) {
      const location = (await this.refs.locationsIn(tx, [locationId])).get(locationId);
      return location === undefined ? {} : { branchId: location.branchId, locationId: location.id };
    }
    if (actor === undefined) return {};
    const scopes = await this.authoriser.scopes(tx, actor, CREATE);
    const distinct = new Map(scopes.map((s) => [`${s.branchId}/${s.locationId ?? ''}`, s] as const));
    if (distinct.size !== 1) return {};
    const only = [...distinct.values()][0]!;
    return only.locationId === null ? { branchId: only.branchId } : { branchId: only.branchId, locationId: only.locationId };
  }

  /** Lines checked against master data: purchasable, live products, each once, in the product's base unit. */
  private async checkedLines(tx: Transaction, inputs: readonly RequisitionLineInput[], neededBy: string | undefined, linesRequired = true): Promise<Omit<RequisitionLineRecord, 'lineNo'>[]> {
    const broken: BrokenRule[] = [];
    if (linesRequired && inputs.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
    if (neededBy !== undefined && neededBy < toBusinessDate(this.clock.now())) broken.push({ field: '/neededBy', rule: 'NEEDED_BY_PAST' });
    const products = await this.refs.productsIn(tx, inputs.map((l) => l.productId));
    const missing = inputs.flatMap((l, i) => (products.has(l.productId) ? [] : [`/lines/${i}/productId`]));
    if (missing.length > 0) throw new PurReferenceNotFoundError(missing);
    const seen = new Set<string>();
    inputs.forEach((input, i) => {
      const product = products.get(input.productId)!;
      if (seen.has(product.id)) broken.push({ field: `/lines/${i}/productId`, rule: 'LINE_REPEATED' });
      seen.add(product.id);
      if (!product.isLive) broken.push({ field: `/lines/${i}/productId`, rule: 'PRODUCT_NOT_ACTIVE' });
      else if (!product.isPurchasable) broken.push({ field: `/lines/${i}/productId`, rule: 'NOT_PURCHASABLE' });
    });
    if (broken.length > 0) throw new PurchaseRequisitionInvalidError(broken);
    return inputs.map((input) => ({ id: this.nextId(), productId: input.productId, qty: input.qty, note: input.note?.trim() ?? null }));
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
        const record = await this.store.requisition(tx, id, false);
        return record === null ? {} : scopeOf(record);
      },
      work,
    ).catch(translatePurRefusal);
  }

  private async locked(tx: Transaction, id: string, action: RequisitionAction, version: number | null): Promise<RequisitionRecord> {
    const record = await this.store.requisition(tx, id, true);
    if (record === null) throw new NotFoundError(`no purchase requisition ${id}`);
    if (version !== null && record.version !== version) throw new VersionConflictError(`purchase requisition ${id} is at version ${record.version}, not ${version}`);
    if (!judgeRequisitionAction(record.status, action).ok) throw wrongStatus(`purchase requisition ${id}`, record.status);
    return record;
  }

  private async view(tx: Transaction, id: string): Promise<PurchaseRequisitionView> {
    return (await this.views(tx, [(await this.store.requisition(tx, id, false))!]))[0]!;
  }

  private async audited(tx: Transaction, action: string, before: RequisitionRecord, metadata: Record<string, unknown> = {}): Promise<PurchaseRequisitionView> {
    const beforeView = (await this.views(tx, [before]))[0]!;
    const view = await this.view(tx, before.id);
    await this.audit.record(tx, {
      module: 'pur',
      action,
      entityType: 'PurchaseRequisition',
      entityId: before.id,
      branchId: before.branchId,
      before: { ...beforeView },
      after: { ...view },
      metadata: JSON.parse(JSON.stringify(metadata)),
    });
    return view;
  }
}

/** The scope a requisition is authorised against: its branch, and its location when it names one. */
function scopeOf(record: RequisitionRecord): { branchId: string; locationId?: string } {
  return record.locationId === null ? { branchId: record.branchId } : { branchId: record.branchId, locationId: record.locationId };
}
