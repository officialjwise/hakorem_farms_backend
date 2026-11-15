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
  type LowStockTileView,
  type OwnerDashboardView,
  type PurchasesSeriesTileView,
  type StockValueTileView,
} from '../application/dashboards';
import { DashboardQuery, SeriesQuery, TileQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;

/**
 * The owner dashboard and the tiles whose data exists (FR-RPT-001, NFR-023). Parses and delegates; the handler
 * authorises. Today's sales, cash, receivables and the sales series are in the contract only until their source
 * modules exist (B8, B9a, B9b).
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
}
