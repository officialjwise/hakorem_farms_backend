import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { sqlStateOf, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import { defineProduct, type ProductDraft } from '../domain/product';
import type { ProductCreated } from '../events';
import { DuplicateValueError, ReferenceNotFoundError, StockPolicyConflictError } from './errors';
import type { ProductListFilter, ProductStore, ProductView, UniqueProductField } from './product-store';

export const CREATE_PRODUCT = 'createProduct';
export const LIST_PRODUCTS = 'listProducts';

const FIELD_POINTER: Readonly<Record<UniqueProductField, string>> = { sku: '/sku', barcode: '/barcode', seoSlug: '/seo/slug' };
/** Unique indexes of migration 0009, for a race that reaches the database before the check sees it. */
const INDEX_FIELD: Readonly<Record<string, UniqueProductField>> = {
  uq_product_sku: 'sku',
  uq_product_barcode: 'barcode',
  uq_product_seo_slug: 'seoSlug',
};

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/**
 * The Product slice (FR-MDM-001): create, read and list. This is the shape every module session copies. Each
 * handler authorises through the IAM policy engine first; a state change claims its idempotency key as the first
 * write, writes its row, its audit event and its domain event in the same transaction, and stores the response.
 */
export class ProductCatalogue {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ProductStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async create(actor: Actor | undefined, draft: ProductDraft, idempotencyKey: string): Promise<StoredResponse<ProductView>> {
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, 'mdm.product.create');
        const claim = await this.idempotency.claim(tx, { operationId: CREATE_PRODUCT, principalId: actor!.principalId, key: idempotencyKey, request: draft });
        if (claim.kind === 'REPLAY') {
          return claim.response as StoredResponse<ProductView>;
        }
        const defined = defineProduct(draft, await this.store.references(tx, draft));
        if (!defined.ok) {
          throw defined.error.code === 'REFERENCE_NOT_FOUND' ? new ReferenceNotFoundError(defined.error.fields) : new StockPolicyConflictError(defined.error.fields);
        }
        const taken = await this.store.takenValues(tx, defined.value);
        if (taken.length > 0) {
          throw new DuplicateValueError(taken.map((field) => FIELD_POINTER[field]));
        }
        const id = this.nextId();
        const now = this.clock.now();
        await this.store.insert(tx, id, defined.value, actor!.principalId, now);
        const view = (await this.store.view(tx, id))!;
        await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'Product', entityId: id, before: null, after: { ...view } });
        const payload: ProductCreated = {
          productId: id,
          sku: view.sku,
          name: view.name,
          categoryId: view.category.id,
          stockPolicy: view.stockPolicy,
          tracking: view.tracking,
          onlineMode: view.onlineMode,
          status: view.status,
        };
        await this.events.publish(tx, { type: 'mdm.ProductCreated', subjectType: 'Product', subjectId: id, payload });
        const response = { status: 201, body: view };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      const field = sqlStateOf(error) === '23505' ? INDEX_FIELD[(error as { constraint?: string }).constraint ?? ''] : undefined;
      if (field !== undefined) {
        throw new DuplicateValueError([FIELD_POINTER[field]]);
      }
      throw error;
    }
  }

  async get(actor: Actor | undefined, id: string): Promise<ProductView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.product.read');
      const view = await this.store.view(tx, id);
      if (view === null) {
        throw new NotFoundError('no such product');
      }
      return view;
    });
  }

  async list(actor: Actor | undefined, filter: ProductListFilter, cursor: string | undefined, limit: number): Promise<Page<ProductView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.product.read');
      const binding = { operationId: LIST_PRODUCTS, principalId: actor!.principalId, filters: filter };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const rows = await this.store.list(tx, filter, position?.['id'] ?? null, limit + 1);
      const hasMore = rows.length > limit;
      const data = rows.slice(0, limit);
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }
}
