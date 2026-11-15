import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, AuthoriseScope } from '../../iam';
import type { StockUnitFacts, StockUnits } from '../../inv';
import type { ReadScope } from './livestock-store';

/** What a cursor is bound to: the operation, the actor and the filters (platform `Cursors`). */
export interface CursorBinding {
  readonly operationId: string;
  readonly principalId: string;
  readonly filters: unknown;
}

export interface Page<V> {
  readonly data: readonly V[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/** One more than a page, to learn whether another page follows. Kept apart from money code (ADR-0001). */
export function pageProbe(limit: number): number {
  return limit + 1;
}

/**
 * A LIV write (ADR-0035, ADR-0005): authorised first in the handler, scoped to the branch and location of every record
 * it touches (one scope, or one per animal of a batch; none means the unscoped check, which still refuses a role without
 * the permission), then
 * claimed by its idempotency key, then done, all in one serializable transaction that the unit of work retries whole
 * on a serialization failure. A replay returns the first response.
 */
export function runWrite<T>(
  uow: UnitOfWork,
  authoriser: Authoriser,
  idempotency: Idempotency,
  actor: Actor | undefined,
  permission: string,
  operationId: string,
  request: object,
  idempotencyKey: string,
  scope: (tx: Transaction) => Promise<AuthoriseScope | readonly AuthoriseScope[]>,
  work: (tx: Transaction, actor: Actor) => Promise<StoredResponse<T>>,
): Promise<StoredResponse<T>> {
  return uow.run({ isolation: 'serializable' }, async (tx) => {
    const found = await scope(tx);
    const scopes = Array.isArray(found) ? (found as readonly AuthoriseScope[]) : [found as AuthoriseScope];
    for (const one of scopes.length === 0 ? [{}] : scopes) {
      await authoriser.authorise(tx, actor, permission, one);
    }
    const claim = await idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
    if (claim.kind === 'REPLAY') return claim.response as StoredResponse<T>;
    const response = await work(tx, actor!);
    await idempotency.complete(tx, claim.id, response);
    return response;
  });
}

/**
 * What a list may show (ADR-0035): every branch a branch-wide grant names, and for a grant scoped to a location, that
 * location and the stock units standing there now, which INV answers.
 */
export async function readScopeOf(tx: Transaction, authoriser: Authoriser, units: StockUnits, actor: Actor, permission: string): Promise<ReadScope> {
  const grants = await authoriser.scopes(tx, actor, permission);
  const branchIds = grants.filter((g) => g.locationId === null).map((g) => g.branchId);
  const locationIds = grants.flatMap((g) => (g.locationId === null ? [] : [g.locationId]));
  const unitIds = (await units.onHandAtIn(tx, locationIds)).map((u) => u.id);
  return { branchIds, locationIds, unitIds };
}

/** A page from rows fetched one past the limit, with the cursor bound to the operation, the actor and the filters. */
export function pageOf<R, V>(cursors: Cursors, binding: CursorBinding, rows: readonly R[], limit: number, keyOf: (row: R) => string, views: readonly V[]): Page<V> {
  const last = rows.slice(0, limit).at(-1);
  const hasMore = rows.length > limit;
  return { data: views, page: { nextCursor: hasMore && last !== undefined ? cursors.encode(binding, { id: keyOf(last) }) : null, limit, hasMore } };
}

/** The id a cursor carries, checked against the binding it was issued under. */
export function afterOf(cursors: Cursors, binding: CursorBinding, cursor: string | undefined): string | null {
  return cursor === undefined ? null : ((cursors.decode(cursor, binding)['id'] as string | undefined) ?? null);
}

/**
 * Where each unit stands now (A-158): an animal's current location, which inventory keeps on the unit; a flock's
 * single physical location holding its head. A flock spread over several locations, or with none, has no place, and
 * a record that needs one is refused.
 */
export async function placesOf(tx: Transaction, units: StockUnits, facts: readonly StockUnitFacts[]): Promise<ReadonlyMap<string, string | null>> {
  const lots = facts.filter((f) => f.tracking === 'LOT').map((f) => f.id);
  const balances = await units.onHandOfIn(tx, lots);
  const places = new Map<string, string | null>();
  for (const unit of facts) {
    if (unit.tracking === 'SERIAL') {
      places.set(unit.id, unit.currentLocationId);
      continue;
    }
    const here = balances.filter((b) => b.id === unit.id);
    places.set(unit.id, here.length === 1 ? here[0]!.locationId : null);
  }
  return places;
}
