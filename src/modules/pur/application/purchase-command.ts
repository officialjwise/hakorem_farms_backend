import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalRef } from '../../iam';
import type { LocationFacts, ProductFacts, SupplierFacts } from '../../mdm';
import type { ReadScope } from './purchasing-store';

/** The contract's `ApprovalPending`. */
export interface ApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: string;
  readonly subject: { readonly id: string; readonly docType: string; readonly number: string | null };
  readonly summary: string;
  readonly requestedAt: string;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

export const supplierRef = (s: SupplierFacts) => ({ id: s.id, supplierNo: s.supplierNo, name: s.name });
export const productRef = (p: ProductFacts) => ({ id: p.id, sku: p.sku, name: p.name });
export const locationRef = (l: LocationFacts) => ({ id: l.id, code: l.code, name: l.name, kind: l.kind });

/** A principal by id, or the id alone when the name is not readable (a system principal). */
export function principalRef(names: ReadonlyMap<string, PrincipalRef>, id: string): PrincipalRef {
  return names.get(id) ?? { id, displayName: 'Unknown' };
}

/** Money as the contract carries it: a JSON integer of pesewas, exact up to 2^53 - 1. */
export function pesewas(amount: bigint): number {
  return Number(amount);
}

/**
 * The steps every PUR command shares (ADR-0005, ADR-0014, ADR-0035): one serializable transaction, the permission
 * checked in the handler for the branch and location the command names, then the idempotency claim; a replay returns
 * the first answer and does nothing again.
 */
export function runPurchaseCommand<T>(
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
  seriesLocks: readonly string[] = [],
): Promise<StoredResponse<T>> {
  return uow.run({ isolation: 'serializable', seriesLocks }, async (tx) => {
    await authoriser.authorise(tx, actor, permission, await scope(tx));
    const claim = await idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
    if (claim.kind === 'REPLAY') return claim.response as StoredResponse<T>;
    const response = await work(tx);
    await idempotency.complete(tx, claim.id, response);
    return response;
  });
}

/** A list query: authorised, narrowed to the reader's grants, cursor-paged newest first. */
export async function readPage<R extends { readonly id: string }, V>(
  tx: Transaction,
  deps: { readonly authoriser: Authoriser; readonly cursors: Cursors },
  actor: Actor | undefined,
  permission: string,
  operationId: string,
  filters: Record<string, string | boolean | null>,
  cursor: string | undefined,
  limit: number,
  fetch: (scopes: readonly ReadScope[], beforeId: string | null, limit: number) => Promise<R[]>,
  views: (records: readonly R[]) => Promise<V[]>,
): Promise<Page<V>> {
  await deps.authoriser.authorise(tx, actor, permission);
  const scopes = (await deps.authoriser.scopes(tx, actor!, permission)).map((s) => ({ branchId: s.branchId, locationId: s.locationId }));
  const binding = { operationId, principalId: actor!.principalId, filters };
  const before = cursor === undefined ? null : (deps.cursors.decode(cursor, binding)['id'] ?? null);
  const rows = await fetch(scopes, before, limit + 1);
  const hasMore = rows.length > limit;
  const kept = rows.slice(0, limit);
  const last = kept.at(-1);
  return { data: await views(kept), page: { nextCursor: hasMore && last !== undefined ? deps.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
}

/** The branches a set of grant scopes reaches as a whole (a branch-wide grant), for documents held by branch only. */
export function wholeBranches(scopes: readonly ReadScope[]): string[] {
  return [...new Set(scopes.filter((s) => s.locationId === null).map((s) => s.branchId))];
}

/** A line's number from its position in the request: the first line is 1. */
export function lineNumber(index: number): number {
  return index + 1;
}
