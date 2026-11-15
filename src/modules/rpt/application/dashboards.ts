import { Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Authoriser } from '../../iam';
import { animalsBySpecies, dashboardBranches, dashboardDate, PENDING_FIGURES, seriesPeriod, type DashboardPeriod, type Period, type PendingFigure } from '../domain/dashboard';
import { fillSeries } from '../domain/series';
import type { DashboardStore } from './dashboard-store';
import { ReportPeriodInvalidError } from './errors';

export const TILE_PERMISSION = 'rpt.tile.read';
export const OWNER_DASHBOARD_PERMISSION = 'rpt.dashboard.owner';

/** The contract's `AnimalsOnHand`. */
export interface AnimalsOnHandView {
  readonly total: number;
  readonly bySpecies: ReadonlyArray<{ readonly species: { readonly id: string; readonly code: string; readonly name: string } | null; readonly count: number }>;
}

/** The contract's `PurchasesSeriesData`. */
export interface PurchasesSeriesView {
  readonly from: string;
  readonly to: string;
  readonly points: ReadonlyArray<{ readonly date: string; readonly valueAtCostPesewas: number; readonly receiptCount: number }>;
  readonly totalPesewas: number;
  readonly receiptCount: number;
}

export interface StockValueTileView {
  readonly branchIds: readonly string[];
  readonly stockValueAtCostPesewas: number;
  readonly currency: 'GHS';
  readonly asOf: string;
}

export interface AnimalsOnHandTileView {
  readonly branchIds: readonly string[];
  readonly animalsOnHand: AnimalsOnHandView;
  readonly asOf: string;
}

export interface LowStockTileView {
  readonly branchIds: readonly string[];
  readonly lowStockCount: number;
  readonly asOf: string;
}

export interface PurchasesSeriesTileView {
  readonly branchIds: readonly string[];
  readonly purchases: PurchasesSeriesView;
  readonly currency: 'GHS';
  readonly asOf: string;
}

/**
 * The contract's `OwnerDashboard`. Each figure listed in `pendingFigures` is null; the types say so, so a figure
 * cannot be answered with a zero before its source exists.
 */
export interface OwnerDashboardView {
  readonly date: string;
  readonly branchId: string | null;
  readonly branchIds: readonly string[];
  readonly asOf: string;
  readonly salesTodayPesewas: null;
  readonly salesYesterdayPesewas: null;
  readonly salesMonthToDatePesewas: null;
  readonly salesByChannel: null;
  readonly cash: null;
  readonly stockValueAtCostPesewas: number;
  readonly purchasesTodayPesewas: number;
  readonly purchasesYesterdayPesewas: number;
  readonly receivablesOutstandingPesewas: null;
  readonly receivablesOverduePesewas: null;
  readonly topMovers: null;
  readonly alerts: null;
  readonly exceptionsToday: null;
  readonly animalsOnHand: AnimalsOnHandView;
  readonly lowStockCount: number;
  readonly purchases: PurchasesSeriesView;
  readonly salesSeries: null;
  readonly pendingFigures: readonly PendingFigure[];
  readonly currency: 'GHS';
}

export interface TileQuery {
  readonly branchId?: string | undefined;
}

export interface SeriesQuery extends TileQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface DashboardQuery extends TileQuery {
  readonly date?: string | undefined;
  readonly period?: DashboardPeriod | undefined;
}

/**
 * The owner dashboard and its tiles (FR-RPT-001, NFR-023, pulled forward by B05x): each figure read from published
 * views through the store, scoped to the branch asked for (authorised for that branch) or to every branch where the
 * reader holds the permission for the whole branch, money in integer pesewas, with the time it is true as of. A
 * figure whose source module is not built is null in the dashboard and has no tile answered from code (A-149).
 */
export class Dashboards {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: DashboardStore,
    private readonly authoriser: Authoriser,
    private readonly clock: Clock,
  ) {}

  getStockValueTile(actor: Actor | undefined, query: TileQuery): Promise<StockValueTileView> {
    return this.read(actor, TILE_PERMISSION, query.branchId, async (tx, branchIds) => ({
      branchIds,
      stockValueAtCostPesewas: await this.stockValue(tx, branchIds),
      currency: 'GHS',
      asOf: this.clock.now().toISOString(),
    }));
  }

  getAnimalsOnHandTile(actor: Actor | undefined, query: TileQuery): Promise<AnimalsOnHandTileView> {
    return this.read(actor, TILE_PERMISSION, query.branchId, async (tx, branchIds) => ({
      branchIds,
      animalsOnHand: await this.animals(tx, branchIds),
      asOf: this.clock.now().toISOString(),
    }));
  }

  getLowStockTile(actor: Actor | undefined, query: TileQuery): Promise<LowStockTileView> {
    return this.read(actor, TILE_PERMISSION, query.branchId, async (tx, branchIds) => ({
      branchIds,
      lowStockCount: await this.lowStock(tx, branchIds),
      asOf: this.clock.now().toISOString(),
    }));
  }

  getPurchasesSeries(actor: Actor | undefined, query: SeriesQuery): Promise<PurchasesSeriesTileView> {
    return this.read(actor, TILE_PERMISSION, query.branchId, async (tx, branchIds) => {
      const period = seriesPeriod({ from: query.from, to: query.to }, toBusinessDate(this.clock.now()));
      if (!period.ok) throw new ReportPeriodInvalidError(period.error);
      return { branchIds, purchases: await this.purchases(tx, branchIds, period.value), currency: 'GHS', asOf: this.clock.now().toISOString() };
    });
  }

  getOwnerDashboard(actor: Actor | undefined, query: DashboardQuery): Promise<OwnerDashboardView> {
    return this.read(actor, OWNER_DASHBOARD_PERMISSION, query.branchId, async (tx, branchIds) => {
      const asOf = this.clock.now();
      const day = dashboardDate(query.date, toBusinessDate(asOf), query.period);
      if (!day.ok) throw new ReportPeriodInvalidError(day.error);
      const purchases = await this.purchases(tx, branchIds, day.value.series);
      const onDay = (date: string) => purchases.points.find((point) => point.date === date)!.valueAtCostPesewas;
      return {
        date: day.value.date,
        branchId: query.branchId ?? null,
        branchIds,
        asOf: asOf.toISOString(),
        salesTodayPesewas: null,
        salesYesterdayPesewas: null,
        salesMonthToDatePesewas: null,
        salesByChannel: null,
        cash: null,
        stockValueAtCostPesewas: await this.stockValue(tx, branchIds),
        purchasesTodayPesewas: onDay(day.value.date),
        purchasesYesterdayPesewas: onDay(day.value.yesterday),
        receivablesOutstandingPesewas: null,
        receivablesOverduePesewas: null,
        topMovers: null,
        alerts: null,
        exceptionsToday: null,
        animalsOnHand: await this.animals(tx, branchIds),
        lowStockCount: await this.lowStock(tx, branchIds),
        purchases,
        salesSeries: null,
        pendingFigures: PENDING_FIGURES,
        currency: 'GHS',
      };
    });
  }

  /** Authorises in the handler (ADR-0035): for the branch asked for, or anywhere, then narrows to the grants. */
  private read<V>(actor: Actor | undefined, permission: string, branchId: string | undefined, work: (tx: Transaction, branchIds: string[]) => Promise<V>): Promise<V> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission, branchId === undefined ? {} : { branchId });
      const branchIds = dashboardBranches(branchId, branchId === undefined ? await this.authoriser.scopes(tx, actor!, permission) : []);
      return work(tx, branchIds);
    });
  }

  private async stockValue(tx: Transaction, branchIds: readonly string[]): Promise<number> {
    return Money.ofPesewas(await this.store.stockValueAtCost(tx, branchIds)).toJsonInteger();
  }

  private async animals(tx: Transaction, branchIds: readonly string[]): Promise<AnimalsOnHandView> {
    const counted = animalsBySpecies(await this.store.animalsOnHand(tx, branchIds));
    return {
      total: counted.total,
      bySpecies: counted.bySpecies.map((row) => ({ species: row.speciesId === null ? null : { id: row.speciesId, code: row.code!, name: row.name! }, count: row.count })),
    };
  }

  private lowStock(tx: Transaction, branchIds: readonly string[]): Promise<number> {
    return this.store.lowStockProducts(tx, branchIds);
  }

  private async purchases(tx: Transaction, branchIds: readonly string[], period: Period): Promise<PurchasesSeriesView> {
    const series = fillSeries(period, await this.store.purchasesByDay(tx, branchIds, period));
    return {
      from: period.from,
      to: period.to,
      points: series.points.map((point) => ({ date: point.date, valueAtCostPesewas: point.valuePesewas.toJsonInteger(), receiptCount: point.count })),
      totalPesewas: series.total.toJsonInteger(),
      receiptCount: series.count,
    };
  }
}
