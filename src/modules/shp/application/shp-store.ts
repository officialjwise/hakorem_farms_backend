import type { Transaction } from '../../../platform/database/unit-of-work';
import type { SortOrder } from '../../../platform/http/keyset-sort';
import type { Availability } from '../domain/listing';
import type { PriceBasis } from '../domain/pricing-lines';

/** The contract's `ImageSet`. */
export interface ImageSetView {
  readonly alt: string;
  readonly variants: readonly { readonly variant: 'thumb' | 'card' | 'full'; readonly url: string; readonly width: number; readonly height: number; readonly sizeBytes: number; readonly fallbackUrl: string; readonly fallbackSizeBytes: number }[];
}

/** One row of `shp.product_listing`, as the refresh writes it and the catalogue reads it. */
export interface ListingRow {
  readonly productId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly categoryCode: string;
  /** Root first. */
  readonly categoryCodes: readonly string[];
  readonly categoryPath: readonly string[];
  readonly categorySort: number;
  readonly productLine: string;
  readonly onlineMode: 'LISTED' | 'REQUEST_TO_BUY';
  readonly priceFromPesewas: bigint | null;
  readonly priceToPesewas: bigint | null;
  readonly priceBasis: PriceBasis | null;
  readonly taxInclusive: boolean | null;
  readonly saleUom: string;
  readonly nominalPackKg: string | null;
  readonly catchWeight: boolean;
  readonly weightTolerancePercent: string | null;
  readonly availability: Availability;
  readonly images: readonly ImageSetView[];
  readonly mainImageFileId: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  /** CR-039: each unit the product is sold by online, the sale unit first, each priced by its own entry. */
  readonly sellingUnits: readonly SellingUnitListing[];
}

/** The contract's `SellingUnit` on a catalogue item and a product (CR-039). */
export interface SellingUnitListing {
  readonly uom: string;
  readonly uomName: string;
  readonly priceFromPesewas: number | null;
  readonly priceToPesewas: number | null;
  readonly availability: Availability;
}

export interface CatalogueFilters {
  readonly q: string | null;
  readonly category: string | null;
  readonly productLine: string | null;
  readonly availability: Availability | null;
}

export interface CartRecord {
  readonly id: string;
  readonly guestTokenHash: Buffer | null;
  readonly branchId: string;
  readonly couponCode: string | null;
  readonly status: 'ACTIVE' | 'CHECKOUT' | 'CONVERTED' | 'ABANDONED' | 'EXPIRED';
  readonly updatedAt: Date;
}

export interface CartLineRecord {
  readonly id: string;
  readonly productId: string;
  readonly qty: string;
  readonly uom: string;
  readonly displayedUnitPricePesewas: bigint;
  readonly addedAt: Date;
}

export interface CheckoutLineRecord {
  readonly lineNo: number;
  readonly cartLineId: string;
  readonly productId: string;
  readonly qty: string;
  readonly uom: string;
  readonly baseQty: string;
  readonly priceListEntryId: string;
  readonly unitPricePesewas: bigint;
  readonly priceBasis: PriceBasis;
  readonly catchWeight: boolean;
  readonly estimatedWeightKg: string | null;
  readonly estimatedLineTotalPesewas: bigint;
  readonly maximumLineTotalPesewas: bigint;
  readonly discountPesewas: bigint;
  readonly taxCategoryId: string;
}

export interface AddressSnapshot {
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly line1: string;
  readonly area: string;
  readonly city: string;
  readonly region: string;
  readonly digitalAddress: string | null;
  readonly directions: string | null;
}

export interface CheckoutRecord {
  readonly id: string;
  readonly cartId: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly addressSnapshot: AddressSnapshot | null;
  readonly fulfilmentMode: 'COLLECTION' | 'DELIVERY';
  readonly deliveryZoneId: string | null;
  readonly deliverySlotId: string | null;
  readonly deliveryFeePesewas: bigint;
  readonly paymentTerms: 'PREPAID' | 'COD';
  readonly taxInclusive: boolean;
  readonly couponCode: string | null;
  readonly discountPesewas: bigint;
  /** The promotions the engine applied, as the customer was shown them. */
  readonly promotions: readonly { readonly promotionId: string; readonly code: string; readonly name: string; readonly discountPesewas: number }[];
  readonly taxPesewas: bigint;
  readonly estimatedTotalPesewas: bigint;
  readonly maximumTotalPesewas: bigint;
  readonly differencePreference: 'REFUND' | 'STORE_CREDIT';
  readonly priceChanged: boolean;
  readonly reservedUntil: Date;
  readonly orderId: string | null;
  readonly status: 'STARTED' | 'AWAITING_PAYMENT' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';
  readonly branchId: string;
  readonly version: number;
}

/** What the checkout writes; the totals and the delivery are recomputed together on every change. */
export type CheckoutWrite = Omit<CheckoutRecord, 'orderId' | 'status' | 'version'>;

/** A cart a customer holds, with lines, idle since `idleSince` and never reminded (FR-SHP-015). */
export interface IdleCartRecord {
  readonly cartId: string;
  readonly customerId: string;
  readonly branchId: string;
  readonly idleSince: Date;
}

export interface ShpStore {
  /** Carts a customer holds, ACTIVE with at least one line, last changed at or before `before`, with no reminder yet. */
  idleCustomerCarts(tx: Transaction, before: Date, limit: number): Promise<IdleCartRecord[]>;
  /** One reminder requested for a cart, once ever; false when one already was (`uq_abandoned_cart_notice`). */
  /** Whether a cart is still ACTIVE with at least one line and held by a customer. */
  remindableCart(tx: Transaction, cartId: string): Promise<boolean>;
  insertAbandonedCartNotice(tx: Transaction, n: { readonly id: string; readonly cartId: string; readonly idleSince: Date; readonly at: Date; readonly actorId: string }): Promise<boolean>;
  replaceListing(tx: Transaction, branchId: string, rows: readonly ListingRow[]): Promise<number>;
  listingPage(tx: Transaction, branchId: string, filters: CatalogueFilters, order: SortOrder, position: readonly string[] | null, limit: number): Promise<Array<ListingRow & { readonly position: readonly string[] }>>;
  facets(tx: Transaction, branchId: string, filters: CatalogueFilters): Promise<{ readonly categories: { code: string; name: string; count: number }[]; readonly productLines: { value: string; count: number }[] }>;
  listingBySlug(tx: Transaction, branchId: string, slug: string): Promise<ListingRow | null>;
  listings(tx: Transaction, branchId: string, productIds: readonly string[]): Promise<ReadonlyMap<string, ListingRow>>;
  relatedSlugs(tx: Transaction, branchId: string, categoryCode: string, exceptProductId: string, limit: number): Promise<string[]>;
  categoryCounts(tx: Transaction, branchId: string): Promise<ReadonlyMap<string, number>>;

  insertCart(tx: Transaction, cart: { readonly id: string; readonly guestTokenHash: Buffer; readonly branchId: string }): Promise<void>;
  /** The cart, locked for the rest of the transaction when `lock` is set. */
  cart(tx: Transaction, id: string, lock: boolean): Promise<CartRecord | null>;
  /** The id of the cart's one open checkout (STARTED or AWAITING_PAYMENT, `uq_checkout_session_live`), or null. */
  openCheckoutOf(tx: Transaction, cartId: string): Promise<string | null>;
  cartLines(tx: Transaction, cartId: string): Promise<CartLineRecord[]>;
  upsertCartLine(tx: Transaction, cartId: string, line: { readonly id: string; readonly productId: string; readonly qty: string; readonly uom: string; readonly displayedUnitPricePesewas: bigint }): Promise<void>;
  setCartLineQty(tx: Transaction, cartId: string, lineId: string, qty: string, displayedUnitPricePesewas: bigint): Promise<boolean>;
  deleteCartLine(tx: Transaction, cartId: string, lineId: string): Promise<boolean>;
  setCart(tx: Transaction, cartId: string, change: { readonly couponCode?: string | null; readonly status?: CartRecord['status'] }): Promise<void>;

  insertCheckout(tx: Transaction, checkout: CheckoutWrite, lines: readonly CheckoutLineRecord[], actorId: string): Promise<void>;
  checkout(tx: Transaction, id: string, lock: boolean): Promise<CheckoutRecord | null>;
  checkoutLines(tx: Transaction, id: string): Promise<CheckoutLineRecord[]>;
  updateCheckout(tx: Transaction, id: string, change: CheckoutWrite, actorId: string): Promise<void>;
  /** STARTED to AWAITING_PAYMENT, naming the order placed from it (placeOrder, A-232). */
  awaitPayment(tx: Transaction, id: string, orderId: string, actorId: string): Promise<void>;
  /** The checkout ended: expired, cancelled, or completed once its order took over its hold. */
  endCheckout(tx: Transaction, id: string, status: 'EXPIRED' | 'CANCELLED' | 'COMPLETED', actorId: string): Promise<void>;
}

export const SHP_STORE = Symbol('SHP_STORE');
