import { Quantity, type Clock } from '@hakorem/kernel';
import { pricingUom } from './line-pricing';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import { decodePosition, encodePosition, resolveSort, type SortSpec } from '../../../platform/http/keyset-sort';
import type { Settings } from '../../../platform/settings/settings';
import type { StockQueries } from '../../inv';
import type { MasterDataRefs, OnlineProductFacts, PricingService, ResolveLine, Storefront } from '../../mdm';
import { assignSlugs, availabilityLevel, priceRange, type Availability } from '../domain/listing';
import type { PriceBasis } from '../domain/pricing-lines';
import { fill } from './errors';
import type { CatalogueFilters, ImageSetView, ListingRow, SellingUnitListing, ShpStore } from './shp-store';

/** The principal a guest acts as (migration 0115, A-177): no credentials, no grants. */
export const STOREFRONT_ACTOR: Actor = { principalId: '01900000-0000-7000-8000-000000000006', kind: 'SYSTEM', displayName: 'Storefront', realm: null, sessionId: null, steppedUpAt: null };

/** SA-19: a product shows as low at this many whole sale units available, or fewer (a setting). */
export const LOW_STOCK_SETTING = 'shp.low_stock_units';
const LOW_STOCK_DEFAULT = 5;
const RELATED_LIMIT = 4;
const LIST_VARIANTS: ReadonlySet<string> = new Set(['thumb', 'card']);
const CUSTOMER = 'public';

/** The contract's `CatalogueItem`. */
export interface CatalogueItemView {
  readonly productId: string;
  readonly slug: string;
  readonly name: string;
  readonly categoryPath: readonly string[];
  readonly productLine: string;
  readonly onlineMode: 'LISTED' | 'REQUEST_TO_BUY';
  readonly priceFromPesewas: number | null;
  readonly priceToPesewas: number | null;
  readonly priceBasis: PriceBasis | null;
  readonly taxInclusive: boolean | null;
  readonly saleUom: string;
  readonly nominalPackKg: string | null;
  readonly catchWeight: boolean;
  readonly availability: Availability;
  /** CR-039: each unit the product is sold by online, the sale unit first, each at its own price. */
  readonly sellingUnits: readonly SellingUnitListing[];
  readonly image: ImageSetView | null;
  readonly currency: 'GHS';
}

/** The contract's `ProductDetail`. */
export interface ProductDetailView extends Omit<CatalogueItemView, 'image' | 'taxInclusive'> {
  readonly description: string | null;
  readonly taxInclusive: boolean;
  readonly weightTolerancePercent: string | null;
  readonly finalChargeRule: string | null;
  readonly images: readonly ImageSetView[];
  readonly seo: { readonly slug: string; readonly title: string | null; readonly description: string | null };
  readonly relatedSlugs: readonly string[];
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/** The contract's `sort` values of listCatalogue, each a field and direction of the shared sort (CR-019). */
const CATALOGUE_SORTS = { RELEVANCE: ['relevance', 'asc'], PRICE_ASC: ['price', 'asc'], PRICE_DESC: ['price', 'desc'], NAME: ['name', 'asc'] } as const;
export type CatalogueSort = keyof typeof CATALOGUE_SORTS;

/** The catalogue's allow-list (CR-019), each field backed by an index of migration 0119. */
const CATALOGUE_ORDER: SortSpec<'relevance' | 'price' | 'name'> = {
  fields: {
    relevance: { expression: "(lpad(l.category_sort::text, 6, '0') || ' ' || lower(l.name))", type: 'text' },
    price: { expression: 'l.price_from_pesewas', type: 'bigint', nullable: true },
    name: { expression: 'lower(l.name)', type: 'text' },
  },
  tieBreaker: { expression: 'l.product_id', type: 'uuid' },
  defaultOrder: { field: 'relevance', direction: 'asc' },
};

function json(pesewas: bigint | null): number | null {
  return pesewas === null ? null : Number(pesewas);
}

function listImage(images: readonly ImageSetView[]): ImageSetView | null {
  const first = images[0];
  return first === undefined ? null : { alt: first.alt, variants: first.variants.filter((v) => LIST_VARIANTS.has(v.variant)) };
}

function item(row: ListingRow): CatalogueItemView {
  return {
    productId: row.productId,
    slug: row.slug,
    name: row.name,
    categoryPath: row.categoryPath,
    productLine: row.productLine,
    onlineMode: row.onlineMode,
    priceFromPesewas: json(row.priceFromPesewas),
    priceToPesewas: json(row.priceToPesewas),
    priceBasis: row.priceBasis,
    taxInclusive: row.taxInclusive,
    saleUom: row.saleUom,
    nominalPackKg: row.nominalPackKg,
    catchWeight: row.catchWeight,
    availability: row.availability,
    sellingUnits: row.sellingUnits,
    image: listImage(row.images),
    currency: 'GHS',
  };
}

/** Pesewas as cedis with two places, for a sentence shown to a shopper. */
export function cedis(pesewas: bigint): string {
  const whole = pesewas / 100n;
  const part = pesewas % 100n;
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${part.toString().padStart(2, '0')}`;
}

function tolerance(percent: string): string {
  return percent.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/**
 * The public catalogue's read model (FR-SHP-001, FR-SHP-002, docs/data-model/shp.md): one row per listed product at
 * the storefront's branch, rebuilt from MDM's online products, prices resolved by MDM's pricing engine on the ONLINE
 * channel (a banded animal at each band's floor weight, so its range is the engine's own), and availability from INV's
 * promisable stock as a level, never a count. Written only through `shp.replace_product_listing`. Refreshed by the
 * seed and every minute by the `catalogue-refresh` job (A-178); a cart and a checkout always re-resolve live.
 */
export class CatalogueListing {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ShpStore,
    private readonly storefront: Storefront,
    private readonly pricing: PricingService,
    private readonly refs: MasterDataRefs,
    private readonly stock: StockQueries,
    private readonly settings: Settings,
    private readonly clock: Clock,
  ) {}

  /** The storefront's branch (A-177): the head office. Null before the first branch exists. */
  branchIn(tx: Transaction): Promise<string | null> {
    return this.refs.headOfficeBranchIn(tx);
  }

  refresh(): Promise<{ readonly listed: number }> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const branchId = await this.branchIn(tx);
      return { listed: branchId === null ? 0 : await this.refreshIn(tx, branchId) };
    });
  }

  async refreshIn(tx: Transaction, branchId: string): Promise<number> {
    const products = await this.storefront.onlineProductsIn(tx);
    const slugs = assignSlugs(products);
    const prices = await this.priceRanges(tx, branchId, products);
    const available = await this.available(tx, branchId, products);
    const lowAt = BigInt(await this.settings.integer(LOW_STOCK_SETTING, LOW_STOCK_DEFAULT, branchId));
    const units = await this.sellingUnitsOf(tx, branchId, products, prices, available, lowAt);
    const rows: ListingRow[] = products.map((p) => {
      const chain = [...p.categoryChain].reverse();
      const price = prices.get(p.id)!;
      const catchWeight = p.stockPolicy === 'CATCH_WEIGHT' && p.nominalPackKg !== null;
      return {
        productId: p.id,
        slug: slugs.get(p.id)!,
        name: p.name,
        description: p.description,
        categoryCode: p.categoryChain[0]!.code,
        categoryCodes: chain.map((c) => c.code),
        categoryPath: chain.map((c) => c.name),
        categorySort: Math.max(0, p.categorySort),
        productLine: p.productLine,
        onlineMode: p.onlineMode,
        priceFromPesewas: price.from,
        priceToPesewas: price.to,
        priceBasis: price.basis,
        taxInclusive: price.taxInclusive,
        saleUom: p.saleUom,
        nominalPackKg: p.nominalPackKg,
        catchWeight,
        weightTolerancePercent: catchWeight ? p.weightTolerancePercent : null,
        availability: availabilityLevel(p.onlineMode, available.get(p.id)!.available, available.get(p.id)!.perSaleUnit, lowAt),
        images: p.images.map((image) => ({ alt: image.alt, variants: image.variants })),
        mainImageFileId: p.images[0]?.fileId ?? null,
        seoTitle: p.seoTitle,
        seoDescription: p.seoDescription,
        sellingUnits: units.get(p.id)!,
      };
    });
    return this.store.replaceListing(tx, branchId, rows);
  }

  /**
   * The units each product is sold by online (CR-039), the sale unit first, each priced by its own price list entry,
   * never derived from another unit's price (MDM's `sellingUnitsIn` on the ONLINE channel), with its own availability.
   * A catch-weight pack and a banded animal are sold in their one unit at the product's own range; so is a product only
   * one unit of which is priced. A unit no list in force prices is not offered.
   */
  private async sellingUnitsOf(
    tx: Transaction,
    branchId: string,
    products: readonly OnlineProductFacts[],
    prices: ReadonlyMap<string, { readonly from: bigint | null; readonly to: bigint | null }>,
    available: ReadonlyMap<string, { readonly available: Quantity; readonly perSaleUnit: Quantity }>,
    lowAt: bigint,
  ): Promise<ReadonlyMap<string, SellingUnitListing[]>> {
    const floors = await this.storefront.bandFloorsIn(tx, products.flatMap((p) => (p.speciesId === null ? [] : [p.speciesId])));
    const several = products.filter((p) => p.stockPolicy !== 'CATCH_WEIGHT' && (p.speciesId === null || (floors.get(p.speciesId) ?? []).length === 0));
    const sold = several.length === 0 ? [] : (await this.pricing.sellingUnitsIn(tx, { channel: 'ONLINE', branchId, at: this.clock.now(), productIds: several.map((p) => p.id) })).products;
    const priced = new Map(sold.map((s) => [s.product.id, s.units.filter((u) => u.band !== null)] as const));
    const codes = new Set(products.map((p) => p.saleUom));
    for (const units of priced.values()) for (const u of units) codes.add(u.uom);
    const names = new Map((await this.refs.unitsIn(tx, [...codes])).map((u) => [u.code, u.name] as const));
    const result = new Map<string, SellingUnitListing[]>();
    for (const p of products) {
      const own = available.get(p.id)!;
      const units = priced.get(p.id) ?? [];
      if (units.length < 2) {
        const range = prices.get(p.id)!;
        result.set(p.id, [{ uom: p.saleUom, uomName: names.get(p.saleUom) ?? p.saleUom, priceFromPesewas: json(range.from), priceToPesewas: json(range.to), availability: availabilityLevel(p.onlineMode, own.available, own.perSaleUnit, lowAt) }]);
        continue;
      }
      const listed: SellingUnitListing[] = [];
      for (const u of units) {
        const per = await this.perUnit(tx, p, u.uom);
        listed.push({ uom: u.uom, uomName: names.get(u.uom) ?? u.uom, priceFromPesewas: Number(u.band!.listPricePesewas), priceToPesewas: null, availability: availabilityLevel(p.onlineMode, own.available, per, lowAt) });
      }
      result.set(p.id, listed);
    }
    return result;
  }

  /**
   * The units a cart line may name for a product (CR-039): those MDM's lists in force price on the ONLINE channel, the
   * sale unit first. A catch-weight pack is sold in its sale unit only.
   */
  async sellingUomsIn(tx: Transaction, branchId: string, product: OnlineProductFacts): Promise<readonly string[]> {
    if (product.stockPolicy === 'CATCH_WEIGHT') return [product.saleUom];
    const [sold] = (await this.pricing.sellingUnitsIn(tx, { channel: 'ONLINE', branchId, at: this.clock.now(), productIds: [product.id] })).products;
    return (sold?.units ?? []).filter((u) => u.band !== null).map((u) => u.uom);
  }

  private async priceRanges(tx: Transaction, branchId: string, products: readonly OnlineProductFacts[]) {
    const floors = await this.storefront.bandFloorsIn(tx, products.flatMap((p) => (p.speciesId === null ? [] : [p.speciesId])));
    // One sale unit of each: a crate of eggs is listed at the crate's own price (B09e), when the product converts from it.
    const saleUnits = new Map<string, string>();
    for (const p of products) {
      const uom = pricingUom(p);
      if (uom !== undefined && (await this.refs.toBaseIn(tx, p.id, uom, Quantity.ofUnits(1n))).ok) saleUnits.set(p.id, uom);
    }
    const lines: ResolveLine[] = products.flatMap((p): ResolveLine[] => {
      const bands = p.speciesId === null ? [] : (floors.get(p.speciesId) ?? []);
      if (bands.length > 0) return bands.map((kg, index) => ({ lineRef: `${p.id}:${index}`, productId: p.id, weightKg: kg, quantity: '1.000' }));
      const uom = saleUnits.get(p.id);
      return [
        {
          lineRef: `${p.id}:0`,
          productId: p.id,
          quantity: '1.000',
          ...(p.stockPolicy === 'CATCH_WEIGHT' && p.nominalPackKg !== null ? { weightKg: p.nominalPackKg } : {}),
          ...(uom === undefined ? {} : { uom }),
        },
      ];
    });
    const resolved = lines.length === 0 ? [] : (await this.pricing.resolveIn(tx, { channel: 'ONLINE', branchId, lines })).lines;
    const inclusive = await this.storefront.priceListsTaxInclusiveIn(tx, resolved.flatMap((r) => (r.resolved === null ? [] : [r.resolved.priceList.id])));
    const byProduct = new Map<string, { prices: bigint[]; basis: PriceBasis | null; taxInclusive: boolean | null }>(products.map((p) => [p.id, { prices: [], basis: null, taxInclusive: null }]));
    for (const line of resolved) {
      if (line.resolved === null) continue;
      const entry = byProduct.get(line.lineRef.split(':')[0]!)!;
      entry.prices.push(BigInt(line.resolved.listPricePesewas));
      entry.basis ??= line.resolved.basis;
      entry.taxInclusive ??= inclusive.get(line.resolved.priceList.id) ?? null;
    }
    return new Map([...byProduct].map(([id, entry]) => [id, { ...priceRange(entry.prices), basis: entry.basis, taxInclusive: entry.taxInclusive }] as const));
  }

  /** Each product's promisable stock in its base unit, and how much of it one sale unit is (a nominal pack, a crate). */
  private async available(tx: Transaction, branchId: string, products: readonly OnlineProductFacts[]) {
    const listed = products.filter((p) => p.onlineMode === 'LISTED');
    const rows = await this.stock.promisableIn(tx, branchId, listed.map((p) => p.id));
    const result = new Map<string, { available: Quantity; perSaleUnit: Quantity }>();
    for (const p of products) {
      const perSaleUnit = await this.perSaleUnit(tx, p);
      const available = Quantity.sum(rows.filter((r) => r.productId === p.id).map((r) => r.availableQty));
      result.set(p.id, { available, perSaleUnit });
    }
    return result;
  }

  /**
   * One sale unit in the base unit: a catch-weight pack is its nominal weight, an estimate only (A-157, A-178); any
   * other sale unit converts through MDM's exact conversion, or counts one for one when there is none.
   */
  async perSaleUnit(tx: Transaction, product: Pick<OnlineProductFacts, 'id' | 'stockPolicy' | 'nominalPackKg' | 'saleUom' | 'baseUom'>): Promise<Quantity> {
    return this.perUnit(tx, product, product.saleUom);
  }

  /** One of a unit in the base unit (CR-039: a crate is 30 eggs, an egg is one); a catch-weight pack its nominal weight. */
  async perUnit(tx: Transaction, product: Pick<OnlineProductFacts, 'id' | 'stockPolicy' | 'nominalPackKg' | 'baseUom'>, uom: string): Promise<Quantity> {
    if (product.stockPolicy === 'CATCH_WEIGHT' && product.nominalPackKg !== null) return Quantity.parse(product.nominalPackKg);
    if (uom === product.baseUom) return Quantity.ofUnits(1n);
    const converted = await this.refs.toBaseIn(tx, product.id, uom, Quantity.ofUnits(1n));
    return converted.ok ? converted.value : Quantity.ofUnits(1n);
  }
}

/** The public catalogue (FR-SHP-001, FR-SHP-002): anonymous, cacheable reads of the listing, sorted by CR-019's keyset. */
export class Catalogue {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ShpStore,
    private readonly listing: CatalogueListing,
    private readonly storefront: Storefront,
    private readonly cursors: Cursors,
  ) {}

  list(query: CatalogueFilters & { readonly sort?: string | undefined }, cursor: string | undefined, limit: number): Promise<Page<CatalogueItemView> & { readonly facets: Awaited<ReturnType<ShpStore['facets']>> }> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const asked = query.sort ?? 'RELEVANCE';
      const chosen = Object.prototype.hasOwnProperty.call(CATALOGUE_SORTS, asked) ? CATALOGUE_SORTS[asked as CatalogueSort] : null;
      // A value outside the contract's list reaches the shared sort as a field name, which refuses it (400 SORT_NOT_ALLOWED).
      const order = resolveSort(CATALOGUE_ORDER, chosen?.[0] ?? asked, chosen?.[1]);
      const filters: CatalogueFilters = { q: query.q, category: query.category, productLine: query.productLine, availability: query.availability };
      const binding = { operationId: 'listCatalogue', principalId: CUSTOMER, filters: { ...filters, sort: query.sort ?? null } };
      const position = cursor === undefined ? null : decodePosition(order, this.cursors.decode(cursor, binding));
      const branchId = await this.listing.branchIn(tx);
      const empty = { data: [], page: { nextCursor: null, limit, hasMore: false }, facets: { categories: [], productLines: [] } };
      if (branchId === null) return empty;
      const found = await this.store.listingPage(tx, branchId, filters, order, position, limit + 1);
      const rows = found.slice(0, limit);
      const last = rows.at(-1);
      const hasMore = found.length > limit;
      return {
        data: rows.map(item),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, encodePosition(last.position)) : null, limit, hasMore },
        facets: await this.store.facets(tx, branchId, filters),
      };
    });
  }

  product(slug: string): Promise<ProductDetailView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const branchId = await this.listing.branchIn(tx);
      const row = branchId === null ? null : await this.store.listingBySlug(tx, branchId, slug);
      if (row === null || branchId === null) throw new NotFoundError(`no listed product ${slug}`);
      const { image: _image, taxInclusive, ...base } = item(row);
      return {
        ...base,
        description: row.description,
        taxInclusive: taxInclusive ?? true,
        weightTolerancePercent: row.weightTolerancePercent,
        finalChargeRule:
          row.catchWeight && row.priceFromPesewas !== null && row.weightTolerancePercent !== null
            ? fill('shp.product_charge_rule', { price: cedis(row.priceFromPesewas), tolerance: tolerance(row.weightTolerancePercent) })
            : null,
        images: row.images,
        seo: { slug: row.slug, title: row.seoTitle, description: row.seoDescription },
        relatedSlugs: await this.store.relatedSlugs(tx, branchId, row.categoryCode, row.productId, RELATED_LIMIT),
        currency: 'GHS',
      };
    });
  }

  categories(cursor: string | undefined, limit: number): Promise<Page<{ readonly code: string; readonly name: string; readonly parentCode: string | null; readonly productCount: number; readonly image: null }>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const branchId = await this.listing.branchIn(tx);
      const counts = branchId === null ? new Map<string, number>() : await this.store.categoryCounts(tx, branchId);
      const all = (await this.storefront.onlineCategoriesIn(tx)).filter((c) => (counts.get(c.code) ?? 0) > 0);
      const binding = { operationId: 'listShopCategories', principalId: CUSTOMER, filters: {} };
      // A signed cursor (docs/API.md section 5): its offset was written by this list and cannot be forged.
      const after = cursor === undefined ? 0 : Number(this.cursors.decode(cursor, binding)['offset']);
      const data = all.slice(after, after + limit).map((c) => ({ code: c.code, name: c.name, parentCode: c.parentCode, productCount: counts.get(c.code) ?? 0, image: null }));
      const hasMore = all.length > after + limit;
      return { data, page: { nextCursor: hasMore ? this.cursors.encode(binding, { offset: String(after + limit) }) : null, limit, hasMore } };
    });
  }
}
