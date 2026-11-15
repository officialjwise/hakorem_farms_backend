import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Page } from '../application/stock-command';
import { StockHolds, type StockHoldView } from '../application/stock-holds';
import { IdParam, ListStockHoldsQuery, StockHoldCreate, StockHoldRelease } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Holds that block sale, processing and dispatch (FR-INV-022). Parses and delegates. */
@Controller('stock/holds')
export class StockHoldsController {
  constructor(@Inject(StockHolds) private readonly holds: StockHolds) {}

  @Get()
  @Operation({ operationId: 'listStockHolds', ...READ, permission: 'inv.hold.read' })
  list(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListStockHoldsQuery)) query: z.infer<typeof ListStockHoldsQuery>): Promise<Page<StockHoldView>> {
    const { cursor, limit, ...filters } = query;
    return this.holds.list(actor, filters, cursor, limit);
  }

  @Post()
  @Operation({ operationId: 'createStockHold', ...WRITE, permission: 'inv.hold.create' })
  create(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(StockHoldCreate)) body: z.infer<typeof StockHoldCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockHoldView> {
    return reply(res, this.holds.create(actor, body, key));
  }

  @Post(':id/release')
  @Operation({ operationId: 'releaseStockHold', ...WRITE, permission: 'inv.hold.release' })
  release(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(StockHoldRelease)) body: z.infer<typeof StockHoldRelease>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockHoldView> {
    return reply(res, this.holds.release(actor, id, body, key));
  }
}
