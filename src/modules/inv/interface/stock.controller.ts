import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { StockQueries, type AvailabilityLineView, type StockOnHandPageView, type StockTraceView, type StockUnitLabelView, type StockUnitView } from '../application/stock-queries';
import type { Page } from '../application/stock-command';
import { IdParam, ListStockAvailabilityQuery, ListStockOnHandQuery, ListStockUnitsQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;

/** Stock on hand, availability, stock units and the trace (FR-INV-003, FR-INV-005, FR-INV-006, FR-INV-021). The controller parses and delegates. */
@Controller()
export class StockController {
  constructor(@Inject(StockQueries) private readonly queries: StockQueries) {}

  @Get('stock/on-hand')
  @Operation({ operationId: 'listStockOnHand', ...READ, permission: 'inv.stock.read' })
  listOnHand(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListStockOnHandQuery)) query: z.infer<typeof ListStockOnHandQuery>): Promise<StockOnHandPageView> {
    const { cursor, limit, ...filters } = query;
    return this.queries.listOnHand(actor, filters, cursor, limit);
  }

  @Get('stock/availability')
  @Operation({ operationId: 'listStockAvailability', ...READ, permission: 'inv.stock.read' })
  listAvailability(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListStockAvailabilityQuery)) query: z.infer<typeof ListStockAvailabilityQuery>): Promise<Page<AvailabilityLineView>> {
    const { cursor, limit, ...filters } = query;
    return this.queries.listAvailability(actor, filters, cursor, limit);
  }

  @Get('stock-units')
  @Operation({ operationId: 'listStockUnits', ...READ, permission: 'inv.stock.read' })
  listStockUnits(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListStockUnitsQuery)) query: z.infer<typeof ListStockUnitsQuery>): Promise<Page<StockUnitView>> {
    const { cursor, limit, ...filters } = query;
    return this.queries.listStockUnits(actor, filters, cursor, limit);
  }

  @Get('stock-units/:id')
  @Operation({ operationId: 'getStockUnit', ...READ, permission: 'inv.stock.read' })
  getStockUnit(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StockUnitView> {
    return this.queries.getStockUnit(actor, id);
  }

  @Get('stock-units/:id/label')
  @Operation({ operationId: 'getStockUnitLabel', ...READ, permission: 'inv.stock.read' })
  getStockUnitLabel(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StockUnitLabelView> {
    return this.queries.getStockUnitLabel(actor, id);
  }

  @Get('stock-units/:id/trace')
  @Operation({ operationId: 'traceStockUnit', ...READ, permission: 'inv.trace.read' })
  trace(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StockTraceView> {
    return this.queries.trace(actor, id);
  }
}
