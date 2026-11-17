import { stockUnitLabel, type StockUnitLabelPrint } from '../domain/label';
import { Money, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRefRecord, DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import { decodePosition, encodePosition, requestedSort, type SortFields, type SortOrder, type SortRequest } from '../../../platform/http/keyset-sort';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs, ProductFacts } from '../../mdm';
import { availabilityOf, type Availability } from '../domain/availability';
import { unitCost, valueLines } from '../domain/valuation/pool-lines';
import { addDays, daysBetween, pageProbe } from './counting';
import type { ReadScope } from './goods-receipt-store';
import type { Lineage, TracedUnit } from './lineage';
import type { CostElement, LinkType } from './stock-store';
import type { HoldKind, OnHandFilters, OnHandRow, StockReadStore, StockUnitFilters, StockUnitRow } from './stock-read-store';

const COST_ELEMENTS: readonly CostElement[] = ['PURCHASE', 'FEED', 'VETERINARY', 'LABOUR', 'OVERHEAD', 'PROCESSING'];

interface ProductRefView {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
}
interface UnitRefView {
  readonly id: string;
  readonly identifier: string;
  readonly tracking: 'SERIAL' | 'LOT';
}
interface LocationRefView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
}

export interface StockOnHandLineView {
  readonly product: ProductRefView;
  readonly stockUnit: UnitRefView | null;
  readonly location: LocationRefView;
  readonly branchId: string;
  readonly uom: string;
  readonly uomDisplayDecimals: number;
  readonly onHandQty: string;
  readonly reservedQty: string;
  readonly heldQty: string;
  readonly availableQty: string;
  readonly onHandWeightKg: string | null;
  readonly packCount: number | null;
  readonly unitCostPesewas: number;
  readonly valueAtCostPesewas: number;
  readonly valuationMethod: 'WEIGHTED_AVERAGE' | 'SPECIFIC_IDENTIFICATION';
  readonly priceBand: null;
  readonly expiresOn: string | null;
  readonly ageDays: number | null;
  readonly holds: readonly HoldKind[];
}

export interface StockOnHandPageView {
  readonly data: readonly StockOnHandLineView[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
  readonly totalValueAtCostPesewas: number;
  readonly currency: 'GHS';
  readonly asOf: string;
}

export interface OnHandQuery extends OnHandFilters {
  readonly categoryId?: string | undefined;
  readonly includeZero?: boolean | undefined;
  readonly expiringWithinDays?: number | undefined;
}

export interface StockUnitQuery {
  readonly q?: string | undefined;
  readonly productId?: string | undefined;
  readonly locationId?: string | undefined;
  readonly status?: StockUnitRow['status'] | undefined;
  readonly tracking?: 'SERIAL' | 'LOT' | undefined;
  readonly expiringWithinDays?: number | undefined;
  readonly onHold?: boolean | undefined;
}

export interface AvailabilityQuery {
  readonly branchId: string;
  readonly productId?: readonly string[] | undefined;
  readonly locationId?: string | undefined;
}

/** The contract's `AvailabilityLine`. */
export interface AvailabilityLineView {
  readonly productId: string;
  readonly uom: string;
  readonly onHandQty: string;
  readonly reservedQty: string;
  readonly heldQty: string;
  readonly availableQty: string;
  readonly availability: Availability;
}

interface Page<V> {
  readonly data: readonly V[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/** Stock in transit or at a whole site is never promised (FR-INV-010, ADR-0048). */
const NOT_PROMISED_AT: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);

/** The contract's `StockUnitLabel`. */
export interface StockUnitLabelView extends StockUnitLabelPrint {
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' };
  readonly product: ProductRefView;
  readonly branchId: string;
  readonly onHandQty: string;
  readonly uom: string;
  readonly uomDisplayDecimals: number;
  readonly producedOn: string | null;
  readonly expiresOn: string | null;
  readonly storageTempClass: string | null;
}

export interface StockUnitView {
  readonly id: string;
  readonly product: ProductRefView;
  readonly tracking: 'SERIAL' | 'LOT';
  readonly branchId: string;
  readonly identifier: string;
  readonly currentLocation: LocationRefView | null;
  readonly status: string;
  readonly producedOn: string | null;
  readonly expiresOn: string | null;
  readonly storageTempClass: string | null;
  readonly supplier: { readonly id: string; readonly publicId: string; readonly name: string } | null;
  readonly grade: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly lastWeightKg: string | null;
  readonly lastWeighedAt: string | null;
  readonly onHandQty: string;
  readonly uom: string;
  readonly uomDisplayDecimals: number;
  readonly valueAtCostPesewas: number;
  readonly currency: 'GHS';
  readonly activeHolds: ReadonlyArray<{ readonly id: string; readonly kind: HoldKind; readonly startsAt: string; readonly endsAt: string | null }>;
  readonly activeReservation: { readonly id: string; readonly holderDocument: DocumentRefRecord; readonly expiresAt: string | null } | null;
  readonly sourceDocument: DocumentRefRecord;
  readonly createdAt: string;
}

interface TraceNodeView {
  readonly unit: UnitRefView;
  readonly product: ProductRefView;
  readonly linkType: LinkType;
  readonly sourceDocument: DocumentRefRecord;
  readonly depth: number;
}

export interface StockTraceView {
  readonly unit: UnitRefView;
  readonly product: ProductRefView;
  readonly ancestors: readonly TraceNodeView[];
  readonly descendants: readonly TraceNodeView[];
  readonly supplier: { readonly id: string; readonly publicId: string; readonly name: string } | null;
  readonly sales: ReadonlyArray<{
    readonly order: DocumentRefRecord;
    readonly billingDocument: null;
    readonly customer: null;
    readonly soldAt: string;
    readonly qty: string;
    readonly weightKg: string | null;
  }>;
  readonly costByElement: ReadonlyArray<{ readonly costElement: CostElement; readonly valuePesewas: number }>;
  readonly healthEvents: readonly never[];
  readonly currency: 'GHS';
}

const productRef = (p: ProductFacts): ProductRefView => ({ id: p.id, sku: p.sku, name: p.name });

/** One page of stock on hand lines, before they are valued and shown. */
interface OnHandPage {
  readonly rows: readonly OnHandRow[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/**
 * listStockOnHand's sort field (CR-019, ADR-0054), over the line's `inv.stock_balance b`, backed by an index of
 * migration 0121. The tie-breaker is the line's key (location, product, unit) as text in byte order, the order the
 * list answers in without a sort. A product's or location's name is MDM's and a value at cost is computed from the
 * cost pools by `allocate`, so neither is sortable here.
 */
const ON_HAND_SORT: SortFields<'onHandQty'> = {
  fields: { onHandQty: { expression: 'b.on_hand_qty', type: 'numeric' } },
  tieBreaker: { expression: `(b.location_id::text || '|' || b.product_id::text || '|' || COALESCE(b.stock_unit_id::text, '')) COLLATE "C"`, type: 'text' },
};

/**
 * listStockUnits' sort fields (CR-019, ADR-0054), over `inv.stock_unit u`, each backed by an index of migration 0121;
 * units with no expiry come last either way. A product's name is MDM's and a unit's value at cost is the sum of its cost
 * pools, so neither is sortable here; the default order (by id) is none of them.
 */
const STOCK_UNIT_SORT: SortFields<'identifier' | 'expiresOn'> = {
  fields: {
    identifier: { expression: 'lower(u.identifier)', type: 'text' },
    expiresOn: { expression: 'u.expires_on', type: 'date', nullable: true },
  },
  tieBreaker: { expression: 'u.id', type: 'uuid' },
};
const lineKey = (row: { readonly locationId: string; readonly productId: string; readonly stockUnitId: string | null }) =>
  `${row.locationId}|${row.productId}|${row.stockUnitId ?? ''}`;
const poolKey = (productId: string, stockUnitId: string | null, branchId: string) => `${productId}|${stockUnitId ?? ''}|${branchId}`;

/**
 * Stock reads (FR-INV-003, FR-INV-005, FR-INV-006, CR-001, CR-003): stock on hand with its value at cost, a stock
 * unit, and the trace both ways in the contract's shapes. On hand is the trigger-maintained balance; each line's
 * value at cost is its share of its pool by `allocate`, so the lines of a pool sum to the pool exactly, and the
 * total covers everything the filter matches, not the page. Every read is authorised in the handler and narrowed
 * to the branches and locations the reader's grants reach.
 */
/** Where stock is never promised to a buyer who is not at the counter: in transit, a whole site, awaiting inspection, on a van. */
const NOT_PROMISED_ONLINE: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE', 'RETURNS_HOLD', 'VEHICLE']);

/** One balance a reservation may promise from (`StockQueries.promisableIn`), first to be promised first. */
export interface PromisableStock {
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string;
  /** On hand less reserved, above zero. */
  readonly availableQty: Quantity;
  readonly expiresOn: string | null;
}

export class StockQueries {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StockReadStore,
    private readonly refs: MasterDataRefs,
    private readonly lineage: Lineage,
    private readonly authoriser: Authoriser,
    private readonly documents: DocumentRegistry,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  /**
   * The balances of these products at a branch that a remote buyer may be promised (FR-SHP-002, FR-SHP-005, A-178),
   * in the caller's transaction: physical, live locations other than in transit, a site, a returns hold or a van; no
   * unit under a hold in force, and no lot past its expiry date; on hand less reserved above zero. First to expire
   * first, then by unit and location, so a checkout reserves the oldest stock. Whether a reservation is still possible
   * when it is made is the database's (`ck_stock_reservation`).
   */
  async promisableIn(tx: Transaction, branchId: string, productIds: readonly string[]): Promise<PromisableStock[]> {
    const wanted = [...new Set(productIds)];
    const rows: OnHandRow[] = [];
    for (const productId of wanted) rows.push(...(await this.store.onHand(tx, { branchId, productId }, [{ branchId, locationId: null }], false, this.clock.now())));
    const locations = await this.refs.locationsIn(tx, rows.map((r) => r.locationId));
    const today = toBusinessDate(this.clock.now());
    return rows
      .filter((r) => {
        const location = locations.get(r.locationId);
        if (location === undefined || !location.isLive || location.isVirtual || NOT_PROMISED_ONLINE.has(location.kind)) return false;
        if (r.holds.length > 0 || (r.unit?.expiresOn !== null && r.unit?.expiresOn !== undefined && r.unit.expiresOn < today)) return false;
        return Quantity.parse(r.availableQty).compareTo(Quantity.zero()) > 0;
      })
      .map((r) => ({ productId: r.productId, stockUnitId: r.stockUnitId, locationId: r.locationId, availableQty: Quantity.parse(r.availableQty), expiresOn: r.unit?.expiresOn ?? null }))
      .sort((a, b) => {
        if (a.expiresOn !== b.expiresOn) return a.expiresOn === null ? 1 : b.expiresOn === null ? -1 : a.expiresOn < b.expiresOn ? -1 : 1;
        const unitA = a.stockUnitId ?? '';
        const unitB = b.stockUnitId ?? '';
        if (unitA !== unitB) return unitA < unitB ? -1 : 1;
        return a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : 0;
      });
  }

  /**
   * listStockOnHand (FR-INV-003, CR-001): in location, product and unit order, as it always was, unless the request
   * names a `sort` (CR-019, ADR-0054); then by `onHandQty` and `direction` through the shared keyset, the line's key
   * (location, product, unit) breaking ties, the page read in SQL with the same filters and scopes. The total and each
   * line's value at cost are the same either way.
   */
  listOnHand(actor: Actor | undefined, query: OnHandQuery, cursor: string | undefined, limit: number, sort: SortRequest = {}): Promise<StockOnHandPageView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.stock.read', query.branchId === undefined ? {} : { branchId: query.branchId, locationId: query.locationId ?? null });
      const scopes: ReadScope[] = (await this.authoriser.scopes(tx, actor!, 'inv.stock.read')).map((s) => ({ branchId: s.branchId, locationId: s.locationId }));
      const now = this.clock.now();
      const today = toBusinessDate(now);
      const order = requestedSort(ON_HAND_SORT, sort.sort, sort.direction);
      let rows = await this.store.onHand(tx, query, scopes, query.includeZero ?? false, now);
      const products = new Map(await this.refs.productsIn(tx, rows.map((r) => r.productId)));
      if (query.categoryId !== undefined) {
        rows = rows.filter((r) => products.get(r.productId)?.categoryId === query.categoryId);
      }
      if (query.expiringWithinDays !== undefined) {
        const limitDate = addDays(today, query.expiringWithinDays);
        rows = rows.filter((r) => r.unit?.expiresOn !== null && r.unit?.expiresOn !== undefined && r.unit.expiresOn <= limitDate);
      }
      const page = order === null ? this.onHandInKeyOrder(actor!, query, rows, cursor, limit) : await this.onHandSorted(tx, actor!, query, scopes, today, order, cursor, limit);
      const pageRows = page.rows;
      // A sorted page is a second read: a line that arrived after the total was read is valued as its pool's share too.
      const counted = new Set(rows.map(lineKey));
      const values = await this.lineValues(tx, [...rows, ...pageRows.filter((r) => !counted.has(lineKey(r)))]);
      const unknown = pageRows.filter((r) => !products.has(r.productId)).map((r) => r.productId);
      if (unknown.length > 0) for (const [productId, facts] of await this.refs.productsIn(tx, unknown)) products.set(productId, facts);
      const locations = await this.refs.locationsIn(tx, pageRows.map((r) => r.locationId));
      return {
        data: pageRows.map((r) => {
          const product = products.get(r.productId)!;
          const location = locations.get(r.locationId)!;
          const value = values.get(lineKey(r))!;
          const onHand = Quantity.parse(r.onHandQty);
          const held = r.holds.length > 0 && onHand.thousandths > 0n ? onHand : Quantity.zero();
          return {
            product: productRef(product),
            stockUnit: r.unit === null ? null : { id: r.stockUnitId!, identifier: r.unit.identifier, tracking: r.unit.tracking },
            location: { id: location.id, code: location.code, name: location.name, kind: location.kind },
            branchId: r.branchId,
            uom: product.baseUom,
            uomDisplayDecimals: product.uomDisplayDecimals,
            onHandQty: r.onHandQty,
            reservedQty: r.reservedQty,
            heldQty: held.toDecimalString(),
            availableQty: r.availableQty,
            onHandWeightKg: Quantity.parse(r.onHandWeightKg).isZero() ? null : r.onHandWeightKg,
            packCount: r.packCount === 0 ? null : r.packCount,
            unitCostPesewas: value.unitCost.toJsonInteger(),
            valueAtCostPesewas: value.value.toJsonInteger(),
            valuationMethod: r.stockUnitId === null ? 'WEIGHTED_AVERAGE' : 'SPECIFIC_IDENTIFICATION',
            priceBand: null,
            expiresOn: r.unit?.expiresOn ?? null,
            ageDays: r.unit?.producedOn == null ? null : daysBetween(r.unit.producedOn, today),
            holds: r.holds,
          };
        }),
        page: { nextCursor: page.nextCursor, limit, hasMore: page.hasMore },
        totalValueAtCostPesewas: Money.sum(rows.map((r) => values.get(lineKey(r))!.value)).toJsonInteger(),
        currency: 'GHS',
        asOf: now.toISOString(),
      };
    });
  }

  /** The default page of stock on hand: the matching lines in key order, strictly after the cursor's key. */
  private onHandInKeyOrder(actor: Actor, query: OnHandQuery, rows: readonly OnHandRow[], cursor: string | undefined, limit: number): OnHandPage {
    const binding = { operationId: 'listStockOnHand', principalId: actor.principalId, filters: { ...query } };
    const after = cursor === undefined ? null : ((this.cursors.decode(cursor, binding)['key'] as string | undefined) ?? null);
    const remaining = after === null ? rows : rows.filter((r) => lineKey(r) > after);
    const pageRows = remaining.slice(0, limit);
    const hasMore = remaining.length > limit;
    const last = pageRows.at(-1);
    return { rows: pageRows, hasMore, nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { key: lineKey(last) }) : null };
  }

  /**
   * A sorted page of stock on hand (CR-019, ADR-0054), read in SQL through the shared keyset with the list's filters:
   * the category's products from MDM's published interface, the expiry as a business date in Accra.
   */
  private async onHandSorted(
    tx: Transaction,
    actor: Actor,
    query: OnHandQuery,
    scopes: readonly ReadScope[],
    today: string,
    order: SortOrder,
    cursor: string | undefined,
    limit: number,
  ): Promise<OnHandPage> {
    const binding = { operationId: 'listStockOnHand', principalId: actor.principalId, filters: { ...query, sort: order.field, direction: order.direction } };
    const position = cursor === undefined ? null : decodePosition(order, this.cursors.decode(cursor, binding));
    const narrow = {
      productIds: query.categoryId === undefined ? null : await this.refs.productIdsInCategoryIn(tx, query.categoryId),
      expiresBy: query.expiringWithinDays === undefined ? null : addDays(today, query.expiringWithinDays),
    };
    const found = await this.store.onHandSorted(tx, query, scopes, query.includeZero ?? false, narrow, order, position, pageProbe(limit), this.clock.now());
    const pageRows = found.slice(0, limit);
    const hasMore = found.length > limit;
    const last = pageRows.at(-1);
    return { rows: pageRows, hasMore, nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, encodePosition(last.position)) : null };
  }

  getStockUnit(actor: Actor | undefined, id: string): Promise<StockUnitView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const unit = await this.store.stockUnit(tx, id, this.clock.now());
      await this.authoriser.authorise(tx, actor, 'inv.stock.read', unit === null ? {} : { branchId: unit.branchId, locationId: unit.currentLocationId });
      if (unit === null) throw new NotFoundError(`no stock unit ${id}`);
      return (await this.unitViews(tx, [unit]))[0]!;
    });
  }

  /**
   * What a label prints for a lot or an animal (B05x, A-151): the product, the batch or tag, the weight (a lot's on
   * hand, an animal's last recorded), its dates and storage class. No image is rendered and, from contract 2.0.0, no
   * barcode (ADR-0072); `printPackLabels` (B6) gives the meat packs theirs. Authorised as `getStockUnit` is, at the unit's branch and location.
   */
  getStockUnitLabel(actor: Actor | undefined, id: string): Promise<StockUnitLabelView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const unit = await this.store.stockUnit(tx, id, this.clock.now());
      await this.authoriser.authorise(tx, actor, 'inv.stock.read', unit === null ? {} : { branchId: unit.branchId, locationId: unit.currentLocationId });
      if (unit === null) throw new NotFoundError(`no stock unit ${id}`);
      const view = (await this.unitViews(tx, [unit]))[0]!;
      const balances = await this.store.onHand(tx, { stockUnitId: id }, [{ branchId: unit.branchId, locationId: null }], false, this.clock.now());
      const print = stockUnitLabel({
        tracking: view.tracking,
        identifier: view.identifier,
        onHandWeightsKg: balances.map((b) => b.onHandWeightKg),
        lastWeightKg: view.lastWeightKg,
        lastWeighedAt: view.lastWeighedAt,
      });
      return {
        stockUnit: { id: view.id, identifier: view.identifier, tracking: view.tracking },
        product: view.product,
        branchId: view.branchId,
        ...print,
        onHandQty: view.onHandQty,
        uom: view.uom,
        uomDisplayDecimals: view.uomDisplayDecimals,
        producedOn: view.producedOn,
        expiresOn: view.expiresOn,
        storageTempClass: view.storageTempClass,
      };
    });
  }

  /**
   * Animals and lots as stock units (FR-INV-005, FR-INV-016), in id order unless a `sort` is asked: filtered by tag or batch, product, where an
   * animal stands or a lot has stock, status, tracking, expiry within days of today in Accra, and whether a hold is in
   * force; narrowed to the branches the reader's grants reach and, for a grant at one location, the units there.
   */
  listStockUnits(actor: Actor | undefined, query: StockUnitQuery, cursor: string | undefined, limit: number, sort: SortRequest = {}): Promise<Page<StockUnitView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.stock.read');
      const scopes: ReadScope[] = (await this.authoriser.scopes(tx, actor!, 'inv.stock.read')).map((s) => ({ branchId: s.branchId, locationId: s.locationId }));
      const { expiringWithinDays, ...rest } = query;
      const now = this.clock.now();
      const filters: StockUnitFilters = { ...rest, expiresBy: expiringWithinDays === undefined ? undefined : addDays(toBusinessDate(now), expiringWithinDays) };
      const order = requestedSort(STOCK_UNIT_SORT, sort.sort, sort.direction);
      if (order !== null) {
        // By `identifier` or `expiresOn` (CR-019, ADR-0054), the unit id breaking ties, through the shared keyset.
        const binding = { operationId: 'listStockUnits', principalId: actor!.principalId, filters: { ...query, sort: order.field, direction: order.direction } };
        const position = cursor === undefined ? null : decodePosition(order, this.cursors.decode(cursor, binding));
        const found = await this.store.stockUnitIdsSorted(tx, filters, scopes, order, position, pageProbe(limit), now);
        const pageUnits = found.slice(0, limit);
        const units: StockUnitRow[] = [];
        for (const unit of pageUnits) units.push((await this.store.stockUnit(tx, unit.id, now))!);
        const last = pageUnits.at(-1);
        const hasMore = found.length > limit;
        return { data: await this.unitViews(tx, units), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, encodePosition(last.position)) : null, limit, hasMore } };
      }
      const binding = { operationId: 'listStockUnits', principalId: actor!.principalId, filters: { ...query } };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.stockUnitIds(tx, filters, scopes, after, pageProbe(limit), now);
      const pageIds = found.slice(0, limit);
      const units: StockUnitRow[] = [];
      for (const unitId of pageIds) units.push((await this.store.stockUnit(tx, unitId, now))!);
      const last = pageIds.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.unitViews(tx, units), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last }) : null, limit, hasMore } };
    });
  }

  /**
   * Available to promise per product at a branch (FR-INV-021, ADR-0019): on hand less reserved less held, over the
   * branch's physical stock locations, or one of them. Stock in transit is never promised (FR-INV-010, ADR-0048) and
   * is left out. A unit under a hold in force counts all its on hand as held (A-137 (d)). A listed product with no
   * stock answers a zero line. In product id order.
   */
  listAvailability(actor: Actor | undefined, query: AvailabilityQuery, cursor: string | undefined, limit: number): Promise<Page<AvailabilityLineView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.stock.read', { branchId: query.branchId, locationId: query.locationId ?? null });
      const scopes: ReadScope[] = (await this.authoriser.scopes(tx, actor!, 'inv.stock.read')).map((s) => ({ branchId: s.branchId, locationId: s.locationId }));
      const wanted = query.productId === undefined || query.productId.length === 0 ? null : new Set(query.productId);
      const rows = (await this.store.onHand(tx, { branchId: query.branchId, locationId: query.locationId }, scopes, false, this.clock.now())).filter((r) => wanted === null || wanted.has(r.productId));
      const locations = await this.refs.locationsIn(tx, rows.map((r) => r.locationId));
      const totals = new Map<string, { onHand: Quantity; reserved: Quantity; held: Quantity }>();
      for (const productId of wanted ?? []) totals.set(productId, { onHand: Quantity.zero(), reserved: Quantity.zero(), held: Quantity.zero() });
      for (const r of rows) {
        if (NOT_PROMISED_AT.has(locations.get(r.locationId)?.kind ?? '')) continue;
        const onHand = Quantity.parse(r.onHandQty);
        const total = totals.get(r.productId) ?? { onHand: Quantity.zero(), reserved: Quantity.zero(), held: Quantity.zero() };
        totals.set(r.productId, {
          onHand: total.onHand.plus(onHand),
          reserved: total.reserved.plus(Quantity.parse(r.reservedQty)),
          held: r.holds.length > 0 && onHand.thousandths > 0n ? total.held.plus(onHand) : total.held,
        });
      }
      const products = await this.refs.productsIn(tx, [...totals.keys()]);
      const binding = { operationId: 'listStockAvailability', principalId: actor!.principalId, filters: { ...query } };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['productId'] ?? null);
      const ordered = [...totals.keys()].filter((p) => products.has(p) && (after === null || p > after)).sort();
      const pageIds = ordered.slice(0, limit);
      const hasMore = ordered.length > limit;
      const last = pageIds.at(-1);
      return {
        data: pageIds.map((productId) => {
          const total = totals.get(productId)!;
          const { available, availability } = availabilityOf(total);
          return {
            productId,
            uom: products.get(productId)!.baseUom,
            onHandQty: total.onHand.toDecimalString(),
            reservedQty: total.reserved.toDecimalString(),
            heldQty: total.held.toDecimalString(),
            availableQty: available.toDecimalString(),
            availability,
          };
        }),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { productId: last }) : null, limit, hasMore },
      };
    });
  }

  private async unitViews(tx: Transaction, units: readonly StockUnitRow[]): Promise<StockUnitView[]> {
    const products = await this.refs.productsIn(tx, units.map((u) => u.productId));
    const locations = await this.refs.locationsIn(tx, units.flatMap((u) => (u.currentLocationId === null ? [] : [u.currentLocationId])));
    const suppliers = await this.refs.suppliersIn(tx, units.flatMap((u) => (u.supplierId === null ? [] : [u.supplierId])));
    const grades = await this.refs.gradesIn(tx, units.flatMap((u) => (u.gradeId === null ? [] : [u.gradeId])));
    const docs = await this.documents.refs(tx, units.flatMap((u) => [u.sourceDocumentId, ...(u.activeReservation === null ? [] : [u.activeReservation.holderDocumentId])]));
    return units.map((unit) => {
      const product = products.get(unit.productId)!;
      const location = unit.currentLocationId === null ? null : locations.get(unit.currentLocationId)!;
      const supplier = unit.supplierId === null ? null : suppliers.get(unit.supplierId)!;
      const grade = unit.gradeId === null ? null : grades.get(unit.gradeId)!;
      return {
        id: unit.id,
        product: productRef(product),
        tracking: unit.tracking,
        branchId: unit.branchId,
        identifier: unit.identifier,
        currentLocation: location === null ? null : { id: location.id, code: location.code, name: location.name, kind: location.kind },
        status: unit.status,
        producedOn: unit.producedOn,
        expiresOn: unit.expiresOn,
        storageTempClass: unit.storageTempClass,
        supplier: supplier === null ? null : { id: supplier.id, publicId: supplier.publicId, name: supplier.name },
        grade: grade === null ? null : { id: grade.id, code: grade.code, name: grade.name },
        lastWeightKg: unit.lastWeightKg,
        lastWeighedAt: unit.lastWeighedAt?.toISOString() ?? null,
        onHandQty: unit.onHandQty,
        uom: product.baseUom,
        uomDisplayDecimals: product.uomDisplayDecimals,
        valueAtCostPesewas: Money.ofPesewas(unit.valuePesewas).toJsonInteger(),
        currency: 'GHS',
        activeHolds: unit.activeHolds.map((h) => ({ id: h.id, kind: h.kind, startsAt: h.startsAt.toISOString(), endsAt: h.endsAt?.toISOString() ?? null })),
        activeReservation:
          unit.activeReservation === null
            ? null
            : { id: unit.activeReservation.id, holderDocument: docs.get(unit.activeReservation.holderDocumentId)!, expiresAt: unit.activeReservation.expiresAt?.toISOString() ?? null },
        sourceDocument: docs.get(unit.sourceDocumentId)!,
        createdAt: unit.createdAt.toISOString(),
      };
    });
  }

  /**
   * The trace both ways (FR-INV-006) in the contract's `StockTrace`. `costByElement` is what the origins cost: the
   * units at the far end of the backward trace (the animals), or the unit itself when it came from nowhere else, so
   * a processing output's pass-through value is not counted twice (A-137). Health events are the livestock
   * register's, which arrives in B6; until then the list is empty.
   */
  trace(actor: Actor | undefined, id: string): Promise<StockTraceView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const trace = await this.lineage.traceIn(tx, actor, id);
      const all = [trace.unit, ...trace.backward, ...trace.forward];
      const products = await this.refs.productsIn(tx, all.map((u) => u.productId));
      const docs = await this.documents.refs(tx, [...all.flatMap((u) => (u.via === null ? [] : [u.via.sourceDocumentId])), ...trace.sales.map((s) => s.sourceDocumentId)]);
      const supplierId = [trace.unit, ...trace.backward].find((u) => u.supplierId !== null)?.supplierId ?? null;
      const supplier = supplierId === null ? null : ((await this.refs.suppliersIn(tx, [supplierId])).get(supplierId) ?? null);
      const node = (u: TracedUnit): TraceNodeView => ({
        unit: { id: u.unitId, identifier: u.identifier, tracking: u.tracking },
        product: productRef(products.get(u.productId)!),
        linkType: u.via!.linkType,
        sourceDocument: docs.get(u.via!.sourceDocumentId)!,
        depth: u.depth,
      });
      const parents = new Set(trace.backward.map((u) => u.via!.unitId));
      const origins = trace.backward.length === 0 ? [trace.unit] : trace.backward.filter((u) => !parents.has(u.unitId));
      const totals = new Map<CostElement, bigint>();
      for (const origin of origins) {
        for (const [element, value] of Object.entries(origin.costByElement) as Array<[CostElement, number]>) {
          totals.set(element, (totals.get(element) ?? 0n) + BigInt(value));
        }
      }
      return {
        unit: { id: trace.unit.unitId, identifier: trace.unit.identifier, tracking: trace.unit.tracking },
        product: productRef(products.get(trace.unit.productId)!),
        ancestors: trace.backward.map(node),
        descendants: trace.forward.map(node),
        supplier: supplier === null ? null : { id: supplier.id, publicId: supplier.publicId, name: supplier.name },
        sales: trace.sales.map((s) => ({
          order: docs.get(s.sourceDocumentId)!,
          billingDocument: null,
          customer: null,
          soldAt: s.occurredAt.toISOString(),
          qty: s.qtyBase,
          weightKg: s.weightKg,
        })),
        costByElement: COST_ELEMENTS.filter((e) => totals.has(e)).map((e) => ({ costElement: e, valuePesewas: Money.ofPesewas(totals.get(e)!).toJsonInteger() })),
        healthEvents: [],
        currency: 'GHS',
      };
    });
  }

  /** Each line's value at cost and unit cost: its pool shared over the pool's physical lines by quantity. */
  private async lineValues(tx: Transaction, rows: readonly OnHandRow[]): Promise<Map<string, { readonly value: Money; readonly unitCost: Money }>> {
    const productIds = [...new Set(rows.map((r) => r.productId))];
    const pools = new Map((await this.store.pools(tx, productIds)).map((p) => [poolKey(p.productId, p.stockUnitId, p.branchId), p] as const));
    const members = new Map<string, Array<{ readonly key: string; readonly qty: Quantity }>>();
    const unitBranch = new Map(rows.flatMap((r) => (r.unit === null ? [] : [[r.stockUnitId!, r.unit.branchId] as const])));
    for (const balance of await this.store.poolBalances(tx, productIds)) {
      const branch = balance.stockUnitId === null ? balance.branchId : (unitBranch.get(balance.stockUnitId) ?? null);
      if (branch === null) continue;
      const key = poolKey(balance.productId, balance.stockUnitId, branch);
      const list = members.get(key) ?? [];
      list.push({ key: lineKey(balance), qty: Quantity.parse(balance.onHandQty) });
      members.set(key, list);
    }
    const out = new Map<string, { readonly value: Money; readonly unitCost: Money }>();
    for (const [key, lines] of members) {
      const pool = pools.get(key);
      const costPool = { qty: Quantity.parse(pool?.qty ?? '0'), value: Money.ofPesewas(pool?.valuePesewas ?? 0n) };
      const parts = valueLines(costPool, lines.map((line, index) => ({ key: BigInt(index), qty: line.qty })));
      const cost = unitCost(costPool);
      lines.forEach((line, index) => out.set(line.key, { value: parts[index]!, unitCost: cost }));
    }
    for (const row of rows) {
      if (!out.has(lineKey(row))) out.set(lineKey(row), { value: Money.zero(), unitCost: Money.zero() });
    }
    return out;
  }
}
