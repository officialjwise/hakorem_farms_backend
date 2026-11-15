import { createUuidV7Generator, Quantity, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { LocationFacts, MasterDataRefs } from '../../mdm';
import { checkStockLines, planTransferReceipt, type StockRuleBroken } from '../domain/stock-documents';
import { ordinal, pageProbe } from './counting';
import { InvReferenceNotFoundError, StockTransferInvalidError, TransferVarianceError } from './errors';
import type { Stock } from './stock';
import { locationRef, principalRef, productRef, readScopes, runStockCommand, unitRef, type LocationRefView, type Page, type StockUnitRefView } from './stock-command';
import type { StockDocumentsStore, TransferFilters, TransferRecord, TransferStatus } from './stock-documents-store';

/** Locations a transfer may start or end at: a physical location that holds stock, never in-transit itself or a site. */
const NOT_A_TRANSFER_END: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);
/** The reasons a shortfall on arrival takes: the stock adjustment and wastage lists (FR-MDM-011, A-139). */
const VARIANCE_REASON_DOMAINS: ReadonlySet<string> = new Set(['STOCK_ADJUSTMENT', 'WASTAGE']);

export interface TransferLineInput {
  readonly productId: string;
  readonly stockUnitId?: string | undefined;
  readonly qty: string;
}

export interface TransferCreateRequest {
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly lines: readonly TransferLineInput[];
}

export interface TransferReceiveRequest {
  readonly lines: ReadonlyArray<{ readonly lineId: string; readonly qtyReceived: string; readonly varianceReasonCode?: string | undefined }>;
}

export interface StockTransferView {
  readonly id: string;
  readonly transferNo: string | null;
  readonly status: TransferStatus;
  readonly from: LocationRefView;
  readonly to: LocationRefView;
  readonly toBranch: { readonly id: string; readonly code: string; readonly name: string };
  readonly lines: ReadonlyArray<{
    readonly id: string;
    readonly lineNo: number;
    readonly product: { readonly id: string; readonly sku: string; readonly name: string };
    readonly stockUnit: StockUnitRefView | null;
    readonly uom: string;
    readonly qtyDispatched: string;
    readonly qtyReceived: string | null;
    readonly varianceQty: string | null;
    readonly varianceReasonCode: string | null;
  }>;
  readonly dispatchedAt: string | null;
  readonly dispatchedBy: PrincipalRef | null;
  readonly receivedAt: string | null;
  readonly receivedBy: PrincipalRef | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
}

/**
 * Stock transfers (FR-INV-010, FR-INV-011). A transfer is drafted at its source, dispatched into the source branch's
 * in-transit location (still the farm's stock, still valued, never sellable), and received at its destination, where
 * what arrived plus the recorded variance must equal what was dispatched. A shortfall needs a reason from the fixed
 * list, leaves in-transit as a loss movement, and raises a `TRANSFER_VARIANCE` stock exception for a person to look
 * at (A-139). Every movement is posted through `Stock.postIn` in the command's serializable transaction; a transfer
 * between branches moves the issue value to the receiving branch's pool (the trigger, ADR-0018). Drafting,
 * dispatching and cancelling are scoped to the source location; receiving to the destination.
 */
export class StockTransfers {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StockDocumentsStore,
    private readonly refs: MasterDataRefs,
    private readonly stock: Stock,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly documents: DocumentRegistry,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filters: TransferFilters, cursor: string | undefined, limit: number): Promise<Page<StockTransferView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.transfer.read');
      const scopes = readScopes(await this.authoriser.scopes(tx, actor!, 'inv.transfer.read'));
      const binding = { operationId: 'listStockTransfers', principalId: actor!.principalId, filters: { ...filters } };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.transfers(tx, filters, scopes, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.views(tx, data), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  /** A reader at either end may read it: the source branch and location, or the destination's. */
  get(actor: Actor | undefined, id: string): Promise<StockTransferView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.store.transfer(tx, id);
      await this.authoriser.authorise(tx, actor, 'inv.transfer.read');
      if (record === null) throw new NotFoundError(`no stock transfer ${id}`);
      const scopes = readScopes(await this.authoriser.scopes(tx, actor!, 'inv.transfer.read'));
      const reaches = (branchId: string, locationId: string) => scopes.some((s) => s.branchId === branchId && (s.locationId === null || s.locationId === locationId));
      const destinationOnly = reaches(record.toBranchId, record.toLocationId) && !reaches(record.branchId, record.fromLocationId);
      await this.authoriser.authorise(
        tx,
        actor,
        'inv.transfer.read',
        destinationOnly ? { branchId: record.toBranchId, locationId: record.toLocationId } : { branchId: record.branchId, locationId: record.fromLocationId },
      );
      return (await this.views(tx, [record]))[0]!;
    });
  }

  create(actor: Actor | undefined, body: TransferCreateRequest, idempotencyKey: string): Promise<StoredResponse<StockTransferView>> {
    return runStockCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'inv.transfer.create',
      'createStockTransfer',
      body,
      idempotencyKey,
      async (tx) => {
        const from = (await this.refs.locationsIn(tx, [body.fromLocationId])).get(body.fromLocationId);
        return from === undefined ? {} : { branchId: from.branchId, locationId: from.id };
      },
      async (tx) => ({ status: 201, body: await this.createIn(tx, actor!, body) }),
    );
  }

  /** Drafts a transfer in the caller's transaction, every rule of createStockTransfer applied and audited. */
  async createIn(tx: Transaction, actor: Actor, body: TransferCreateRequest): Promise<StockTransferView> {
    const locations = await this.refs.locationsIn(tx, [body.fromLocationId, body.toLocationId]);
    const from = locations.get(body.fromLocationId);
    const to = locations.get(body.toLocationId);
    const missing = [...(from?.isLive ? [] : ['/fromLocationId']), ...(to?.isLive ? [] : ['/toLocationId'])];
    if (missing.length > 0) throw new InvReferenceNotFoundError(missing);
    const broken: StockRuleBroken[] = [];
    if (from!.id === to!.id) broken.push({ field: '/toLocationId', rule: 'SAME_LOCATION' });
    for (const [field, location] of [['/fromLocationId', from!], ['/toLocationId', to!]] as const) {
      if (location.isVirtual || NOT_A_TRANSFER_END.has(location.kind)) broken.push({ field, rule: 'NOT_A_STOCK_LOCATION' });
    }
    broken.push(...(await this.lineRules(tx, body.lines)));
    const units = await this.store.units(tx, body.lines.flatMap((l) => (l.stockUnitId === undefined ? [] : [l.stockUnitId])));
    body.lines.forEach((l, index) => {
      const unit = l.stockUnitId === undefined ? undefined : units.get(l.stockUnitId);
      if (unit?.tracking === 'SERIAL' && unit.currentLocationId !== from!.id) broken.push({ field: `/lines/${index}/stockUnitId`, rule: 'NOT_AT_SOURCE' });
    });
    if (broken.length > 0) throw new StockTransferInvalidError(broken);
    const id = this.nextId();
    await this.documents.register(tx, { id, docType: 'STOCK_TRANSFER', ownerModule: 'inv', branchId: from!.branchId, actorId: actor.principalId });
    await this.store.insertTransfer(tx, { id, fromLocationId: from!.id, toLocationId: to!.id, toBranchId: to!.branchId, branchId: from!.branchId }, actor.principalId);
    for (const [index, line] of body.lines.entries()) {
      await this.store.insertTransferLine(tx, id, {
        id: this.nextId(),
        lineNo: ordinal(index),
        productId: line.productId,
        stockUnitId: line.stockUnitId ?? null,
        qtyDispatched: Quantity.parse(line.qty).toDecimalString(),
      });
    }
    const view = await this.view(tx, id);
    await this.audit.record(tx, { module: 'inv', action: 'CREATE', entityType: 'StockTransfer', entityId: id, branchId: from!.branchId, before: null, after: { ...view } });
    return view;
  }

  dispatch(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<StockTransferView>> {
    return runStockCommand(this.uow, this.authoriser, this.idempotency, actor, 'inv.transfer.dispatch', 'dispatchStockTransfer', { id }, idempotencyKey, (tx) => this.sourceScope(tx, id), async (tx) => {
      const transfer = await this.locked(tx, id, 'DRAFT');
      const from = (await this.refs.locationsIn(tx, [transfer.fromLocationId])).get(transfer.fromLocationId)!;
      const inTransit = await this.refs.physicalLocationOfKindIn(tx, transfer.branchId, 'IN_TRANSIT');
      if (inTransit === null) throw new StockTransferInvalidError([{ field: '/id', rule: 'NO_IN_TRANSIT_LOCATION' }]);
      // The lines are checked again against stock as it is now: a lot may have been sold out since the draft.
      const broken = await this.lineRules(
        tx,
        transfer.lines.map((l) => ({ productId: l.productId, stockUnitId: l.stockUnitId ?? undefined, qty: l.qtyDispatched })),
      );
      if (broken.length > 0) throw new StockTransferInvalidError(broken);
      const now = this.clock.now();
      for (const line of transfer.lines) {
        const posted = await this.stock.postIn(tx, actor!.principalId, {
          movementType: 'TRANSFER_DISPATCH',
          productId: line.productId,
          stockUnitId: line.stockUnitId,
          branchId: from.branchId,
          fromLocationId: from.id,
          toLocationId: inTransit,
          qty: Quantity.parse(line.qtyDispatched),
          sourceDocumentId: id,
          sourceLineRef: line.id,
          occurredAt: now,
        });
        await this.store.setDispatchMovement(tx, line.id, posted.id);
      }
      await this.store.markDispatched(tx, id, inTransit, now, actor!.principalId);
      return { status: 200, body: await this.audited(tx, 'DISPATCH', transfer) };
    });
  }

  receive(actor: Actor | undefined, id: string, body: TransferReceiveRequest, idempotencyKey: string): Promise<StoredResponse<StockTransferView>> {
    return runStockCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'inv.transfer.receive',
      'receiveStockTransfer',
      { id, ...body },
      idempotencyKey,
      async (tx) => {
        const record = await this.store.transfer(tx, id);
        return record === null ? {} : { branchId: record.toBranchId, locationId: record.toLocationId };
      },
      async (tx) => {
        const transfer = await this.locked(tx, id, 'DISPATCHED');
        const units = await this.store.units(tx, transfer.lines.flatMap((l) => (l.stockUnitId === null ? [] : [l.stockUnitId])));
        const plan = planTransferReceipt(
          transfer.lines.map((l) => ({ lineId: l.id, qtyDispatched: Quantity.parse(l.qtyDispatched), serial: l.stockUnitId !== null && units.get(l.stockUnitId)?.tracking === 'SERIAL' })),
          body.lines.map((l) => ({ lineId: l.lineId, qtyReceived: Quantity.parse(l.qtyReceived), varianceReasonCode: l.varianceReasonCode })),
        );
        if (!plan.ok) throw new TransferVarianceError(plan.broken);
        const reasons = await this.refs.reasonCodesIn(tx, plan.lines.flatMap((l) => (l.reasonCode === null ? [] : [l.reasonCode])));
        const badReasons = body.lines.flatMap((l, index) =>
          l.varianceReasonCode !== undefined && !VARIANCE_REASON_DOMAINS.has(reasons.get(l.varianceReasonCode)?.domain ?? '') ? [{ field: `/lines/${index}/varianceReasonCode`, rule: 'REASON_NOT_ALLOWED' }] : [],
        );
        if (badReasons.length > 0) throw new TransferVarianceError(badReasons);

        const inTransit = transfer.inTransitLocationId!;
        const transitBranch = transfer.branchId;
        const loss = await this.refs.virtualLocationIn(tx, transitBranch, 'LOSS');
        if (loss === null) throw new Error(`branch ${transitBranch} has no virtual LOSS location; every branch is created with one (ADR-0042)`);
        const now = this.clock.now();
        for (const planned of plan.lines) {
          const line = transfer.lines.find((l) => l.id === planned.lineId)!;
          const base = { productId: line.productId, stockUnitId: line.stockUnitId, branchId: transitBranch, fromLocationId: inTransit, sourceDocumentId: id, sourceLineRef: line.id, occurredAt: now };
          const received = planned.received.isZero() ? null : await this.stock.postIn(tx, actor!.principalId, { ...base, movementType: 'TRANSFER_RECEIPT', toLocationId: transfer.toLocationId, qty: planned.received });
          let varianceMovement: string | null = null;
          if (!planned.variance.isZero()) {
            const posted = await this.stock.postIn(tx, actor!.principalId, { ...base, movementType: 'ADJUST_LOSS', toLocationId: loss, qty: planned.variance, reasonCode: planned.reasonCode });
            varianceMovement = posted.id;
            await this.store.insertException(tx, {
              kind: 'TRANSFER_VARIANCE',
              branchId: transitBranch,
              productId: line.productId,
              stockUnitId: line.stockUnitId,
              locationId: inTransit,
              movementId: posted.id,
              sourceDocumentId: id,
              qty: planned.variance.toDecimalString(),
              details: {
                qtyDispatched: line.qtyDispatched,
                qtyReceived: planned.received.toDecimalString(),
                varianceQty: planned.variance.toDecimalString(),
                reasonCode: planned.reasonCode,
                valuePesewas: posted.value.toJsonInteger(),
                receivedBy: actor!.principalId,
              },
            });
          }
          await this.store.setLineReceipt(tx, line.id, {
            received: planned.received.toDecimalString(),
            variance: planned.variance.toDecimalString(),
            reasonCode: planned.reasonCode,
            receiptMovementId: received?.id ?? null,
            varianceMovementId: varianceMovement,
          });
        }
        await this.store.markReceived(tx, id, now, actor!.principalId);
        return { status: 200, body: await this.audited(tx, 'RECEIVE', transfer) };
      },
    );
  }

  cancel(actor: Actor | undefined, id: string, body: { readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<StockTransferView>> {
    return runStockCommand(this.uow, this.authoriser, this.idempotency, actor, 'inv.transfer.create', 'cancelStockTransfer', { id, ...body }, idempotencyKey, (tx) => this.sourceScope(tx, id), async (tx) => {
      const transfer = await this.locked(tx, id, 'DRAFT');
      await this.store.markTransferCancelled(tx, id, body.reason, actor!.principalId);
      return { status: 200, body: await this.audited(tx, 'CANCEL', transfer, body.reason) };
    });
  }

  private async lineRules(tx: Transaction, lines: readonly TransferLineInput[]): Promise<StockRuleBroken[]> {
    const products = await this.refs.productsIn(tx, lines.map((l) => l.productId));
    const units = await this.store.units(tx, lines.flatMap((l) => (l.stockUnitId === undefined ? [] : [l.stockUnitId])));
    const missing = lines.flatMap((l, index) => [
      ...(products.has(l.productId) ? [] : [`/lines/${index}/productId`]),
      ...(l.stockUnitId === undefined || units.has(l.stockUnitId) ? [] : [`/lines/${index}/stockUnitId`]),
    ]);
    if (missing.length > 0) throw new InvReferenceNotFoundError(missing);
    return checkStockLines(
      lines.map((l) => ({
        productId: l.productId,
        product: products.get(l.productId)!,
        qty: Quantity.parse(l.qty),
        stockUnitId: l.stockUnitId ?? null,
        unit: l.stockUnitId === undefined ? null : units.get(l.stockUnitId)!,
      })),
    );
  }

  private async sourceScope(tx: Transaction, id: string): Promise<{ branchId?: string; locationId?: string }> {
    const record = await this.store.transfer(tx, id);
    return record === null ? {} : { branchId: record.branchId, locationId: record.fromLocationId };
  }

  private async locked(tx: Transaction, id: string, status: TransferStatus): Promise<TransferRecord> {
    const state = await this.store.lockTransfer(tx, id);
    if (state === null) throw new NotFoundError(`no stock transfer ${id}`);
    if (state.status !== status) throw new InvalidStateTransitionError(`stock transfer ${id} is ${state.status}`);
    return (await this.store.transfer(tx, id))!;
  }

  private async audited(tx: Transaction, action: string, before: TransferRecord, reason?: string): Promise<StockTransferView> {
    const beforeView = (await this.views(tx, [before]))[0]!;
    const view = await this.view(tx, before.id);
    await this.audit.record(tx, {
      module: 'inv',
      action,
      entityType: 'StockTransfer',
      entityId: before.id,
      branchId: before.branchId,
      before: { ...beforeView },
      after: reason === undefined ? { ...view } : { ...view, reason },
    });
    return view;
  }

  private async view(tx: Transaction, id: string): Promise<StockTransferView> {
    return (await this.views(tx, [(await this.store.transfer(tx, id))!]))[0]!;
  }

  private async views(tx: Transaction, records: readonly TransferRecord[]): Promise<StockTransferView[]> {
    const lines = records.flatMap((r) => r.lines);
    const products = await this.refs.productsIn(tx, lines.map((l) => l.productId));
    const locations: ReadonlyMap<string, LocationFacts> = await this.refs.locationsIn(tx, records.flatMap((r) => [r.fromLocationId, r.toLocationId]));
    const branches = await this.refs.branchesIn(tx, records.map((r) => r.toBranchId));
    const units = await this.store.units(tx, lines.flatMap((l) => (l.stockUnitId === null ? [] : [l.stockUnitId])));
    const names = await this.principals.refs(tx, records.flatMap((r) => [r.dispatchedBy, r.receivedBy].filter((p): p is string => p !== null)));
    return records.map((r) => ({
      id: r.id,
      transferNo: r.transferNo,
      status: r.status,
      from: locationRef(locations.get(r.fromLocationId)!),
      to: locationRef(locations.get(r.toLocationId)!),
      toBranch: branches.get(r.toBranchId)!,
      lines: r.lines.map((l) => {
        const product = products.get(l.productId)!;
        return {
          id: l.id,
          lineNo: l.lineNo,
          product: productRef(product),
          stockUnit: l.stockUnitId === null ? null : unitRef(units.get(l.stockUnitId)),
          uom: product.baseUom,
          qtyDispatched: l.qtyDispatched,
          qtyReceived: l.qtyReceived,
          varianceQty: l.varianceQty,
          varianceReasonCode: l.varianceReasonCode,
        };
      }),
      dispatchedAt: r.dispatchedAt?.toISOString() ?? null,
      dispatchedBy: r.dispatchedBy === null ? null : principalRef(names, r.dispatchedBy),
      receivedAt: r.receivedAt?.toISOString() ?? null,
      receivedBy: r.receivedBy === null ? null : principalRef(names, r.receivedBy),
      branchId: r.branchId,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
