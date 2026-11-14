import { Money, Quantity, Weight, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Authoriser } from '../../iam';
import { PRICE_LIST_KINDS, resolvePrice, type Channel, type PriceBasis, type PriceListCandidate, type PriceListRef, type QuoteRequiredReason } from '../domain/pricing/pricing-engine';
import { referencesNotFound } from './errors';
import type { BandRow, GradeRow, ListInForce, PricingStore } from './pricing-store';

export const RESOLVE_PRICES = 'resolvePrices';

export interface ResolveLine {
  readonly lineRef: string;
  readonly productId: string;
  readonly stockUnitId?: string | undefined;
  readonly gradeId?: string | undefined;
  readonly weightKg?: string | undefined;
  readonly quantity: string;
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

/** The contract's `PriceResolution`. Promotions arrive with B04 continued; until a promotion can exist the list is empty. */
export interface PriceResolutionView {
  readonly lineRef: string;
  readonly outcome: 'RESOLVED' | 'QUOTE_REQUIRED';
  readonly resolved: {
    readonly priceListEntryId: string;
    readonly priceList: PriceListRef;
    readonly basis: PriceBasis;
    readonly listPricePesewas: number;
    readonly floorPricePesewas: number;
    readonly ceilingPricePesewas: number;
    readonly grade: Ref | null;
    readonly weightBand: WeightBandRefView | null;
  } | null;
  readonly quoteRequiredReason: QuoteRequiredReason | null;
  readonly promotions: readonly never[];
}

export interface PriceResolveResultView {
  readonly channel: Channel;
  readonly resolvedAt: string;
  readonly currency: 'GHS';
  readonly lines: readonly PriceResolutionView[];
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
    // No coupon can exist until coupons are built (B04 continued), and no stock unit until inventory (B5): an id for
    // either names no record.
    if (request.couponCode !== undefined) unknown.push('/couponCode');
    request.lines.forEach((line, index) => {
      const product = products.get(line.productId);
      if (product === undefined) unknown.push(`/lines/${index}/productId`);
      if (line.stockUnitId !== undefined) unknown.push(`/lines/${index}/stockUnitId`);
      const grade = line.gradeId === undefined ? undefined : grades.get(line.gradeId);
      if (line.gradeId !== undefined && (grade === undefined || (product !== undefined && grade.speciesId !== product.speciesId))) {
        unknown.push(`/lines/${index}/gradeId`);
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

    const lines = request.lines.map((line): PriceResolutionView => {
      const product = products.get(line.productId)!;
      const speciesBands = bands.filter((band) => band.speciesId === product.speciesId);
      const candidates: PriceListCandidate[] = ordered.map((entry) => ({ list: entry.list, entries: entry.entries.filter((e) => e.productId === line.productId) }));
      const result = resolvePrice(
        { gradeId: line.gradeId ?? null, weight: line.weightKg === undefined ? null : Weight.parseKg(line.weightKg), quantity: Quantity.parse(line.quantity) },
        speciesBands,
        candidates,
      );
      if (result.kind === 'QuoteRequired') {
        return { lineRef: line.lineRef, outcome: 'QUOTE_REQUIRED', resolved: null, quoteRequiredReason: result.reason, promotions: [] };
      }
      return {
        lineRef: line.lineRef,
        outcome: 'RESOLVED',
        resolved: {
          priceListEntryId: result.entry.id,
          priceList: result.list,
          basis: result.entry.basis,
          listPricePesewas: Money.ofPesewas(result.entry.listPricePesewas).toJsonInteger(),
          floorPricePesewas: Money.ofPesewas(result.entry.floorPricePesewas).toJsonInteger(),
          ceilingPricePesewas: Money.ofPesewas(result.entry.ceilingPricePesewas).toJsonInteger(),
          grade: gradeRef(result.entry.gradeId, grades),
          weightBand: bandRef(result.weightBand?.id ?? null, speciesBands),
        },
        quoteRequiredReason: null,
        promotions: [],
      };
    });
    return { channel: request.channel, resolvedAt: at.toISOString(), currency: 'GHS', lines };
  }
}

function gradeRef(id: string | null, grades: ReadonlyMap<string, GradeRow>): Ref | null {
  const grade = id === null ? undefined : grades.get(id);
  return grade === undefined ? null : { id: grade.id, code: grade.code, name: grade.name };
}

function bandRef(id: string | null, bands: readonly BandRow[]): WeightBandRefView | null {
  const band = bands.find((candidate) => candidate.id === id);
  return band === undefined ? null : { id: band.id, code: band.code, minKg: band.minKg, maxKg: band.maxKg };
}
