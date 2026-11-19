import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { StandingOrders, type StandingOrderRunView, type StandingOrderView } from '../application/standing-orders';
import type { Page } from '../application/statements';
import { IdParam, PageQuery, ReasonBody, StandingOrderCreate, StandingOrderPageQuery, StandingOrderUpdate } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/** Standing orders and their runs (FR-WHL-004, B10 continued 3). The controller parses and delegates; the handlers authorise. */
@Controller('standing-orders')
export class StandingOrdersController {
  constructor(@Inject(StandingOrders) private readonly orders: StandingOrders) {}

  @Get()
  @Operation({ operationId: 'listStandingOrders', ...READ, permission: 'whl.standing_order.read' })
  listStandingOrders(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(StandingOrderPageQuery)) query: z.infer<typeof StandingOrderPageQuery>): Promise<Page<StandingOrderView>> {
    return this.orders.list(actor, { customerId: query.customerId ?? null, status: query.status ?? null }, query.cursor, query.limit);
  }

  @Post()
  @Operation({ operationId: 'createStandingOrder', ...WRITE, permission: 'whl.standing_order.manage' })
  async createStandingOrder(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(StandingOrderCreate)) body: z.infer<typeof StandingOrderCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StandingOrderView> {
    const response = await this.orders.create(actor, body, key);
    res.status(response.status);
    return response.body;
  }

  @Get(':id')
  @Operation({ operationId: 'getStandingOrder', ...READ, permission: 'whl.standing_order.read' })
  getStandingOrder(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StandingOrderView> {
    return this.orders.get(actor, id);
  }

  @Patch(':id')
  @Operation({ operationId: 'updateStandingOrder', ...WRITE, permission: 'whl.standing_order.manage' })
  async updateStandingOrder(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(StandingOrderUpdate)) body: z.infer<typeof StandingOrderUpdate>,
    @IdempotencyKeyHeader() key: string,
  ): Promise<StandingOrderView> {
    return (await this.orders.update(actor, id, body, key)).body;
  }

  @Post(':id/pause')
  @HttpCode(200)
  @Operation({ operationId: 'pauseStandingOrder', ...WRITE, permission: 'whl.standing_order.manage' })
  async pauseStandingOrder(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>, @IdempotencyKeyHeader() key: string): Promise<StandingOrderView> {
    return (await this.orders.pause(actor, id, body.reason, key)).body;
  }

  @Post(':id/resume')
  @HttpCode(200)
  @Operation({ operationId: 'resumeStandingOrder', ...WRITE, permission: 'whl.standing_order.manage' })
  async resumeStandingOrder(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>, @IdempotencyKeyHeader() key: string): Promise<StandingOrderView> {
    return (await this.orders.resume(actor, id, body.reason, key)).body;
  }

  @Post(':id/end')
  @HttpCode(200)
  @Operation({ operationId: 'endStandingOrder', ...WRITE, permission: 'whl.standing_order.manage' })
  async endStandingOrder(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>, @IdempotencyKeyHeader() key: string): Promise<StandingOrderView> {
    return (await this.orders.end(actor, id, body.reason, key)).body;
  }

  @Get(':id/runs')
  @Operation({ operationId: 'listStandingOrderRuns', ...READ, permission: 'whl.standing_order.read' })
  listStandingOrderRuns(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<StandingOrderRunView>> {
    return this.orders.runs(actor, id, query.cursor, query.limit);
  }
}
