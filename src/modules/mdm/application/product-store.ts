import type { Transaction } from '../../../platform/database/unit-of-work';
import type { OnlineMode, ProductDefinition, ProductDraft, ProductReferences, ProductStatus, StockPolicy } from '../domain/product';
import type { GalleryVariant } from '../domain/product-images';

interface Ref {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** The contract's `ProductImage`: a photograph in the gallery with its public variants (FR-DOC-005). */
export interface ProductImageView {
  readonly id: string;
  readonly fileId: string;
  readonly altText: string;
  readonly sortOrder: number;
  readonly variants: readonly GalleryVariant[];
}

/** A live row of `mdm.product_image`. */
export interface ProductImageRow {
  readonly id: string;
  readonly fileId: string;
  readonly altText: string;
  readonly sortOrder: number;
}

/** The contract's `Product`, with its gallery in sort order (B04e continued 3). */
export interface ProductView {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly category: Ref;
  readonly stockPolicy: StockPolicy;
  readonly tracking: 'SERIAL' | 'LOT' | 'NONE';
  readonly species: Ref | null;
  readonly baseUom: string;
  readonly saleUom: string;
  readonly nominalPackKg: string | null;
  readonly weightTolerancePercent: string;
  readonly taxCategory: Ref;
  readonly glGroup: string;
  readonly shelfLifeDays: number | null;
  readonly storageTempClass: 'AMBIENT' | 'CHILLED' | 'FROZEN' | null;
  readonly withdrawalDays: number | null;
  readonly barcode: string | null;
  readonly description: string | null;
  readonly onlineMode: OnlineMode;
  readonly seo: { readonly slug: string | null; readonly title: string | null; readonly description: string | null };
  readonly isPurchasable: boolean;
  readonly isSellable: boolean;
  readonly status: ProductStatus;
  readonly images: readonly ProductImageView[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProductListFilter {
  readonly q?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly stockPolicy?: StockPolicy | undefined;
  readonly onlineMode?: OnlineMode | undefined;
  readonly status?: ProductStatus | undefined;
  readonly barcode?: string | undefined;
}

/** The unique fields of a product, for the DUPLICATE_VALUE refusal. */
export type UniqueProductField = 'sku' | 'barcode' | 'seoSlug';

/** MDM's product tables, each call in the caller's transaction. */
export interface ProductStore {
  references(tx: Transaction, draft: ProductDraft): Promise<ProductReferences>;
  /** Which of the draft's unique values a live product other than `exceptId` already uses. */
  takenValues(tx: Transaction, definition: ProductDefinition, exceptId?: string): Promise<UniqueProductField[]>;
  /** Locks the live product's row for the rest of the transaction; false when there is none. */
  lock(tx: Transaction, id: string): Promise<boolean>;
  /** Writes the definition if the row is still at `expectedVersion`; false when it is not. */
  update(tx: Transaction, id: string, expectedVersion: number, definition: ProductDefinition, actorId: string, now: Date): Promise<boolean>;
  insert(tx: Transaction, id: string, definition: ProductDefinition, actorId: string, now: Date): Promise<void>;
  view(tx: Transaction, id: string): Promise<ProductView | null>;
  /** The product's view whether or not it is archived. */
  viewAny(tx: Transaction, id: string): Promise<ProductView | null>;
  /** The version of the live product's locked row, or null when there is none. */
  lockedVersion(tx: Transaction, id: string): Promise<number | null>;
  /** Archives the live row if it is still at `expectedVersion`; false when it is not. */
  archive(tx: Transaction, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean>;
  /** How many entries of pending or active price list versions price the product. */
  livePriceUses(tx: Transaction, id: string): Promise<number>;
  /** The product's live images, in gallery order. */
  liveImages(tx: Transaction, productId: string): Promise<ProductImageRow[]>;
  insertImage(tx: Transaction, productId: string, image: ProductImageRow, actorId: string, now: Date): Promise<void>;
  /** Soft-deletes the product's live image with a reason; false when there is none. */
  removeImage(tx: Transaction, productId: string, imageId: string, reason: string, actorId: string, now: Date): Promise<boolean>;
  /** Newest first; `beforeId` is the exclusive upper bound for the next page. */
  list(tx: Transaction, filter: ProductListFilter, beforeId: string | null, limit: number): Promise<ProductView[]>;
}

export const PRODUCT_STORE = Symbol('PRODUCT_STORE');
