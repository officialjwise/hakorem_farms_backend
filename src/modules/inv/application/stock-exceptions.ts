import { Quantity, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRefRecord, DocumentRegistry } from '../../../platform/documents/document-registry';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { exceptionSummary, isHeldVariance, judgeResolution, type ResolutionKind, type StockExceptionKind } from '../domain/stock-exception';
import { pageProbe } from './counting';
import { InvReferenceNotFoundError, StockExceptionInvalidError } from './errors';
import type { Stock } from './stock';
import type { StockAdjustments } from './stock-adjustments';
import { locationRef, principalRef, productRef, readScopes, runStockCommand, unitRef, type ApprovalPendingView, type LocationRefView, type Page, type StockUnitRefView } from './stock-command';
import type { StockDocumentsStore } from './stock-documents-store';
import type { StockExceptionFilters, StockExceptionRecord, StockExceptionStore } from './stock-exception-store';

/** Where held stock may be found: a live physical stock location, not in transit and not a whole site (as A-139). */
const NOT_FOUND_AT: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);

export interface StockExceptionResolveRequest {
  readonly resolutionKind?: ResolutionKind | undefined;
  readonly note: string;
  readonly resolutionDocumentId?: string | undefined;
  readonly foundLocationId?: string | undefined;
}

/** The contract's `StockException`. */
export interface StockExceptionView {
  readonly id: string;
  readonly kind: StockExceptionKind;
  readonly branchId: string;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly stockUnit: StockUnitRefView | null;
  readonly location: LocationRefView | null;
  readonly movementId: string | null;
  readonly sourceDocument: DocumentRefRecord | null;
  readonly qty: string | null;
  readonly summary: string;
  readonly details: Record<string, unknown>;
  readonly raisedAt: string;
  readonly status: 'OPEN' | 'RESOLVED';
  readonly resolvedAt: string | null;
  readonly resolvedBy: PrincipalRef | null;
  readonly resolutionDocument: DocumentRefRecord | null;
  readonly resolutionNote: string | null;
  readonly resolutionKind: ResolutionKind | null;
}

/**
 * The stock exception queue (FR-INV-023, ADR-0027, ADR-0048, threat model abuse case 7). An exception is a stock
 * fact that needs a person; it is resolved once, with a resolution kind and a note, and audited.
 *
 * A transfer shortfall is held in transit with no movement until it is resolved (ADR-0048): `WRITE_OFF` drafts and
 * submits a loss through the stock adjustment path, so at or above the `STOCK_WRITE_OFF` threshold it answers 202 and
 * waits for a different person, the threshold copied onto the adjustment, and the exception is resolved when the loss
 * posts; `FOUND` returns the held quantity to the stock location where it was found as a `TRANSFER_RECEIPT` against
 * the transfer, with no expense. Any other exception is resolved `ADJUSTED`, naming the posted adjustment that settled
 * it, or with `NO_CORRECTION`. Reads and writes are scoped to the exception's branch and location; every write is
 * serializable and idempotent.
 */
export class StockExceptions {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StockExceptionStore,
    private readonly documentsStore: StockDocumentsStore,
    private readonly refs: MasterDataRefs,
    private readonly adjustments: StockAdjustments,
    private readonly stock: Stock,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly documents: DocumentRegistry,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  list(actor: Actor | undefined, filters: StockExceptionFilters, cursor: string | undefined, limit: number): Promise<Page<StockExceptionView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.exception.read', filters.branchId === undefined ? {} : { branchId: filters.branchId });
      const scopes = readScopes(await this.authoriser.scopes(tx, actor!, 'inv.exception.read'));
      const binding = { operationId: 'listStockExceptions', principalId: actor!.principalId, filters: { ...filters } };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after = position === null ? null : { raisedAt: position['raisedAt']!, id: position['id']! };
      const found = await this.store.exceptions(tx, filters, scopes, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return {
        data: await this.views(tx, data),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { raisedAt: last.raisedAt.toISOString(), id: last.id }) : null, limit, hasMore },
      };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<StockExceptionView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.store.exception(tx, id);
      await this.authoriser.authorise(tx, actor, 'inv.exception.read', record === null ? {} : scopeOf(record));
      if (record === null) throw new NotFoundError(`no stock exception ${id}`);
      return (await this.views(tx, [record]))[0]!;
    });
  }

  resolve(actor: Actor | undefined, id: string, body: StockExceptionResolveRequest, idempotencyKey: string): Promise<StoredResponse<StockExceptionView | ApprovalPendingView>> {
    return runStockCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'inv.exception.resolve',
      'resolveStockException',
      { id, ...body },
      idempotencyKey,
      async (tx) => {
        const record = await this.store.exception(tx, id);
        return record === null ? {} : scopeOf(record);
      },
      (tx) => this.resolveIn(tx, actor!, id, body),
    );
  }

  private async resolveIn(tx: Transaction, actor: Actor, id: string, body: StockExceptionResolveRequest): Promise<StoredResponse<StockExceptionView | ApprovalPendingView>> {
    const before = await this.store.lockException(tx, id);
    if (before === null) throw new NotFoundError(`no stock exception ${id}`);
    if (before.status !== 'OPEN') throw new InvalidStateTransitionError(`stock exception ${id} is already resolved`);
    const held = isHeldVariance(before);
    const judged = judgeResolution({
      exceptionKind: before.kind,
      held,
      requested: body.resolutionKind,
      hasDocument: body.resolutionDocumentId !== undefined,
      hasFoundLocation: body.foundLocationId !== undefined,
      writeOffPending: held && (await this.store.writeOffPending(tx, id)),
    });
    if (judged.broken.length > 0 || judged.kind === null) throw new StockExceptionInvalidError(judged.broken);
    const now = this.clock.now();
    switch (judged.kind) {
      case 'WRITE_OFF': {
        const draft = await this.adjustments.createIn(
          tx,
          actor,
          {
            locationId: before.locationId!,
            reasonCode: String(before.details['reasonCode']),
            note: body.note,
            exceptionId: id,
            lines: [{ productId: before.productId, stockUnitId: before.stockUnitId ?? undefined, direction: 'LOSS', qty: before.qty! }],
          },
          { forHeldVariance: true },
        );
        const submitted = await this.adjustments.submitIn(tx, actor, draft.id);
        // At or above the threshold the 202 stands and the exception waits; below it the loss posted and resolved it.
        if (submitted.status === 202) return submitted as StoredResponse<ApprovalPendingView>;
        return { status: 200, body: await this.view(tx, id) };
      }
      case 'FOUND':
        await this.found(tx, actor, before, body.foundLocationId!, body.note, now);
        break;
      case 'ADJUSTED': {
        const documentId = body.resolutionDocumentId!;
        const adjustment = await this.store.adjustmentFor(tx, documentId);
        if (adjustment === null) throw new InvReferenceNotFoundError(['/resolutionDocumentId']);
        if (adjustment.status !== 'POSTED' || adjustment.exceptionId !== id) throw new StockExceptionInvalidError([{ field: '/resolutionDocumentId', rule: 'NOT_A_SETTLING_ADJUSTMENT' }]);
        await this.documentsStore.resolveException(tx, id, { kind: 'ADJUSTED', note: body.note, documentId, at: now }, actor.principalId);
        break;
      }
      case 'NO_CORRECTION':
        await this.documentsStore.resolveException(tx, id, { kind: 'NO_CORRECTION', note: body.note, documentId: null, at: now }, actor.principalId);
        break;
    }
    const view = await this.view(tx, id);
    await this.audit.record(tx, { module: 'inv', action: 'RESOLVE', entityType: 'StockException', entityId: id, branchId: before.branchId, before: { ...before }, after: { ...view } });
    return { status: 200, body: view };
  }

  /**
   * The held quantity was found: it goes from transit to the stock location where it was, in either branch of the
   * transfer, as a `TRANSFER_RECEIPT` against the transfer (value moves with it, no expense). The exception is resolved
   * first, because the database keeps held stock in transit while its exception is open.
   */
  private async found(tx: Transaction, actor: Actor, exception: StockExceptionRecord, foundLocationId: string, note: string, now: Date): Promise<void> {
    const location = (await this.refs.locationsIn(tx, [foundLocationId])).get(foundLocationId);
    if (location === undefined || !location.isLive) throw new InvReferenceNotFoundError(['/foundLocationId']);
    const transfer = await this.documentsStore.transfer(tx, exception.sourceDocumentId!);
    if (transfer === null) throw new Error(`held variance ${exception.id} names no transfer`);
    if (location.isVirtual || NOT_FOUND_AT.has(location.kind)) throw new StockExceptionInvalidError([{ field: '/foundLocationId', rule: 'NOT_A_STOCK_LOCATION' }]);
    if (location.branchId !== transfer.branchId && location.branchId !== transfer.toBranchId) {
      throw new StockExceptionInvalidError([{ field: '/foundLocationId', rule: 'NOT_IN_THE_TRANSFER_BRANCHES' }]);
    }
    await this.authoriser.authorise(tx, actor, 'inv.exception.resolve', { branchId: location.branchId, locationId: location.id });
    await this.documentsStore.resolveException(tx, exception.id, { kind: 'FOUND', note, documentId: transfer.id, at: now }, actor.principalId);
    const lineId = exception.details['lineId'];
    await this.stock.postIn(tx, actor.principalId, {
      movementType: 'TRANSFER_RECEIPT',
      productId: exception.productId,
      stockUnitId: exception.stockUnitId,
      branchId: exception.branchId,
      fromLocationId: exception.locationId!,
      toLocationId: location.id,
      qty: Quantity.parse(exception.qty!),
      sourceDocumentId: transfer.id,
      sourceLineRef: typeof lineId === 'string' ? lineId : null,
      occurredAt: now,
    });
  }

  private async view(tx: Transaction, id: string): Promise<StockExceptionView> {
    return (await this.views(tx, [(await this.store.exception(tx, id))!]))[0]!;
  }

  private async views(tx: Transaction, records: readonly StockExceptionRecord[]): Promise<StockExceptionView[]> {
    const products = await this.refs.productsIn(tx, records.map((r) => r.productId));
    const locations = await this.refs.locationsIn(tx, records.flatMap((r) => (r.locationId === null ? [] : [r.locationId])));
    const units = await this.documentsStore.units(tx, records.flatMap((r) => (r.stockUnitId === null ? [] : [r.stockUnitId])));
    const docs = await this.documents.refs(tx, records.flatMap((r) => [r.sourceDocumentId, r.resolutionDocumentId].filter((d): d is string => d !== null)));
    const names = await this.principals.refs(tx, records.flatMap((r) => (r.resolvedBy === null ? [] : [r.resolvedBy])));
    const doc = (docId: string | null): DocumentRefRecord | null => (docId === null ? null : (docs.get(docId) ?? { id: docId, docType: 'UNKNOWN', number: null }));
    return records.map((r) => {
      const location = r.locationId === null ? undefined : locations.get(r.locationId);
      return {
        id: r.id,
        kind: r.kind,
        branchId: r.branchId,
        product: productRef(products.get(r.productId)!),
        stockUnit: r.stockUnitId === null ? null : unitRef(units.get(r.stockUnitId)),
        location: location === undefined ? null : locationRef(location),
        movementId: r.movementId,
        sourceDocument: doc(r.sourceDocumentId),
        qty: r.qty,
        summary: exceptionSummary(r),
        details: r.details,
        raisedAt: r.raisedAt.toISOString(),
        status: r.status,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolvedBy: r.resolvedBy === null ? null : principalRef(names, r.resolvedBy),
        resolutionDocument: doc(r.resolutionDocumentId),
        resolutionNote: r.resolutionNote,
        resolutionKind: r.resolutionKind,
      };
    });
  }
}

/** An exception is read and resolved in its branch and, when it names one, at its location. */
function scopeOf(record: StockExceptionRecord): { branchId: string; locationId?: string } {
  return record.locationId === null ? { branchId: record.branchId } : { branchId: record.branchId, locationId: record.locationId };
}
