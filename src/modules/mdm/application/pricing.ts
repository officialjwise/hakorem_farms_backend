import { Money, Quantity, Weight, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Authoriser } from '../../iam';
import {
  extendPrice,
  PRICE_LIST_KINDS,
  resolvePrice,
  type Channel,
  type PriceBasis,
  type PriceListCandidate,
  type PriceListRef,
  type PriceResolution,
  type QuoteRequiredReason,
} from '../domain/pricing/pricing-engine';
import { applyLinePromotions, judgeCoupon } from '../domain/pricing/promotions';
import { sellingUnits } from '../domain/pricing/selling-units';
import { toBase } from '../domain/unit-conversion';
import { CouponUnavailableError, referencesNotFound } from './errors';
import type { CouponRow, PromotionStore } from './promotion-store';
import { promotionRule } from './promotions';
import type { BandRow, GradeRow, ListInForce, PricingStore } from './pricing-store';

export const RESOLVE_PRICES = 'resolvePrices';

export interface ResolveLine {
  readonly lineRef: string;
  readonly productId: string;
  readonly stockUnitId?: string | undefined;
  readonly gradeId?: string | undefined;
  readonly weightKg?: string | undefined;
  /** In `uom`: the product's base unit when it is left out, otherwise a unit the product is sold by (a crate, B09e). */
  readonly quantity: string;
  /** The unit sold. Only an entry for that unit prices the line; a crate's price is never derived from an egg's. */
  readonly uom?: string | undefined;
}

export interface ResolveRequest {
  readonly channel: Channel;
  readonly branchId: string;
  readonly customerId?: string | undefined;
  readonly at?: Date | undefined;
  readonly couponCode?: string | undefined;
  readonly lines: readonly ResolveLine[];
}

interface Ref {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface WeightBandRefView {
  readonly id: string;
  readonly code: string;
  readonly minKg: string;
  readonly maxKg: string;
}

/** The contract's `AppliedPromotion`: a discount recorded beside the price, on the line extended at list (ADR-0040). */
export interface AppliedPromotionView {
  readonly promotionId: string;
  readonly code: string;
  readonly name: string;
  readonly discountPesewas: number;
}

/** The contract's `PriceResolution`. */
export interface PriceResolutionView {
  readonly lineRef: string;
  readonly outcome: 'RESOLVED' | 'QUOTE_REQUIRED';
  readonly resolved: {
    readonly priceListEntryId: string;
    readonly priceList: PriceListRef;
    readonly basis: PriceBasis;
    /** The unit the price is for: the unit the line was asked in (B09e). */
    readonly uom: string;
    readonly listPricePesewas: number;
    readonly floorPricePesewas: number;
    readonly ceilingPricePesewas: number;
    readonly grade: Ref | null;
    readonly weightBand: WeightBandRefView | null;
  } | null;
  readonly quoteRequiredReason: QuoteRequiredReason | null;
  readonly promotions: readonly AppliedPromotionView[];
}

export interface PriceResolveResultView {
  readonly channel: Channel;
  readonly resolvedAt: string;
  readonly currency: 'GHS';
  readonly lines: readonly PriceResolutionView[];
}

/** One unit a till sells a product by (CR-038), priced as `resolvePrices` would price one of it, no quantity break. */
export interface SellingUnitView {
  readonly uom: string;
  /** The entry it resolved from, its band and basis; null when one of the unit needs a quote (a grade or a weight). */
  readonly priceListEntryId: string | null;
  readonly band: { readonly basis: PriceBasis; readonly listPricePesewas: bigint; readonly floorPricePesewas: bigint; readonly ceilingPricePesewas: bigint } | null;
  /** The basis of the entries for this unit, resolved or not. */
  readonly basis: PriceBasis;
  /** The engine stopped at an entry marked quote only. */
  readonly quoteOnly: boolean;
  /** Whether the list it is priced from includes tax (the first list with an entry for it when it does not resolve). */
  readonly taxInclusive: boolean;
}

/** A product as a till sells it (B09b continued 2, CR-038), with every unit it is sold by, the first being the default. */
export interface SellingProductView {
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly saleUom: string;
  readonly baseUom: string;
  readonly taxCategoryId: string;
  readonly categoryName: string;
  readonly units: readonly SellingUnitView[];
}

/** What a channel's lists in force sell at a branch at an instant. */
export interface SellingUnitsView {
  /** Every price list version in force that fills one of the walk's slots, by id. */
  readonly priceListVersionIds: readonly string[];
  readonly products: readonly SellingProductView[];
}

/**
 * The walk's slots in order (ADR-0004, ADR-0036): the customer's list, then tier and channel, then channel, then
 * base. Inside one slot a list for this branch comes before the list for every branch, and the walk falls through
 * from one to the other like any other slot.
 */
function walkOrder(lists: readonly ListInForce[]): ListInForce[] {
  const slot = (entry: ListInForce) => PRICE_LIST_KINDS.indexOf(entry.list.kind);
  return [...lists].sort((a, b) => {
    if (slot(a) !== slot(b)) {
      return slot(a) < slot(b) ? -1 : 1;
    }
    if ((a.branchId === null) === (b.branchId === null)) {
      return 0;
    }
    return a.branchId === null ? 1 : -1;
  });
}

/**
 * `resolvePrices` (FR-MDM-016, FR-MDM-017): read-only, nothing is stored. Authorises, checks every id the request
 * names, loads the lists in force at the pricing time and runs the pure engine per line. A line the engine cannot
 * price is a QUOTE_REQUIRED outcome, never an error; an id that names nothing is a 422, because that is a broken
 * request, not an unpriced product.
 */
export class PricingService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: PricingStore,
    private readonly promotions: PromotionStore,
    private readonly authoriser: Authoriser,
    private readonly clock: Clock,
  ) {}

  async resolve(actor: Actor | undefined, request: ResolveRequest): Promise<PriceResolveResultView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      // Permission only, no branch or location scope (ADR-0036): prices are INTERNAL, a cashier's grant is scoped to
      // the shop floor, and every operation that sells at a price checks its own location scope.
      await this.authoriser.authorise(tx, actor, 'mdm.price.resolve');
      return this.resolveIn(tx, request);
    });
  }

  /** The same resolution inside a caller's transaction, for the selling modules (B9a onward) through MDM's door. */
  async resolveIn(tx: Transaction, request: ResolveRequest): Promise<PriceResolveResultView> {
    const at = request.at ?? this.clock.now();
    const productIds = request.lines.map((line) => line.productId);
    const gradeIds = request.lines.flatMap((line) => (line.gradeId === undefined ? [] : [line.gradeId]));
    const [branchFound, products, grades, customer] = await Promise.all([
      this.store.branchExists(tx, request.branchId),
      this.store.products(tx, productIds),
      this.store.grades(tx, gradeIds),
      request.customerId === undefined ? Promise.resolve(null) : this.store.customer(tx, request.customerId, at),
    ]);

    const unknown: string[] = [];
    if (!branchFound) unknown.push('/branchId');
    if (request.customerId !== undefined && customer === null) unknown.push('/customerId');
    // No stock unit can exist until inventory (B5): an id names no record.
    const coupon = request.couponCode === undefined ? null : await this.promotions.couponByCode(tx, request.couponCode.toUpperCase());
    if (request.couponCode !== undefined && coupon === null) unknown.push('/couponCode');
    request.lines.forEach((line, index) => {
      const product = products.get(line.productId);
      if (product === undefined) unknown.push(`/lines/${index}/productId`);
      if (line.stockUnitId !== undefined) unknown.push(`/lines/${index}/stockUnitId`);
      const grade = line.gradeId === undefined ? undefined : grades.get(line.gradeId);
      if (line.gradeId !== undefined && (grade === undefined || (product !== undefined && grade.speciesId !== product.speciesId))) {
        unknown.push(`/lines/${index}/gradeId`);
      }
      // A unit the product is not sold by names nothing to price; so does a quantity in it that is no exact base quantity.
      if (product !== undefined && line.uom !== undefined && line.uom !== product.baseUom) {
        const factor = product.factors.get(line.uom);
        if (factor === undefined || !toBase(Quantity.parse(line.quantity), factor).ok) unknown.push(`/lines/${index}/uom`);
      }
    });
    if (unknown.length > 0) {
      throw referencesNotFound(unknown);
    }

    const speciesIds = [...new Set([...products.values()].flatMap((product) => (product.speciesId === null ? [] : [product.speciesId])))];
    const [bands, lists] = await Promise.all([
      this.store.bands(tx, speciesIds),
      this.store.listsInForce(tx, { channel: request.channel, branchId: request.branchId, tierId: customer?.tierId ?? null, customerListId: customer?.assignedListId ?? null }, at, productIds),
    ]);
    const ordered = walkOrder(lists);

    const couponPromotionId = coupon === null ? null : await this.usableCoupon(tx, coupon, customer?.id ?? null, at);
    const results = request.lines.map((line) => {
      const product = products.get(line.productId)!;
      const speciesBands = bands.filter((band) => band.speciesId === product.speciesId);
      const candidates: PriceListCandidate[] = ordered.map((entry) => ({ list: entry.list, entries: entry.entries.filter((e) => e.productId === line.productId) }));
      const weight = line.weightKg === undefined ? null : Weight.parseKg(line.weightKg);
      const quantity = Quantity.parse(line.quantity);
      // The unit sold, and the quantity in the base unit that quantity breaks count in (10 crates are 300 eggs).
      const uom = line.uom === undefined || line.uom === product.baseUom ? null : line.uom;
      const baseQuantity = uom === null ? quantity : (toBase(quantity, product.factors.get(uom)!) as { readonly value: Quantity }).value;
      const result = resolvePrice({ gradeId: line.gradeId ?? null, weight, quantity: baseQuantity, uom }, speciesBands, candidates);
      // The line extended at list price, the anchor a discount is taken from, by the quantity in the unit sold; a
      // per-kilogram line without a weight has none, so it takes no promotion until it is weighed.
      const extended = result.kind === 'Resolved' ? extendPrice(result.entry.listPricePesewas, result.entry.basis, { quantity, weight }) : null;
      return { line, product, speciesBands, result, uom: uom ?? product.baseUom, lineAmount: extended?.ok === true ? extended.value : null };
    });
    const rules = (await this.promotions.inForce(tx, request.channel, at)).map(promotionRule);
    const orderAmountPesewas = results.reduce((sum, item) => sum + (item.lineAmount ?? 0n), 0n);

    const lines = results.map(({ line, product, speciesBands, result, uom, lineAmount }): PriceResolutionView => {
      if (result.kind === 'QuoteRequired') {
        return { lineRef: line.lineRef, outcome: 'QUOTE_REQUIRED', resolved: null, quoteRequiredReason: result.reason, promotions: [] };
      }
      const applied =
        lineAmount === null
          ? []
          : applyLinePromotions(
              { productId: line.productId, categoryIds: product.categoryIds, channel: request.channel, priceListKind: result.list.kind, lineAmountPesewas: lineAmount, at },
              rules,
              { orderAmountPesewas, couponPromotionId },
            );
      return {
        lineRef: line.lineRef,
        outcome: 'RESOLVED',
        resolved: resolvedView(result, uom, grades, speciesBands),
        quoteRequiredReason: null,
        promotions: applied.map((item) => ({
          promotionId: item.promotion.id,
          code: item.promotion.code,
          name: item.promotion.name,
          discountPesewas: Money.ofPesewas(item.discountPesewas).toJsonInteger(),
        })),
      };
    });
    return { channel: request.channel, resolvedAt: at.toISOString(), currency: 'GHS', lines };
  }

  /**
   * The units each product is sold by on a channel at a branch for a buyer with no account, and the band of one of each,
   * in the caller's transaction (B09b continued 2, CR-038): the offline pack's products, and the units a counter sale
   * line may name. Each unit is priced by its own entry, never derived from another unit's price; a unit no list in
   * force prices is not sold. With no `productIds`, every product a list in force prices that a counter may sell
   * (ACTIVE and held in stock); with them, exactly those, whatever their state, for a caller that judges them itself.
   */
  async sellingUnitsIn(tx: Transaction, request: { readonly channel: Channel; readonly branchId: string; readonly at: Date; readonly productIds?: readonly string[] }): Promise<SellingUnitsView> {
    const slots = { channel: request.channel, branchId: request.branchId, tierId: null, customerListId: null };
    const ids = request.productIds ?? (await this.store.pricedProductIds(tx, slots, request.at));
    const [facts, pricing, lists] = await Promise.all([this.store.saleProducts(tx, ids), this.store.products(tx, ids), this.store.listsInForce(tx, slots, request.at, ids)]);
    const ordered = walkOrder(lists);
    const bands = await this.store.bands(tx, [...new Set([...pricing.values()].flatMap((p) => (p.speciesId === null ? [] : [p.speciesId])))]);
    const products: SellingProductView[] = [];
    for (const id of ids) {
      const fact = facts.get(id);
      const product = pricing.get(id);
      if (fact === undefined || product === undefined || (request.productIds === undefined && !fact.sellable)) continue;
      const candidates: (PriceListCandidate & { readonly source: ListInForce })[] = ordered.map((entry) => ({ list: entry.list, entries: entry.entries.filter((e) => e.productId === id), source: entry }));
      const uoms = sellingUnits({ saleUom: fact.saleUom, baseUom: fact.baseUom, converts: (uom) => product.factors.has(uom) }, candidates.flatMap((c) => c.entries.map((e) => e.uom)));
      const units = uoms.map((uom): SellingUnitView => {
        const query = uom === fact.baseUom ? null : uom;
        const one = query === null ? { ok: true as const, value: Quantity.ofUnits(1n) } : toBase(Quantity.ofUnits(1n), product.factors.get(query)!);
        const inUnit = (e: { readonly uom: string | null }) => (e.uom ?? fact.baseUom) === uom;
        const first = candidates.find((c) => c.entries.some(inUnit))!;
        const basis = first.entries.find(inUnit)!.basis;
        const result = one.ok ? resolvePrice({ gradeId: null, weight: null, quantity: one.value, uom: query }, bands.filter((b) => b.speciesId === product.speciesId), candidates) : null;
        if (result?.kind === 'Resolved') {
          const source = candidates.find((c) => c.list.id === result.list.id)!.source;
          const entry = result.entry;
          return {
            uom,
            priceListEntryId: entry.id,
            band: { basis: entry.basis, listPricePesewas: entry.listPricePesewas, floorPricePesewas: entry.floorPricePesewas, ceilingPricePesewas: entry.ceilingPricePesewas },
            basis: entry.basis,
            quoteOnly: false,
            taxInclusive: source.taxInclusive,
          };
        }
        return { uom, priceListEntryId: null, band: null, basis, quoteOnly: result?.kind === 'QuoteRequired' && result.reason === 'QUOTE_ONLY', taxInclusive: first.source.taxInclusive };
      });
      if (units.length === 0 && request.productIds === undefined) continue;
      products.push({ product: { id: fact.id, sku: fact.sku, name: fact.name }, saleUom: fact.saleUom, baseUom: fact.baseUom, taxCategoryId: fact.taxCategoryId, categoryName: fact.categoryName, units });
    }
    products.sort((a, b) => (a.product.sku < b.product.sku ? -1 : a.product.sku > b.product.sku ? 1 : 0));
    return { priceListVersionIds: [...new Set(lists.map((l) => l.versionId))].sort(), products };
  }

  /** The promotion a coupon unlocks, if it may be used now by this customer; a coupon that may not is a 422 that says why. */
  private async usableCoupon(tx: Transaction, coupon: CouponRow, customerId: string | null, at: Date): Promise<string> {
    const promotion = (await this.promotions.promotion(tx, coupon.promotionId, false))!;
    const uses = customerId === null ? 0 : await this.promotions.customerUses(tx, coupon.id, customerId);
    const refusal = judgeCoupon({ ...coupon, promotionStatus: promotion.status, validFrom: promotion.validFrom, validTo: promotion.validTo }, uses, at);
    if (refusal !== null) {
      throw new CouponUnavailableError('/couponCode', refusal);
    }
    return promotion.id;
  }
}

function resolvedView(result: Extract<PriceResolution, { kind: 'Resolved' }>, uom: string, grades: ReadonlyMap<string, GradeRow>, bands: readonly BandRow[]): PriceResolutionView['resolved'] {
  return {
    priceListEntryId: result.entry.id,
    priceList: result.list,
    basis: result.entry.basis,
    uom,
    listPricePesewas: Money.ofPesewas(result.entry.listPricePesewas).toJsonInteger(),
    floorPricePesewas: Money.ofPesewas(result.entry.floorPricePesewas).toJsonInteger(),
    ceilingPricePesewas: Money.ofPesewas(result.entry.ceilingPricePesewas).toJsonInteger(),
    grade: gradeRef(result.entry.gradeId, grades),
    weightBand: bandRef(result.weightBand?.id ?? null, bands),
  };
}

function gradeRef(id: string | null, grades: ReadonlyMap<string, GradeRow>): Ref | null {
  const grade = id === null ? undefined : grades.get(id);
  return grade === undefined ? null : { id: grade.id, code: grade.code, name: grade.name };
}

function bandRef(id: string | null, bands: readonly BandRow[]): WeightBandRefView | null {
  const band = bands.find((candidate) => candidate.id === id);
  return band === undefined ? null : { id: band.id, code: band.code, minKg: band.minKg, maxKg: band.maxKg };
}
