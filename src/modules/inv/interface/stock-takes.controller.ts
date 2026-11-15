import { Body, Controller, Get, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalPendingView, Page } from '../application/stock-command';
import { StockTakes, type StockTakeLineView, type StockTakeView } from '../application/stock-takes';
import { IdParam, ListStockTakesQuery, PageQuery, ReasonBody, StockTakeCounts, StockTakeCreate } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Stock takes and cycle counts (FR-INV-013, FR-INV-014). Parses and delegates. */
@Controller('stock-takes')
export class StockTakesController {
  constructor(@Inject(StockTakes) private readonly takes: StockTakes) {}

  @Get()
  @Operation({ operationId: 'listStockTakes', ...READ, permission: 'inv.stock_take.read' })
  list(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListStockTakesQuery)) query: z.infer<typeof ListStockTakesQuery>): Promise<Page<StockTakeView>> {
    const { cursor, limit, ...filters } = query;
    return this.takes.list(actor, filters, cursor, limit);
  }

  @Post()
  @Operation({ operationId: 'createStockTake', ...WRITE, permission: 'inv.stock_take.create' })
  create(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(StockTakeCreate)) body: z.infer<typeof StockTakeCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockTakeView> {
    return reply(res, this.takes.create(actor, body, key));
  }

  @Get(':id')
  @Operation({ operationId: 'getStockTake', ...READ, permission: 'inv.stock_take.read' })
  get(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StockTakeView> {
    return this.takes.get(actor, id);
  }

  @Post(':id/start')
  @Operation({ operationId: 'startStockTake', ...WRITE, permission: 'inv.stock_take.create' })
  start(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<StockTakeView> {
    return reply(res, this.takes.start(actor, id, key));
  }

  @Get(':id/lines')
  @Operation({ operationId: 'listStockTakeLines', ...READ, permission: 'inv.stock_take.read' })
  lines(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<StockTakeLineView>> {
    return this.takes.listLines(actor, id, query.cursor, query.limit);
  }

  @Put(':id/counts')
  @Operation({ operationId: 'recordStockTakeCounts', ...WRITE, permission: 'inv.stock_take.count' })
  counts(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(StockTakeCounts)) body: z.infer<typeof StockTakeCounts>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockTakeView> {
    return reply(res, this.takes.recordCounts(actor, id, body, key));
  }

  @Post(':id/review')
  @Operation({ operationId: 'closeStockTakeCounting', ...WRITE, permission: 'inv.stock_take.count' })
  review(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<StockTakeView> {
    return reply(res, this.takes.close(actor, id, key));
  }

  @Post(':id/submit')
  @Operation({ operationId: 'submitStockTake', ...WRITE, permission: 'inv.stock_take.post' })
  submit(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockTakeView | ApprovalPendingView> {
    return reply(res, this.takes.submit(actor, id, key));
  }

  @Post(':id/cancel')
  @Operation({ operationId: 'cancelStockTake', ...WRITE, permission: 'inv.stock_take.create' })
  cancel(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockTakeView> {
    return reply(res, this.takes.cancel(actor, id, body, key));
  }
}
