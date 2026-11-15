import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { BusinessRuleError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { registerMessages } from '../../../platform/i18n/messages';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { FileStore } from '../../../platform/storage/file-store';
import type { Authoriser } from '../../iam';
import { judgeAttachment, nextSortOrder } from '../domain/product-images';
import type { ProductChanged } from '../events';
import { DuplicateRecordError, referencesNotFound } from './errors';
import type { ProductStore, ProductView } from './product-store';

registerMessages({
  'mdm.file_not_clean': 'This photograph has not passed its virus check yet. Try again in a moment.',
});

export const ADD_PRODUCT_IMAGE = 'addProductImage';
export const REMOVE_PRODUCT_IMAGE = 'removeProductImage';

const UPDATE = 'mdm.product.update';
const FILE_READ = 'platform.file.read';
const FILE_READ_ANY = 'platform.file.read.any';
/** The reason a removed image carries: the contract's removeProductImage takes no body. */
export const REMOVED_REASON = 'Removed from the product gallery';

/** 422: the photograph has not passed its malware scan, so it has no public variants and is not attached. */
export class PhotographNotCleanError extends BusinessRuleError {
  readonly code = 'FILE_NOT_CLEAN';
  readonly messageKey = 'mdm.file_not_clean';
}

/** The contract's `ProductImageCreate`, parsed at the boundary. */
export interface ProductImageCreate {
  readonly fileId: string;
  readonly altText: string;
  readonly sortOrder?: number | undefined;
}

/**
 * A product's photographs (FR-MDM-001, FR-DOC-005, ADR-0045): addProductImage and removeProductImage. Each authorises
 * first through IAM's policy engine, deny by default: `mdm.product.update`, and to attach a file, reading it
 * (`platform.file.read`, and `platform.file.read.any` for someone else's upload). Only a CLEAN product photograph is
 * attached, so the gallery only ever shows variants the worker published; the database refuses anything else (HK008).
 * Each change is audited and publishes `mdm.ProductChanged` with `images` as the changed field, in its transaction.
 */
export class ProductGallery {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ProductStore,
    private readonly files: FileStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async add(actor: Actor | undefined, productId: string, body: ProductImageCreate, idempotencyKey: string): Promise<StoredResponse<ProductView>> {
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, UPDATE);
        const claim = await this.idempotency.claim(tx, { operationId: ADD_PRODUCT_IMAGE, principalId: actor!.principalId, key: idempotencyKey, request: { productId, ...body } });
        if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ProductView>;
        if (!(await this.store.lock(tx, productId))) throw new NotFoundError('no such product');
        const file = await this.files.find(tx, body.fileId);
        if (file !== null && file.purpose === 'PRODUCT_IMAGE') {
          // Attaching shows the file on the shop: the maker must be able to read it, as getFile would require.
          await this.authoriser.authorise(tx, actor, FILE_READ, { owner: { principalId: file.createdBy, anyPermission: FILE_READ_ANY } });
        }
        const gallery = await this.store.liveImages(tx, productId);
        const refusal = judgeAttachment(file, body.fileId, gallery.map((image) => image.fileId));
        if (refusal === 'NOT_A_PRODUCT_IMAGE') throw referencesNotFound(['/fileId']);
        if (refusal === 'FILE_NOT_CLEAN') throw new PhotographNotCleanError(`file ${body.fileId} is ${file!.scanStatus}`);
        if (refusal === 'ALREADY_ATTACHED') throw new DuplicateRecordError(['/fileId']);
        const before = (await this.store.view(tx, productId))!;
        const image = { id: this.nextId(), fileId: body.fileId, altText: body.altText, sortOrder: body.sortOrder ?? nextSortOrder(gallery.map((row) => row.sortOrder)) };
        await this.store.insertImage(tx, productId, image, actor!.principalId, this.clock.now());
        await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'ProductImage', entityId: image.id, before: null, after: { productId, ...image } });
        return this.changed(tx, before, 201, claim.id);
      });
    } catch (error) {
      // Two attaches of one file racing past the check meet the partial unique index of migration 0037.
      if (sqlStateOf(error) === '23505' && (error as { constraint?: string }).constraint === 'uq_product_image_file') throw new DuplicateRecordError(['/fileId']);
      throw error;
    }
  }

  async remove(actor: Actor | undefined, productId: string, imageId: string, idempotencyKey: string): Promise<StoredResponse<null>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, UPDATE);
      const claim = await this.idempotency.claim(tx, { operationId: REMOVE_PRODUCT_IMAGE, principalId: actor!.principalId, key: idempotencyKey, request: { productId, imageId } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<null>;
      if (!(await this.store.lock(tx, productId))) throw new NotFoundError('no such product');
      const before = (await this.store.view(tx, productId))!;
      const image = before.images.find((candidate) => candidate.id === imageId);
      if (image === undefined || !(await this.store.removeImage(tx, productId, imageId, REMOVED_REASON, actor!.principalId, this.clock.now()))) {
        throw new NotFoundError('no such image on this product');
      }
      await this.audit.record(tx, {
        module: 'mdm',
        action: 'ARCHIVE',
        entityType: 'ProductImage',
        entityId: imageId,
        before: { productId, fileId: image.fileId, altText: image.altText, sortOrder: image.sortOrder },
        after: { reason: REMOVED_REASON },
      });
      await this.changed(tx, before, 204, claim.id);
      const response = { status: 204, body: null };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** Publishes the gallery change and, for an add, stores the product as the response. */
  private async changed(tx: Transaction, before: ProductView, status: 201 | 204, claimId: string): Promise<StoredResponse<ProductView>> {
    const view = (await this.store.view(tx, before.id))!;
    const payload: ProductChanged = {
      productId: view.id,
      sku: view.sku,
      name: view.name,
      categoryId: view.category.id,
      onlineMode: view.onlineMode,
      status: view.status,
      isSellable: view.isSellable,
      changedFields: ['images'],
      version: view.version,
    };
    await this.events.publish(tx, { type: 'mdm.ProductChanged', subjectType: 'Product', subjectId: view.id, payload });
    const response = { status, body: view };
    if (status === 201) await this.idempotency.complete(tx, claimId, response);
    return response;
  }
}
