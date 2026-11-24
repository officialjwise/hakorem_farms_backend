import { Money, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { FinancialStatements } from '../../fin';
import type { Authoriser, PrincipalNames } from '../../iam';
import type { StockUnits } from '../../inv';
import type { Batches } from '../../liv';
import type { MasterDataRefs } from '../../mdm';
import { assignFixedCosts, breakEvenLine, contributionShares } from '../domain/break-even';
import { COST_ELEMENTS, elementsOf, type CostElement, type ElementAmounts } from '../domain/cost-object';
import { lossRows, type LossFactInput } from '../domain/losses';
import { marginFigures, marginRow, type MarginRowFigures } from '../domain/margin';
import { pageAt, probe } from './counting';
import type { CostingStore, MarginGroupBy, MarginRange, MarginSums } from './costing-store';
import { CostingPeriodInvalidError, type CstRule } from './errors';
import type { Page } from './overhead-allocations';

export const COST_READ = 'cst.cost.read';
export const MARGIN_READ = 'cst.margin.read';

export type CostObjectType = 'STOCK_UNIT' | 'PEN' | 'BATCH' | 'PROCESSING_ORDER';
export type LossGroupBy = 'CAUSE' | 'LOCATION' | 'HANDLER' | 'PRODUCT';

export interface CostObjectView {
  readonly objectType: CostObjectType;
  readonly objectId: string;
  readonly label: string;
  readonly branchId: string;
  readonly byElement: { readonly costElement: CostElement; readonly valuePesewas: number }[];
  readonly totalPesewas: number;
  readonly currency: 'GHS';
  readonly refreshedAt: string;
}

export interface MarginRowView extends MarginRowFigures {
  readonly group: { readonly id: string | null; readonly label: string };
  readonly qty: string | null;
  readonly weightKg: string | null;
}

export interface MarginReportView extends Page<MarginRowView> {
  readonly totals: MarginRowFigures;
  readonly currency: 'GHS';
  readonly asOf: string;
}

export interface BreakEvenLineView {
  readonly productLine: string;
  readonly revenuePesewas: number;
  readonly revenueIsNegative: boolean;
  readonly variableCostPesewas: number;
  readonly variableCostIsNegative: boolean;
  readonly contributionPesewas: number;
  readonly contributionIsNegative: boolean;
  readonly contributionMarginPercent: string | null;
  readonly fixedCostPesewas: number;
  readonly breakEvenRevenuePesewas: number | null;
  readonly coveredPercent: string | null;
  readonly unitsSold: string;
  readonly averageNetPricePesewas: number | null;
  readonly variableCostPerUnitPesewas: number | null;
  readonly contributionPerUnitPesewas: number | null;
  readonly contributionPerUnitIsNegative: boolean;
  readonly breakEvenUnits: number | null;
  readonly contributionSharePercent: string | null;
}

export interface BreakEvenView {
  readonly from: string;
  readonly to: string;
  readonly lines: BreakEvenLineView[];
  readonly fixedCostPesewas: number;
  readonly currency: 'GHS';
  readonly explanation: string;
}

export interface LossRowView {
  readonly group: { readonly id: string | null; readonly label: string };
  readonly lossGroup: 'MORTALITY' | 'SHRINKAGE' | 'WASTAGE';
  readonly events: number;
  readonly qty: string | null;
  readonly valuePesewas: number;
  readonly ratePercent: string | null;
  readonly comparisonRatePercent: string | null;
}

export interface LossReportView extends Page<LossRowView> {
  readonly totalPesewas: number;
  readonly currency: 'GHS';
}

const CAUSE_LABELS: Readonly<Record<'MORTALITY' | 'SHRINKAGE' | 'WASTAGE', string>> = { MORTALITY: 'Mortality', SHRINKAGE: 'Shrinkage', WASTAGE: 'Wastage and expiry' };
const CHANNEL_LABELS: Readonly<Record<string, string>> = { POS: 'Retail counter', ONLINE: 'Online store', WHOLESALE: 'Wholesale', QUOTE: 'Request for quote', NONE: 'No order' };
const LINE_LABELS: Readonly<Record<string, string>> = {
  LIVE: 'Live animals',
  MEAT: 'Meat',
  PRODUCE: 'Produce and eggs',
  BY_PRODUCT: 'By-products',
  FEED: 'Feed',
  SUPPLY: 'Supplies',
  SERVICE: 'Services',
};
const EXPLANATION =
  "Each line keeps its sales after paying for the stock it sold; that contribution must cover the line's share of fixed costs. Break-even is the number sold, rounded up, at which it does, and the sales that number brings at the line's average price.";
const NONE: ElementAmounts = { PURCHASE: 0n, FEED: 0n, VETERINARY: 0n, LABOUR: 0n, OVERHEAD: 0n, PROCESSING: 0n };

const json = (n: bigint): number => Money.ofPesewas(n < 0n ? -n : n).toJsonInteger();
const sumElements = (rows: readonly ElementAmounts[]): ElementAmounts => {
  const out: Record<CostElement, bigint> = { ...NONE };
  for (const row of rows) for (const e of COST_ELEMENTS) out[e] += row[e];
  return out;
};
const figuresOf = (s: MarginSums) =>
  marginFigures([
    { kind: 'REVENUE', isCredit: false, revenue: s.revenueSales, cost: 0n, variance: s.variance },
    { kind: 'REVENUE', isCredit: true, revenue: s.revenueCredits, cost: 0n, variance: 0n },
    { kind: 'COST', isCredit: false, revenue: 0n, cost: s.costSales, variance: 0n },
    { kind: 'COST', isCredit: true, revenue: 0n, cost: s.costCredits, variance: 0n },
  ]);

/**
 * CST's reads (FR-CST-001, FR-CST-003, FR-CST-005 to FR-CST-007): a cost object by element, margins by dimension with
 * totals over the whole filter, break-even and contribution by product line, and losses as their own figure. Each
 * authorises in the handler (ADR-0035) for the branch asked for, or reads every branch the caller holds the permission
 * for in full; a cost object of another branch answers as one that does not exist. Every figure is an exact integer
 * sum of the projections; margin is over the selling price (the owner, 2026-11-23).
 */
export class CostingReports {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: CostingStore,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly batches: Batches,
    private readonly statements: FinancialStatements,
    private readonly authoriser: Authoriser,
    private readonly names: PrincipalNames,
    private readonly registry: DocumentRegistry,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  /** getCostObject (FR-CST-001): accumulated cost by element; a pen is the animals in it now, a batch its flock. */
  getCostObject(actor: Actor | undefined, objectType: CostObjectType, objectId: string): Promise<CostObjectView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, COST_READ);
      const branches = await this.branchesOf(tx, actor!, COST_READ);
      const found = await this.costObjectIn(tx, objectType, objectId);
      if (found === null || !branches.includes(found.branchId)) throw new NotFoundError(`no ${objectType} ${objectId}`);
      const { byElement, total } = elementsOf(found.elements);
      return {
        objectType,
        objectId,
        label: found.label,
        branchId: found.branchId,
        byElement: byElement.map((e) => ({ costElement: e.costElement, valuePesewas: json(e.valuePesewas) })),
        totalPesewas: json(total),
        currency: 'GHS',
        refreshedAt: found.refreshedAt.toISOString(),
      };
    });
  }

  private async costObjectIn(tx: Transaction, objectType: CostObjectType, objectId: string): Promise<{ readonly label: string; readonly branchId: string; readonly elements: ElementAmounts; readonly refreshedAt: Date } | null> {
    const now = this.clock.now();
    if (objectType === 'PEN') {
      const pen = (await this.refs.locationsIn(tx, [objectId])).get(objectId);
      if (pen === undefined || pen.isVirtual) return null;
      const rows = await this.store.summaries(tx, 'STOCK_UNIT', await this.store.unitsOnHandAt(tx, pen.id));
      const refreshedAt = rows.reduce((latest, r) => (r.refreshedAt > latest ? r.refreshedAt : latest), new Date(0));
      return { label: pen.name, branchId: pen.branchId, elements: sumElements(rows.map((r) => r.elements)), refreshedAt: rows.length === 0 ? now : refreshedAt };
    }
    if (objectType === 'PROCESSING_ORDER') {
      const [row] = await this.store.summaries(tx, 'PROCESSING_ORDER', [objectId]);
      if (row === undefined) return null;
      const ref = (await this.registry.refs(tx, [objectId])).get(objectId);
      return { label: `Processing order ${ref?.number ?? objectId.slice(-6)}`, branchId: row.branchId, elements: row.elements, refreshedAt: row.refreshedAt };
    }
    let unitId = objectId;
    let label: string | null = null;
    if (objectType === 'BATCH') {
      const batch = (await this.batches.stockUnitsOfIn(tx, [objectId])).get(objectId);
      if (batch === undefined || batch.stockUnitId === null) return null;
      unitId = batch.stockUnitId;
      label = `Batch ${batch.batchNo}`;
    }
    const unit = (await this.units.factsIn(tx, [unitId], now)).get(unitId);
    if (unit === undefined) return null;
    const [row] = await this.store.summaries(tx, 'STOCK_UNIT', [unitId]);
    const product = (await this.refs.productsIn(tx, [unit.productId])).get(unit.productId);
    return { label: label ?? `${product?.name ?? 'Stock unit'} ${unit.identifier}`, branchId: row?.branchId ?? unit.branchId, elements: row?.elements ?? NONE, refreshedAt: row?.refreshedAt ?? now };
  }

  /** listMargins (FR-CST-003): margin by dimension for a date range, every group and the totals over the whole filter. */
  listMargins(actor: Actor | undefined, query: { readonly groupBy: MarginGroupBy; readonly from: string; readonly to: string; readonly branchId?: string | undefined; readonly cursor?: string | undefined; readonly limit: number }): Promise<MarginReportView> {
    return this.read(actor, MARGIN_READ, query, async (tx, range) => {
      const binding = { operationId: 'listMargins', principalId: actor!.principalId, filters: { groupBy: query.groupBy, from: query.from, to: query.to, branchId: query.branchId ?? null } };
      const after = query.cursor === undefined ? null : ((this.cursors.decode(query.cursor, binding)['key'] as string | undefined) ?? null);
      const rows = await this.store.marginGroups(tx, range, query.groupBy, after, probe(query.limit));
      const page = rows.slice(0, query.limit);
      const labels = await this.labelsIn(tx, query.groupBy, page.map((r) => r.key));
      const hasMore = rows.length > query.limit;
      return {
        data: page.map((r) => ({
          group: { id: ['PRODUCT_LINE', 'CHANNEL'].includes(query.groupBy) ? null : r.key, label: labels.get(r.key ?? '') ?? 'Unknown' },
          qty: query.groupBy === 'PRODUCT' ? r.qty : null,
          weightKg: query.groupBy === 'PRODUCT' ? r.weightKg : null,
          ...marginRow(figuresOf(r)),
        })),
        page: { nextCursor: hasMore ? this.cursors.encode(binding, { key: page.at(-1)!.key ?? '' }) : null, limit: query.limit, hasMore },
        totals: marginRow(figuresOf(await this.store.marginTotals(tx, range))),
        currency: 'GHS',
        asOf: this.clock.now().toISOString(),
      };
    });
  }

  /** getBreakEven (FR-CST-005, FR-CST-006): each product line's contribution, its share of fixed costs and break-even. */
  getBreakEven(actor: Actor | undefined, query: { readonly from: string; readonly to: string; readonly branchId?: string | undefined }): Promise<BreakEvenView> {
    return this.read(actor, MARGIN_READ, query, async (tx, range) => {
      const sums = await this.store.lineSums(tx, range);
      let fixed = 0n;
      for (const branchId of range.branchIds ?? []) {
        const traded = await this.statements.tradedNetDebitsIn(tx, { from: range.from, to: range.to, branchId });
        for (const account of traded.values()) if (account.type === 'EXPENSE' && account.cashFlowCategory === 'OPERATING') fixed += account.netDebit;
      }
      const lines = sums.map((s) => ({ key: s.key ?? 'NONE', figures: figuresOf(s), units: Quantity.parse(s.qty).thousandths }));
      const assigned = assignFixedCosts(fixed > 0n ? fixed : 0n, lines.map((l) => ({ key: l.key, revenue: l.figures.revenue })));
      const contributions = lines.map((l) => l.figures.revenue - l.figures.cost);
      const shares = contributionShares(contributions);
      return {
        from: query.from,
        to: query.to,
        lines: lines.map((l, i) => {
          const be = breakEvenLine({ revenue: l.figures.revenue, variableCost: l.figures.cost, unitsThousandths: l.units, fixedCost: assigned[i]!.fixedCost });
          const nullable = (n: bigint | null) => (n === null ? null : json(n));
          return {
            productLine: l.key,
            revenuePesewas: json(l.figures.revenue),
            revenueIsNegative: l.figures.revenue < 0n,
            variableCostPesewas: json(l.figures.cost),
            variableCostIsNegative: l.figures.cost < 0n,
            contributionPesewas: json(be.contribution),
            contributionIsNegative: be.contribution < 0n,
            contributionMarginPercent: be.contributionMarginPercent,
            fixedCostPesewas: json(assigned[i]!.fixedCost),
            breakEvenRevenuePesewas: nullable(be.breakEvenRevenue),
            coveredPercent: be.coveredPercent,
            unitsSold: Quantity.ofThousandths(l.units).toDecimalString(),
            averageNetPricePesewas: nullable(be.averagePrice),
            variableCostPerUnitPesewas: nullable(be.variableCostPerUnit),
            contributionPerUnitPesewas: nullable(be.contributionPerUnit),
            contributionPerUnitIsNegative: (be.contributionPerUnit ?? 0n) < 0n,
            breakEvenUnits: be.breakEvenUnits === null ? null : Number(be.breakEvenUnits),
            contributionSharePercent: shares[i]!,
          };
        }),
        fixedCostPesewas: json(fixed > 0n ? fixed : 0n),
        currency: 'GHS',
        explanation: EXPLANATION,
      };
    });
  }

  /** listLosses (FR-CST-007): mortality, shrinkage and wastage by cause, location, handler or product, apart from cost of sales. */
  listLosses(actor: Actor | undefined, query: { readonly groupBy: LossGroupBy; readonly from: string; readonly to: string; readonly cursor?: string | undefined; readonly limit: number }): Promise<LossReportView> {
    return this.read(actor, MARGIN_READ, query, async (tx, range) => {
      const facts = await this.store.lossFacts(tx, range);
      const ids = (pick: (f: (typeof facts)[number]) => string | null) => [...new Set(facts.flatMap((f) => (pick(f) === null ? [] : [pick(f)!])))];
      const products = query.groupBy === 'PRODUCT' ? await this.refs.productsIn(tx, ids((f) => f.productId)) : new Map();
      const locations = query.groupBy === 'LOCATION' ? await this.refs.locationsIn(tx, ids((f) => f.locationId)) : new Map();
      const people = query.groupBy === 'HANDLER' ? await this.names.refs(tx, ids((f) => f.handlerRef)) : new Map();
      const inputs: LossFactInput[] = facts.map((f) => {
        const group =
          query.groupBy === 'CAUSE'
            ? { groupId: null, label: CAUSE_LABELS[f.lossGroup] }
            : query.groupBy === 'PRODUCT'
              ? { groupId: f.productId, label: products.get(f.productId)?.name ?? 'Unknown' }
              : query.groupBy === 'LOCATION'
                ? { groupId: f.locationId, label: locations.get(f.locationId)?.name ?? 'Unknown' }
                : { groupId: f.handlerRef, label: f.handlerRef === null ? 'Unknown' : (people.get(f.handlerRef)?.displayName ?? 'Unknown') };
        return { ...group, lossGroup: f.lossGroup, isReversal: f.isReversal, qty: f.qty, value: f.valuePesewas };
      });
      const rows = lossRows(inputs);
      const binding = { operationId: 'listLosses', principalId: actor!.principalId, filters: { groupBy: query.groupBy, from: query.from, to: query.to } };
      const offset = query.cursor === undefined ? 0 : Number(this.cursors.decode(query.cursor, binding)['offset'] ?? '0');
      const { rows: page, hasMore, next } = pageAt(rows, offset, query.limit);
      return {
        data: page.map((r) => ({
          group: { id: r.groupId, label: r.label },
          lossGroup: r.lossGroup,
          events: r.events,
          qty: query.groupBy === 'CAUSE' ? null : r.qty,
          valuePesewas: json(r.value),
          ratePercent: null,
          comparisonRatePercent: null,
        })),
        page: { nextCursor: hasMore ? this.cursors.encode(binding, { offset: String(next) }) : null, limit: query.limit, hasMore },
        totalPesewas: json(rows.reduce((sum, r) => sum + r.value, 0n)),
        currency: 'GHS',
      };
    });
  }

  private async labelsIn(tx: Transaction, groupBy: MarginGroupBy, keys: readonly (string | null)[]): Promise<ReadonlyMap<string, string>> {
    const ids = keys.filter((k): k is string => k !== null);
    const entries: [string, string][] = [];
    if (groupBy === 'PRODUCT') for (const [id, p] of await this.refs.productsIn(tx, ids)) entries.push([id, p.name]);
    if (groupBy === 'BRANCH') for (const [id, b] of await this.refs.branchesIn(tx, ids)) entries.push([id, b.name]);
    if (groupBy === 'CUSTOMER') for (const [id, c] of await this.refs.customersIn(tx, ids)) entries.push([id, c.name]);
    if (groupBy === 'SALESPERSON') for (const [id, p] of await this.names.refs(tx, ids)) entries.push([id, p.displayName]);
    if (groupBy === 'PRODUCT_LINE') for (const k of ids) entries.push([k, LINE_LABELS[k] ?? k]);
    if (groupBy === 'CHANNEL') for (const k of ids) entries.push([k, CHANNEL_LABELS[k] ?? k]);
    // A sale with no customer or no salesperson named, or a charge with no product.
    entries.push(['', groupBy === 'CUSTOMER' ? 'Walk-in customer' : groupBy === 'SALESPERSON' ? 'No salesperson' : groupBy === 'PRODUCT' ? 'Charges and adjustments' : 'Unknown']);
    return new Map(entries);
  }

  /** Authorises in the handler (ADR-0035) for the branch asked for, or anywhere, then narrows to the whole-branch grants. */
  private read<V>(
    actor: Actor | undefined,
    permission: string,
    query: { readonly from: string; readonly to: string; readonly branchId?: string | undefined },
    work: (tx: Transaction, range: MarginRange) => Promise<V>,
  ): Promise<V> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission, query.branchId === undefined ? {} : { branchId: query.branchId });
      const broken: CstRule[] = [];
      if (query.from > query.to) broken.push({ field: '/from', rule: 'FROM_AFTER_TO' });
      if (query.to > toBusinessDate(this.clock.now())) broken.push({ field: '/to', rule: 'AFTER_TODAY' });
      if (broken.length > 0) throw new CostingPeriodInvalidError(broken);
      const branchIds = query.branchId === undefined ? await this.branchesOf(tx, actor!, permission) : [query.branchId];
      return work(tx, { from: query.from, to: query.to, branchIds });
    });
  }

  private async branchesOf(tx: Transaction, actor: Actor, permission: string): Promise<string[]> {
    return [...new Set((await this.authoriser.scopes(tx, actor, permission)).filter((g) => g.locationId === null).map((g) => g.branchId))].sort();
  }
}
