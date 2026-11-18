import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, AuthoriseScope } from '../../iam';
import type { Page } from './product-catalogue';

/** A row's lock state: its version and whether it is archived. */
export interface RowState {
  readonly version: number;
  readonly archived: boolean;
}

/**
 * The shape every MDM administration handler shares, the one CatalogueAdmin set (B04d continued): authorise first,
 * then, for a write, serializable isolation, the idempotency key claimed as the first write, and the response stored
 * with it; reads at read committed; lists as signed cursor pages in creation order.
 */
export class AdminKit {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly cursors: Cursors,
    private readonly translate: (error: unknown) => never,
  ) {}

  async write<T>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    request: object,
    idempotencyKey: string,
    work: (tx: Transaction) => Promise<StoredResponse<T>>,
    scope?: (tx: Transaction) => Promise<AuthoriseScope>,
    /** Advisory locks taken before BEGIN (ADR-0005), so writes that would all meet on one hot spot queue instead. */
    locks: readonly string[] = [],
  ): Promise<StoredResponse<T>> {
    try {
      return await this.uow.run({ isolation: 'serializable', seriesLocks: locks }, async (tx) => {
        await this.authoriser.authorise(tx, actor, permission, scope === undefined ? {} : await scope(tx));
        const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
        if (claim.kind === 'REPLAY') {
          return claim.response as StoredResponse<T>;
        }
        const response = await work(tx);
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      return this.translate(error);
    }
  }

  read<V>(actor: Actor | undefined, permission: string, find: (tx: Transaction) => Promise<V | null>, missing: string): Promise<V> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission);
      const found = await find(tx);
      if (found === null) {
        throw new NotFoundError(missing);
      }
      return found;
    });
  }

  page<V extends { readonly id: string }>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    filters: Record<string, unknown>,
    cursor: string | undefined,
    limit: number,
    rows: (tx: Transaction, afterId: string | null) => Promise<V[]>,
    before?: (tx: Transaction) => Promise<void>,
  ): Promise<Page<V>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission);
      await before?.(tx);
      const binding = { operationId, principalId: actor!.principalId, filters };
      const after = cursor === undefined ? null : ((this.cursors.decode(cursor, binding)['id'] as string | undefined) ?? null);
      const found = await rows(tx, after);
      const hasMore = found.length > limit;
      const data = found.slice(0, limit);
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }
}

/** Checks the version the client read against a locked live row. */
export function requireLiveVersion(state: RowState | null, what: string, id: string, version: number): void {
  if (state === null || state.archived) {
    throw new NotFoundError(`no live ${what} ${id}`);
  }
  if (state.version !== version) {
    throw new VersionConflictError(`${what} ${id} is at version ${state.version}, not ${version}`);
  }
}

/** The columns of a partial update that were sent. */
export function sentColumns(columns: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}
