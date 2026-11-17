import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import {
  Dashboards,
  OWNER_DASHBOARD_PERMISSION,
  TILE_PERMISSION,
  type AnimalsOnHandTileView,
  type CashPositionTileView,
  type ReceivablesTileView,
  type LowStockTileView,
  type OwnerDashboardView,
  type PurchasesSeriesTileView,
  type SalesSeriesTileView,
  type SalesTodayTileView,
  type StockValueTileView,
} from '../application/dashboards';
import { DashboardQuery, DayQuery, SeriesQuery, TileQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;

/**
 * The owner dashboard and the tiles whose data exists (FR-RPT-001, NFR-023). Parses and delegates; the handler
 * authorises. The cash position answers from the ledger since B08 continued 1c, receivables since B08 continued 2, and
 * today's sales and the sales series from completed orders since B09a continued 2g.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(@Inject(Dashboards) private readonly dashboards: Dashboards) {}

  @Get('owner')
  @Operation({ operationId: 'getOwnerDashboard', ...READ, permission: OWNER_DASHBOARD_PERMISSION })
  owner(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(DashboardQuery)) query: z.infer<typeof DashboardQuery>): Promise<OwnerDashboardView> {
    return this.dashboards.getOwnerDashboard(actor, query);
  }

  @Get('tiles/stock-value')
  @Operation({ operationId: 'getStockValueTile', ...READ, permission: TILE_PERMISSION })
  stockValue(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(TileQuery)) query: z.infer<typeof TileQuery>): Promise<StockValueTileView> {
    return this.dashboards.getStockValueTile(actor, query);
  }

  @Get('tiles/cash-position')
  @Operation({ operationId: 'getCashPositionTile', ...READ, permission: TILE_PERMISSION })
  cashPosition(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(TileQuery)) query: z.infer<typeof TileQuery>): Promise<CashPositionTileView> {
    return this.dashboards.getCashPositionTile(actor, query);
  }

  @Get('tiles/receivables')
  @Operation({ operationId: 'getReceivablesTile', ...READ, permission: TILE_PERMISSION })
  receivables(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(TileQuery)) query: z.infer<typeof TileQuery>): Promise<ReceivablesTileView> {
    return this.dashboards.getReceivablesTile(actor, query);
  }

  @Get('tiles/animals-on-hand')
  @Operation({ operationId: 'getAnimalsOnHandTile', ...READ, permission: TILE_PERMISSION })
  animals(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(TileQuery)) query: z.infer<typeof TileQuery>): Promise<AnimalsOnHandTileView> {
    return this.dashboards.getAnimalsOnHandTile(actor, query);
  }

  @Get('tiles/low-stock')
  @Operation({ operationId: 'getLowStockTile', ...READ, permission: TILE_PERMISSION })
  lowStock(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(TileQuery)) query: z.infer<typeof TileQuery>): Promise<LowStockTileView> {
    return this.dashboards.getLowStockTile(actor, query);
  }

  @Get('tiles/purchases')
  @Operation({ operationId: 'getPurchasesSeries', ...READ, permission: TILE_PERMISSION })
  purchases(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(SeriesQuery)) query: z.infer<typeof SeriesQuery>): Promise<PurchasesSeriesTileView> {
    return this.dashboards.getPurchasesSeries(actor, query);
  }

  @Get('tiles/sales-today')
  @Operation({ operationId: 'getSalesTodayTile', ...READ, permission: TILE_PERMISSION })
  salesToday(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(DayQuery)) query: z.infer<typeof DayQuery>): Promise<SalesTodayTileView> {
    return this.dashboards.getSalesTodayTile(actor, query);
  }

  @Get('tiles/sales')
  @Operation({ operationId: 'getSalesSeries', ...READ, permission: TILE_PERMISSION })
  sales(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(SeriesQuery)) query: z.infer<typeof SeriesQuery>): Promise<SalesSeriesTileView> {
    return this.dashboards.getSalesSeries(actor, query);
  }
}
