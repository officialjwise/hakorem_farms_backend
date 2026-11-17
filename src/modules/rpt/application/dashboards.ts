import { Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { cashPosition } from '../../fin';
import type { Authoriser } from '../../iam';
import {
  animalsBySpecies,
  dashboardBranches,
  dashboardDate,
  monthToDate,
  PENDING_FIGURES,
  receivablesFigures,
  seriesPeriod,
  type DashboardPeriod,
  type Period,
  type PendingFigure,
  type SalesChannel,
} from '../domain/dashboard';
import { salesByChannel, topMovers } from '../domain/sales';
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

/** The contract's `SalesSeriesData`: completed orders' gross totals per business day. */
export interface SalesSeriesView {
  readonly from: string;
  readonly to: string;
  readonly points: ReadonlyArray<{ readonly date: string; readonly salesPesewas: number; readonly orderCount: number }>;
  readonly totalPesewas: number;
  readonly orderCount: number;
}

/** The contract's `ChannelSales`. */
export interface ChannelSalesView {
  readonly channel: SalesChannel;
  readonly amountPesewas: number;
  readonly count: number;
}

/** The contract's `TopMover`. */
export interface TopMoverView {
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly qty: string;
  readonly uom: string;
  readonly revenuePesewas: number;
}

/** The contract's `SalesTodayTile`. */
export interface SalesTodayTileView {
  readonly branchIds: readonly string[];
  readonly date: string;
  readonly salesPesewas: number;
  readonly orderCount: number;
  readonly currency: 'GHS';
  readonly asOf: string;
}

/** The contract's `SalesSeriesTile`. */
export interface SalesSeriesTileView {
  readonly branchIds: readonly string[];
  readonly sales: SalesSeriesView;
  readonly currency: 'GHS';
  readonly asOf: string;
}

/** The contract's `CashPosition`: each figure as a non-negative amount, the negative ones named (A-196). */
export interface CashPositionView {
  readonly tillsPesewas: number;
  readonly safePesewas: number;
  readonly driversPesewas: number;
  readonly bankPesewas: number;
  readonly mobileMoneyPesewas: number;
  readonly totalPesewas: number;
  readonly negativeFigures: readonly string[];
}

/** The contract's `ReceivablesTile`. */
export interface ReceivablesTileView {
  readonly branchIds: readonly string[];
  readonly outstandingPesewas: number;
  readonly overduePesewas: number;
  readonly currency: 'GHS';
  readonly asOf: string;
}

export interface CashPositionTileView {
  readonly branchIds: readonly string[];
  readonly cash: CashPositionView;
  readonly currency: 'GHS';
  readonly asOf: string;
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
  readonly salesTodayPesewas: number;
  readonly salesYesterdayPesewas: number;
  readonly salesMonthToDatePesewas: number;
  readonly salesByChannel: readonly ChannelSalesView[];
  readonly cash: CashPositionView;
  readonly stockValueAtCostPesewas: number;
  readonly purchasesTodayPesewas: number;
  readonly purchasesYesterdayPesewas: number;
  readonly receivablesOutstandingPesewas: number;
  readonly receivablesOverduePesewas: number;
  readonly topMovers: readonly TopMoverView[];
  readonly alerts: null;
  readonly exceptionsToday: null;
  readonly animalsOnHand: AnimalsOnHandView;
  readonly lowStockCount: number;
  readonly purchases: PurchasesSeriesView;
  readonly salesSeries: SalesSeriesView;
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

export interface DayQuery extends TileQuery {
  readonly date?: string | undefined;
}

export interface DashboardQuery extends TileQuery {
  readonly date?: string | undefined;
  readonly period?: DashboardPeriod | undefined;
}

/**
 * The owner dashboard and its tiles (FR-RPT-001, NFR-023, pulled forward by B05x): each figure read from published
 * views through the store, scoped to the branch asked for (authorised for that branch) or to every branch where the
 * reader holds the permission for the whole branch, money in integer pesewas, with the time it is true as of. A
 * figure whose source module is not built is null in the dashboard and has no tile answered from code (A-149). Sales
 * are completed orders' gross totals by the Africa/Accra business date they completed on, from ORD's published
 * `pub_completed_sale` (A-234): a VOIDED order is not a sale, and a completed return does not change them.
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

  getCashPositionTile(actor: Actor | undefined, query: TileQuery): Promise<CashPositionTileView> {
    return this.read(actor, TILE_PERMISSION, query.branchId, async (tx, branchIds) => ({ branchIds, cash: await this.cash(tx, branchIds), currency: 'GHS', asOf: this.clock.now().toISOString() }));
  }

  getAnimalsOnHandTile(actor: Actor | undefined, query: TileQuery): Promise<AnimalsOnHandTileView> {
    return this.read(actor, TILE_PERMISSION, query.branchId, async (tx, branchIds) => ({
      branchIds,
      animalsOnHand: await this.animals(tx, branchIds),
      asOf: this.clock.now().toISOString(),
    }));
  }

  /** `getReceivablesTile` (FR-RPT-001, A-149): 1200's balance and the part of it past its due date (A-200). */
  getReceivablesTile(actor: Actor | undefined, query: TileQuery): Promise<ReceivablesTileView> {
    return this.read(actor, TILE_PERMISSION, query.branchId, async (tx, branchIds) => ({ branchIds, ...(await this.receivables(tx, branchIds)), currency: 'GHS', asOf: this.clock.now().toISOString() }));
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

  /** `getSalesTodayTile` (FR-RPT-001, A-234): completed orders' gross totals on a business date, today unless asked. */
  getSalesTodayTile(actor: Actor | undefined, query: DayQuery): Promise<SalesTodayTileView> {
    return this.read(actor, TILE_PERMISSION, query.branchId, async (tx, branchIds) => {
      const day = dashboardDate(query.date, toBusinessDate(this.clock.now()));
      if (!day.ok) throw new ReportPeriodInvalidError(day.error);
      const sales = await this.sales(tx, branchIds, { from: day.value.date, to: day.value.date });
      return { branchIds, date: day.value.date, salesPesewas: sales.totalPesewas, orderCount: sales.orderCount, currency: 'GHS', asOf: this.clock.now().toISOString() };
    });
  }

  /** `getSalesSeries` (FR-RPT-001, A-234): completed orders' gross totals per business day of the period. */
  getSalesSeries(actor: Actor | undefined, query: SeriesQuery): Promise<SalesSeriesTileView> {
    return this.read(actor, TILE_PERMISSION, query.branchId, async (tx, branchIds) => {
      const period = seriesPeriod({ from: query.from, to: query.to }, toBusinessDate(this.clock.now()));
      if (!period.ok) throw new ReportPeriodInvalidError(period.error);
      return { branchIds, sales: await this.sales(tx, branchIds, period.value), currency: 'GHS', asOf: this.clock.now().toISOString() };
    });
  }

  getOwnerDashboard(actor: Actor | undefined, query: DashboardQuery): Promise<OwnerDashboardView> {
    return this.read(actor, OWNER_DASHBOARD_PERMISSION, query.branchId, async (tx, branchIds) => {
      const asOf = this.clock.now();
      const day = dashboardDate(query.date, toBusinessDate(asOf), query.period);
      if (!day.ok) throw new ReportPeriodInvalidError(day.error);
      const purchases = await this.purchases(tx, branchIds, day.value.series);
      const onDay = (date: string) => purchases.points.find((point) => point.date === date)!.valueAtCostPesewas;
      const salesSeries = await this.sales(tx, branchIds, day.value.series);
      const salesOn = (date: string) => salesSeries.points.find((point) => point.date === date)!.salesPesewas;
      return {
        date: day.value.date,
        branchId: query.branchId ?? null,
        branchIds,
        asOf: asOf.toISOString(),
        salesTodayPesewas: salesOn(day.value.date),
        salesYesterdayPesewas: salesOn(day.value.yesterday),
        salesMonthToDatePesewas: (await this.sales(tx, branchIds, monthToDate(day.value.date))).totalPesewas,
        salesByChannel: salesByChannel(await this.store.salesByChannel(tx, branchIds, day.value.date)),
        cash: await this.cash(tx, branchIds),
        stockValueAtCostPesewas: await this.stockValue(tx, branchIds),
        purchasesTodayPesewas: onDay(day.value.date),
        purchasesYesterdayPesewas: onDay(day.value.yesterday),
        ...(await this.receivables(tx, branchIds).then((r) => ({ receivablesOutstandingPesewas: r.outstandingPesewas, receivablesOverduePesewas: r.overduePesewas }))),
        topMovers: topMovers(await this.store.productSales(tx, branchIds, day.value.date)),
        alerts: null,
        exceptionsToday: null,
        animalsOnHand: await this.animals(tx, branchIds),
        lowStockCount: await this.lowStock(tx, branchIds),
        purchases,
        salesSeries,
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

  private async receivables(tx: Transaction, branchIds: readonly string[]): Promise<{ readonly outstandingPesewas: number; readonly overduePesewas: number }> {
    const figures = receivablesFigures(await this.store.receivablesBalance(tx, branchIds), await this.store.overdueOutstanding(tx, branchIds, toBusinessDate(this.clock.now())));
    return { outstandingPesewas: Money.ofPesewas(figures.outstanding).toJsonInteger(), overduePesewas: Money.ofPesewas(figures.overdue).toJsonInteger() };
  }

  private async stockValue(tx: Transaction, branchIds: readonly string[]): Promise<number> {
    return Money.ofPesewas(await this.store.stockValueAtCost(tx, branchIds)).toJsonInteger();
  }

  private async cash(tx: Transaction, branchIds: readonly string[]): Promise<CashPositionView> {
    const figures = cashPosition(await this.store.cashBalances(tx, branchIds));
    const fields = [
      ['tillsPesewas', figures.tills],
      ['safePesewas', figures.safe],
      ['driversPesewas', figures.drivers],
      ['bankPesewas', figures.bank],
      ['mobileMoneyPesewas', figures.mobileMoney],
      ['totalPesewas', figures.total],
    ] as const;
    const view = Object.fromEntries(fields.map(([name, value]) => [name, Money.ofPesewas(value < 0n ? -value : value).toJsonInteger()]));
    return { ...(view as Omit<CashPositionView, 'negativeFigures'>), negativeFigures: fields.filter(([, value]) => value < 0n).map(([name]) => name) };
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

  private async sales(tx: Transaction, branchIds: readonly string[], period: Period): Promise<SalesSeriesView> {
    const series = fillSeries(period, await this.store.salesByDay(tx, branchIds, period));
    return {
      from: period.from,
      to: period.to,
      points: series.points.map((point) => ({ date: point.date, salesPesewas: point.valuePesewas.toJsonInteger(), orderCount: point.count })),
      totalPesewas: series.total.toJsonInteger(),
      orderCount: series.count,
    };
  }
}
