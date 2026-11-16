import type { Result } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import { normaliseGhanaPhone, planAddress, type AddressFacts } from '../domain/parties';
import type { GalleryVariant } from '../domain/product-images';
import { matchDeliveryZone } from '../domain/reference-data';
import type { CatalogueRule } from '../domain/catalogue';

/** A product the public storefront shows (FR-SHP-001): no cost, floor, ceiling or stock field, by construction. */
export interface OnlineProductFacts {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string | null;
  readonly onlineMode: 'LISTED' | 'REQUEST_TO_BUY';
  readonly seoSlug: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly stockPolicy: 'SERIALISED' | 'CATCH_WEIGHT' | 'COUNTABLE' | 'NON_STOCK';
  readonly baseUom: string;
  readonly saleUom: string;
  readonly nominalPackKg: string | null;
  readonly weightTolerancePercent: string;
  readonly taxCategoryId: string;
  readonly speciesId: string | null;
  /** The category the product is in, then each one above it, to the root. */
  readonly categoryChain: readonly { readonly code: string; readonly name: string }[];
  readonly categorySort: number;
  readonly productLine: string;
  /** The gallery in order, with the public variants the file store has published. */
  readonly images: readonly { readonly fileId: string; readonly alt: string; readonly variants: readonly GalleryVariant[] }[];
}

/** A category the storefront shows (`is_online_visible`), with its parent's code. */
export interface OnlineCategoryFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly parentCode: string | null;
  readonly sortOrder: number;
}

/** A delivery zone as a checkout prices it (FR-MDM-010): its branch, exact fee and the order value that waives it. */
export interface DeliveryZoneFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly branchId: string;
  readonly feePesewas: bigint;
  readonly freeOverPesewas: bigint | null;
  readonly cutoffTime: string;
  readonly areas: readonly string[];
}

export interface StorefrontStore {
  onlineProducts(tx: Transaction, ids: readonly string[] | null): Promise<OnlineProductFacts[]>;
  onlineCategories(tx: Transaction): Promise<OnlineCategoryFacts[]>;
  deliverableZones(tx: Transaction): Promise<DeliveryZoneFacts[]>;
  /** Any zone, active or not, as a reference: id, code, name and branch. */
  zoneRefs(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, { readonly id: string; readonly code: string; readonly name: string; readonly branchId: string }>>;
  taxCategoryIdByCode(tx: Transaction, code: string): Promise<string | null>;
  priceListsTaxInclusive(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, boolean>>;
  /** The lower bound of each live weight band of these species, in kilograms, lowest first. */
  bandFloors(tx: Transaction, speciesIds: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>>;
}

export const STOREFRONT_STORE = Symbol('STOREFRONT_STORE');

/** The tax category a delivery fee is taxed in (seeded by migration 0009). */
const DELIVERY_TAX_CATEGORY = 'DELIVERY_SERVICE';

/**
 * MDM's read side for the online store (B07 continued 2, MODULE_BOUNDARIES, MDM card): the products and categories
 * the public sees, the delivery zone of an address, the tax category of a delivery fee and the weight bands a price
 * range is read over, in the caller's transaction. It authorises nothing (the storefront is public) and returns no
 * cost, floor or ceiling: only what FR-SHP-001 lets a visitor see.
 */
export class Storefront {
  constructor(private readonly store: StorefrontStore) {}

  /** Every product listed or on request online, or those of `ids` that are. */
  onlineProductsIn(tx: Transaction, ids: readonly string[] | null = null): Promise<OnlineProductFacts[]> {
    return this.store.onlineProducts(tx, ids === null ? null : [...new Set(ids)]);
  }

  onlineCategoriesIn(tx: Transaction): Promise<OnlineCategoryFacts[]> {
    return this.store.onlineCategories(tx);
  }

  /** The active zone of an open branch that delivers to the address's area, else its city, else none. */
  async deliveryZoneForIn(tx: Transaction, address: { readonly area: string; readonly city: string }): Promise<DeliveryZoneFacts | null> {
    return matchDeliveryZone(address, await this.store.deliverableZones(tx));
  }

  async deliveryZonesIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, DeliveryZoneFacts>> {
    const wanted = new Set(ids);
    return new Map((await this.store.deliverableZones(tx)).filter((zone) => wanted.has(zone.id)).map((zone) => [zone.id, zone] as const));
  }

  /** Zones by id as references, whether or not they deliver today (a slot outlives a zone made inactive). */
  zoneRefsIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, { readonly id: string; readonly code: string; readonly name: string; readonly branchId: string }>> {
    return ids.length === 0 ? Promise.resolve(new Map()) : this.store.zoneRefs(tx, [...new Set(ids)]);
  }

  /** The tax category a delivery fee is a line of (FR-SHP-008). */
  async deliveryTaxCategoryIdIn(tx: Transaction): Promise<string> {
    const id = await this.store.taxCategoryIdByCode(tx, DELIVERY_TAX_CATEGORY);
    if (id === null) throw new Error(`tax category ${DELIVERY_TAX_CATEGORY} is not seeded`);
    return id;
  }

  priceListsTaxInclusiveIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, boolean>> {
    return ids.length === 0 ? Promise.resolve(new Map()) : this.store.priceListsTaxInclusive(tx, [...new Set(ids)]);
  }

  bandFloorsIn(tx: Transaction, speciesIds: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> {
    return speciesIds.length === 0 ? Promise.resolve(new Map()) : this.store.bandFloors(tx, [...new Set(speciesIds)]);
  }

  /** A delivery address in Ghana format (FR-MDM-008), with its phone normalised, or the rules it breaks. */
  checkAddress(address: { readonly region: string; readonly line1: string; readonly digitalAddress?: string | undefined; readonly recipientPhone: string }): Result<AddressFacts, CatalogueRule[]> {
    return planAddress({ region: address.region, line1: address.line1, digitalAddress: address.digitalAddress, recipientPhone: address.recipientPhone });
  }

  /** A contact phone in E.164 form, Ghanaian forms normalised, or null if it is not a phone number. */
  normalisePhone(phone: string): string | null {
    const result = normaliseGhanaPhone(phone);
    return result.ok ? result.value : null;
  }
}
