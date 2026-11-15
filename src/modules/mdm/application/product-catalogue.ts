import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { sqlStateOf, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { InvalidStateTransitionError, NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import { translate } from '../../../platform/i18n/messages';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import { canChangeProductStatus, planReferencedArchive } from '../domain/catalogue';
import { defineProduct, type OnlineMode, type ProductDraft, type ProductStatus } from '../domain/product';
import type { ProductArchived, ProductChanged, ProductCreated } from '../events';
import { DuplicateValueError, RecordInUseError, ReferenceNotFoundError, StockPolicyConflictError } from './errors';
import type { ProductListFilter, ProductStore, ProductView, UniqueProductField } from './product-store';

export const CREATE_PRODUCT = 'createProduct';
export const LIST_PRODUCTS = 'listProducts';
export const UPDATE_PRODUCT = 'updateProduct';
export const ARCHIVE_PRODUCT = 'archiveProduct';

/** The contract's `ProductUpdate`, parsed at the boundary. The stock-keeping policy, units and species never change. */
export interface ProductChange {
  readonly version: number;
  readonly name?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly nominalPackKg?: string | undefined;
  readonly weightTolerancePercent?: string | undefined;
  readonly taxCategoryId?: string | undefined;
  readonly shelfLifeDays?: number | undefined;
  readonly barcode?: string | undefined;
  readonly description?: string | undefined;
  readonly onlineMode?: OnlineMode | undefined;
  readonly seo?: { readonly slug?: string | undefined; readonly title?: string | undefined; readonly description?: string | undefined } | undefined;
  readonly isPurchasable?: boolean | undefined;
  readonly isSellable?: boolean | undefined;
  readonly status?: ProductStatus | undefined;
}

const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

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

  /**
   * updateProduct (FR-MDM-001, FR-MDM-004): the change is merged onto the product and the whole result is checked
   * again against its stock-keeping policy, as at creation. A change that would move the product between held in lots
   * and not (a countable gaining or losing its shelf life) is refused: that is a stock-keeping change. The status never
   * returns to DRAFT (A-106). Publishes `mdm.ProductChanged`.
   */
  async update(actor: Actor | undefined, id: string, change: ProductChange, idempotencyKey: string): Promise<StoredResponse<ProductView>> {
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, 'mdm.product.update');
        const claim = await this.idempotency.claim(tx, { operationId: UPDATE_PRODUCT, principalId: actor!.principalId, key: idempotencyKey, request: { id, ...change } });
        if (claim.kind === 'REPLAY') {
          return claim.response as StoredResponse<ProductView>;
        }
        if (!(await this.store.lock(tx, id))) {
          throw new NotFoundError('no such product');
        }
        const before = (await this.store.view(tx, id))!;
        if (before.version !== change.version) {
          throw new VersionConflictError(`product ${id} is at version ${before.version}, not ${change.version}`);
        }
        const status = change.status ?? before.status;
        if (!canChangeProductStatus(before.status, status)) {
          throw new InvalidStateTransitionError(`product ${id} cannot go from ${before.status} to ${status}`, [
            { field: '/status', code: before.status, message: translate('error.invalid_state_transition') },
          ]);
        }
        const draft: ProductDraft = {
          sku: before.sku,
          name: change.name ?? before.name,
          categoryId: change.categoryId ?? before.category.id,
          stockPolicy: before.stockPolicy,
          speciesId: before.species?.id,
          baseUom: before.baseUom,
          saleUom: before.saleUom,
          nominalPackKg: change.nominalPackKg ?? orUndefined(before.nominalPackKg),
          weightTolerancePercent: change.weightTolerancePercent ?? before.weightTolerancePercent,
          // The tax category stays as it is unless the change names one: moving category never retaxes silently.
          taxCategoryId: change.taxCategoryId ?? before.taxCategory.id,
          shelfLifeDays: change.shelfLifeDays ?? orUndefined(before.shelfLifeDays),
          storageTempClass: orUndefined(before.storageTempClass),
          withdrawalDays: orUndefined(before.withdrawalDays),
          barcode: change.barcode ?? orUndefined(before.barcode),
          description: change.description ?? orUndefined(before.description),
          onlineMode: change.onlineMode ?? before.onlineMode,
          seo: {
            slug: change.seo?.slug ?? orUndefined(before.seo.slug),
            title: change.seo?.title ?? orUndefined(before.seo.title),
            description: change.seo?.description ?? orUndefined(before.seo.description),
          },
          isPurchasable: change.isPurchasable ?? before.isPurchasable,
          isSellable: change.isSellable ?? before.isSellable,
        };
        const defined = defineProduct(draft, await this.store.references(tx, draft));
        if (!defined.ok) {
          throw defined.error.code === 'REFERENCE_NOT_FOUND' ? new ReferenceNotFoundError(defined.error.fields) : new StockPolicyConflictError(defined.error.fields);
        }
        if (defined.value.tracking !== before.tracking) {
          throw new StockPolicyConflictError([{ field: '/shelfLifeDays', rule: 'TRACKING_FIXED' }]);
        }
        const definition = { ...defined.value, status };
        const taken = await this.store.takenValues(tx, definition, id);
        if (taken.length > 0) {
          throw new DuplicateValueError(taken.map((field) => FIELD_POINTER[field]));
        }
        if (!(await this.store.update(tx, id, before.version, definition, actor!.principalId, this.clock.now()))) {
          throw new VersionConflictError(`product ${id} changed while it was updated`);
        }
        const view = (await this.store.view(tx, id))!;
        const changedFields = (Object.keys(view) as Array<keyof ProductView>).filter(
          (field) => !['version', 'updatedAt'].includes(field) && JSON.stringify(view[field]) !== JSON.stringify(before[field]),
        );
        await this.audit.record(tx, { module: 'mdm', action: 'UPDATE', entityType: 'Product', entityId: id, before: { ...before }, after: { ...view } });
        const payload: ProductChanged = {
          productId: id,
          sku: view.sku,
          name: view.name,
          categoryId: view.category.id,
          onlineMode: view.onlineMode,
          status: view.status,
          isSellable: view.isSellable,
          changedFields,
          version: view.version,
        };
        await this.events.publish(tx, { type: 'mdm.ProductChanged', subjectType: 'Product', subjectId: id, payload });
        const response = { status: 200, body: view };
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

  /**
   * archiveProduct (FR-MDM-001): a soft delete with a reason. Refused while a pending or active price list version
   * prices the product (RECORD_IN_USE, USED_BY_LIVE_PRICES), as for a grade or a band; refusing a product that holds
   * stock arrives with inventory's usage check (B5, A-117). Publishes `mdm.ProductArchived`.
   */
  async archive(actor: Actor | undefined, id: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<ProductView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.product.archive');
      const claim = await this.idempotency.claim(tx, { operationId: ARCHIVE_PRODUCT, principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') {
        return claim.response as StoredResponse<ProductView>;
      }
      const version = await this.store.lockedVersion(tx, id);
      if (version === null) throw new NotFoundError('no such product');
      if (version !== body.version) throw new VersionConflictError(`product ${id} is at version ${version}, not ${body.version}`);
      const verdict = planReferencedArchive(await this.store.livePriceUses(tx, id));
      if (!verdict.ok) throw new RecordInUseError(verdict.error);
      const before = (await this.store.view(tx, id))!;
      if (!(await this.store.archive(tx, id, body.version, body.reason, actor!.principalId, this.clock.now()))) {
        throw new VersionConflictError(`product ${id} changed while it was archived`);
      }
      const view = (await this.store.viewAny(tx, id))!;
      await this.audit.record(tx, { module: 'mdm', action: 'ARCHIVE', entityType: 'Product', entityId: id, before: { ...before }, after: { ...view, reason: body.reason } });
      const payload: ProductArchived = { productId: id, sku: view.sku, reason: body.reason, version: view.version };
      await this.events.publish(tx, { type: 'mdm.ProductArchived', subjectType: 'Product', subjectId: id, payload });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
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
