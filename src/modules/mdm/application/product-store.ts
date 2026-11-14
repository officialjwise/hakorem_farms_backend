import type { Transaction } from '../../../platform/database/unit-of-work';
import type { OnlineMode, ProductDefinition, ProductDraft, ProductReferences, ProductStatus, StockPolicy } from '../domain/product';

interface Ref {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** The contract's `Product`. Images arrive in B4 with the file store; until then the list is empty. */
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
  readonly images: readonly never[];
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
  /** Which of the draft's unique values a live product already uses. */
  takenValues(tx: Transaction, definition: ProductDefinition): Promise<UniqueProductField[]>;
  insert(tx: Transaction, id: string, definition: ProductDefinition, actorId: string, now: Date): Promise<void>;
  view(tx: Transaction, id: string): Promise<ProductView | null>;
  /** Newest first; `beforeId` is the exclusive upper bound for the next page. */
  list(tx: Transaction, filter: ProductListFilter, beforeId: string | null, limit: number): Promise<ProductView[]>;
}

export const PRODUCT_STORE = Symbol('PRODUCT_STORE');
