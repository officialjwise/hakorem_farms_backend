import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { StockQueries, type StockOnHandPageView, type StockTraceView, type StockUnitView } from '../application/stock-queries';
import { IdParam, ListStockOnHandQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;

/** Stock on hand, stock units and the trace (FR-INV-003, FR-INV-006). The controller parses and delegates. */
@Controller()
export class StockController {
  constructor(@Inject(StockQueries) private readonly queries: StockQueries) {}

  @Get('stock/on-hand')
  @Operation({ operationId: 'listStockOnHand', ...READ, permission: 'inv.stock.read' })
  listOnHand(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListStockOnHandQuery)) query: z.infer<typeof ListStockOnHandQuery>): Promise<StockOnHandPageView> {
    const { cursor, limit, ...filters } = query;
    return this.queries.listOnHand(actor, filters, cursor, limit);
  }

  @Get('stock-units/:id')
  @Operation({ operationId: 'getStockUnit', ...READ, permission: 'inv.stock.read' })
  getStockUnit(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StockUnitView> {
    return this.queries.getStockUnit(actor, id);
  }

  @Get('stock-units/:id/trace')
  @Operation({ operationId: 'traceStockUnit', ...READ, permission: 'inv.trace.read' })
  trace(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StockTraceView> {
    return this.queries.trace(actor, id);
  }
}
