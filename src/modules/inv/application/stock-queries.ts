import { Money, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRefRecord, DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs, ProductFacts } from '../../mdm';
import { unitCost, valueLines } from '../domain/valuation/pool-lines';
import { addDays, daysBetween } from './counting';
import type { ReadScope } from './goods-receipt-store';
import type { Lineage, TracedUnit } from './lineage';
import type { CostElement, LinkType } from './stock-store';
import type { HoldKind, OnHandFilters, OnHandRow, StockReadStore } from './stock-read-store';

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
  readonly supplier: { readonly id: string; readonly supplierNo: string; readonly name: string } | null;
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
  readonly supplier: { readonly id: string; readonly supplierNo: string; readonly name: string } | null;
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

  listOnHand(actor: Actor | undefined, query: OnHandQuery, cursor: string | undefined, limit: number): Promise<StockOnHandPageView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.stock.read', query.branchId === undefined ? {} : { branchId: query.branchId, locationId: query.locationId ?? null });
      const scopes: ReadScope[] = (await this.authoriser.scopes(tx, actor!, 'inv.stock.read')).map((s) => ({ branchId: s.branchId, locationId: s.locationId }));
      const now = this.clock.now();
      const today = toBusinessDate(now);
      let rows = await this.store.onHand(tx, query, scopes, query.includeZero ?? false);
      const products = await this.refs.productsIn(tx, rows.map((r) => r.productId));
      if (query.categoryId !== undefined) {
        rows = rows.filter((r) => products.get(r.productId)?.categoryId === query.categoryId);
      }
      if (query.expiringWithinDays !== undefined) {
        const limitDate = addDays(today, query.expiringWithinDays);
        rows = rows.filter((r) => r.unit?.expiresOn !== null && r.unit?.expiresOn !== undefined && r.unit.expiresOn <= limitDate);
      }
      const values = await this.lineValues(tx, rows);
      const binding = { operationId: 'listStockOnHand', principalId: actor!.principalId, filters: { ...query } };
      const after = cursor === undefined ? null : ((this.cursors.decode(cursor, binding)['key'] as string | undefined) ?? null);
      const remaining = after === null ? rows : rows.filter((r) => lineKey(r) > after);
      const pageRows = remaining.slice(0, limit);
      const hasMore = remaining.length > limit;
      const locations = await this.refs.locationsIn(tx, pageRows.map((r) => r.locationId));
      const last = pageRows.at(-1);
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
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { key: lineKey(last) }) : null, limit, hasMore },
        totalValueAtCostPesewas: Money.sum(rows.map((r) => values.get(lineKey(r))!.value)).toJsonInteger(),
        currency: 'GHS',
        asOf: now.toISOString(),
      };
    });
  }

  getStockUnit(actor: Actor | undefined, id: string): Promise<StockUnitView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const unit = await this.store.stockUnit(tx, id);
      await this.authoriser.authorise(tx, actor, 'inv.stock.read', unit === null ? {} : { branchId: unit.branchId, locationId: unit.currentLocationId });
      if (unit === null) throw new NotFoundError(`no stock unit ${id}`);
      const product = (await this.refs.productsIn(tx, [unit.productId])).get(unit.productId)!;
      const location = unit.currentLocationId === null ? null : (await this.refs.locationsIn(tx, [unit.currentLocationId])).get(unit.currentLocationId)!;
      const supplier = unit.supplierId === null ? null : (await this.refs.suppliersIn(tx, [unit.supplierId])).get(unit.supplierId)!;
      const grade = unit.gradeId === null ? null : (await this.refs.gradesIn(tx, [unit.gradeId])).get(unit.gradeId)!;
      const docs = await this.documents.refs(tx, [unit.sourceDocumentId, ...(unit.activeReservation === null ? [] : [unit.activeReservation.holderDocumentId])]);
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
        supplier: supplier === null ? null : { id: supplier.id, supplierNo: supplier.supplierNo, name: supplier.name },
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
        supplier: supplier === null ? null : { id: supplier.id, supplierNo: supplier.supplierNo, name: supplier.name },
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
