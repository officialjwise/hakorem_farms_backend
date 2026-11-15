import { Money } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRefRecord, DocumentRegistry } from '../../../platform/documents/document-registry';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { LocationFacts, MasterDataRefs, ProductFacts } from '../../mdm';
import type { MovementRecord, ReadScope, StockDocumentsStore, UnitRecord } from './stock-documents-store';
import type { CostElement, WeightSource } from './stock-store';

export interface Page<V> {
  readonly data: readonly V[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

export interface LocationRefView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
}

export interface StockUnitRefView {
  readonly id: string;
  readonly identifier: string;
  readonly tracking: 'SERIAL' | 'LOT';
}

/** The contract's `ApprovalPending` (202): nothing has taken effect until a different person approves. */
export interface ApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: string;
  readonly subject: DocumentRefRecord;
  readonly summary: string;
  readonly requestedAt: string;
}

/** The contract's `StockMovement`. */
export interface StockMovementView {
  readonly id: string;
  readonly movementType: string;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly stockUnit: StockUnitRefView | null;
  readonly from: LocationRefView;
  readonly to: LocationRefView;
  readonly qty: string;
  readonly uom: string;
  readonly weightKg: string | null;
  readonly weightSource: WeightSource | null;
  readonly packCount: number | null;
  readonly valuePesewas: number;
  readonly currency: 'GHS';
  readonly costElement: CostElement | null;
  readonly reasonCode: string | null;
  readonly sourceDocument: DocumentRefRecord;
  readonly reservationId: string | null;
  readonly reversesMovementId: string | null;
  readonly reversedByMovementId: string | null;
  readonly actor: PrincipalRef;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

/** Where a location is shown, with the name the contract's `LocationRef` carries. */
export function locationRef(location: LocationFacts): LocationRefView {
  return { id: location.id, code: location.code, name: location.name, kind: location.kind };
}

export function productRef(product: ProductFacts): { readonly id: string; readonly sku: string; readonly name: string } {
  return { id: product.id, sku: product.sku, name: product.name };
}

export function unitRef(unit: UnitRecord | undefined): StockUnitRefView | null {
  return unit === undefined ? null : { id: unit.id, identifier: unit.identifier, tracking: unit.tracking };
}

/** A principal by id, or the id alone when the name is not readable (a system principal). */
export function principalRef(names: ReadonlyMap<string, PrincipalRef>, id: string): PrincipalRef {
  return names.get(id) ?? { id, displayName: 'Unknown' };
}

/** What a grant scope says, as a store's filter. */
export function readScopes(scopes: ReadonlyArray<{ readonly branchId: string; readonly locationId: string | null }>): ReadScope[] {
  return scopes.map((s) => ({ branchId: s.branchId, locationId: s.locationId }));
}

/**
 * The steps every INV command shares (ADR-0005, ADR-0014, ADR-0035): one serializable transaction, the permission
 * checked in the handler for the scope the command names, then the idempotency claim; a replay returns the first
 * answer and does nothing again.
 */
export function runStockCommand<T>(
  uow: UnitOfWork,
  authoriser: Authoriser,
  idempotency: Idempotency,
  actor: Actor | undefined,
  permission: string,
  operationId: string,
  request: object,
  idempotencyKey: string,
  scope: (tx: Transaction) => Promise<{ branchId?: string; locationId?: string }>,
  work: (tx: Transaction) => Promise<StoredResponse<T>>,
): Promise<StoredResponse<T>> {
  return uow.run({ isolation: 'serializable' }, async (tx) => {
    await authoriser.authorise(tx, actor, permission, await scope(tx));
    const claim = await idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
    if (claim.kind === 'REPLAY') {
      return claim.response as StoredResponse<T>;
    }
    const response = await work(tx);
    await idempotency.complete(tx, claim.id, response);
    return response;
  });
}

/** Movements as the contract shows them, with every reference resolved in the reader's transaction. */
export async function movementViews(
  tx: Transaction,
  records: readonly MovementRecord[],
  deps: { readonly store: StockDocumentsStore; readonly refs: MasterDataRefs; readonly documents: DocumentRegistry; readonly principals: PrincipalNames },
): Promise<StockMovementView[]> {
  const products = await deps.refs.productsIn(tx, records.map((m) => m.productId));
  const locations = await deps.refs.locationsIn(tx, records.flatMap((m) => [m.fromLocationId, m.toLocationId]));
  const units = await deps.store.units(tx, records.flatMap((m) => (m.stockUnitId === null ? [] : [m.stockUnitId])));
  const documents = await deps.documents.refs(tx, records.map((m) => m.sourceDocumentId));
  const actors = await deps.principals.refs(tx, records.map((m) => m.actorId));
  const reversedBy = await deps.store.reversedBy(tx, records.map((m) => m.id));
  return records.map((m) => {
    const product = products.get(m.productId)!;
    return {
      id: m.id,
      movementType: m.movementType,
      product: productRef(product),
      stockUnit: m.stockUnitId === null ? null : unitRef(units.get(m.stockUnitId)),
      from: locationRef(locations.get(m.fromLocationId)!),
      to: locationRef(locations.get(m.toLocationId)!),
      qty: m.qtyBase,
      uom: product.baseUom,
      weightKg: m.weightKg,
      weightSource: m.weightSource,
      packCount: m.packCount,
      valuePesewas: Money.ofPesewas(m.valuePesewas).toJsonInteger(),
      currency: 'GHS',
      costElement: m.costElement,
      reasonCode: m.reasonCode,
      sourceDocument: documents.get(m.sourceDocumentId) ?? { id: m.sourceDocumentId, docType: 'UNKNOWN', number: null },
      reservationId: m.reservationId,
      reversesMovementId: m.reversesMovementId,
      reversedByMovementId: reversedBy.get(m.id) ?? null,
      actor: principalRef(actors, m.actorId),
      occurredAt: m.occurredAt.toISOString(),
      recordedAt: m.recordedAt.toISOString(),
    };
  });
}
