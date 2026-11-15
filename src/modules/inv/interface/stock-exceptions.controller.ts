import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalPendingView, Page } from '../application/stock-command';
import { StockExceptions, type StockExceptionView } from '../application/stock-exceptions';
import { IdParam, ListStockExceptionsQuery, StockExceptionResolve } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** The stock exception queue (FR-INV-023, ADR-0048). Parses and delegates. */
@Controller('stock/exceptions')
export class StockExceptionsController {
  constructor(@Inject(StockExceptions) private readonly exceptions: StockExceptions) {}

  @Get()
  @Operation({ operationId: 'listStockExceptions', ...READ, permission: 'inv.exception.read' })
  list(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListStockExceptionsQuery)) query: z.infer<typeof ListStockExceptionsQuery>): Promise<Page<StockExceptionView>> {
    const { cursor, limit, ...filters } = query;
    return this.exceptions.list(actor, filters, cursor, limit);
  }

  @Get(':id')
  @Operation({ operationId: 'getStockException', ...READ, permission: 'inv.exception.read' })
  get(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StockExceptionView> {
    return this.exceptions.get(actor, id);
  }

  @Post(':id/resolve')
  @Operation({ operationId: 'resolveStockException', ...WRITE, permission: 'inv.exception.resolve' })
  resolve(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(StockExceptionResolve)) body: z.infer<typeof StockExceptionResolve>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockExceptionView | ApprovalPendingView> {
    return reply(res, this.exceptions.resolve(actor, id, body, key));
  }
}
