import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { Processing, type ApprovalPendingView, type Page, type ProcessingOrderView } from '../application/processing';
import { YieldStandards, type YieldStandardView } from '../application/yield-standards';
import {
  IdParam,
  ListProcessingOrdersQuery,
  PageQuery,
  ProcessingCostCreate,
  ProcessingOrderCreate,
  ProcessingOrderUpdate,
  ProcessingOutputsReplace,
  ReasonBody,
  YieldStandardCreate,
  YieldStandardUpdate,
} from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Processing orders and yield standards (FR-PRC-001 to FR-PRC-008). The controller parses and delegates; the handlers authorise and decide. */
@Controller()
export class ProcessingController {
  constructor(
    @Inject(Processing) private readonly processing: Processing,
    @Inject(YieldStandards) private readonly standards: YieldStandards,
  ) {}

  @Get('processing-orders')
  @Operation({ operationId: 'listProcessingOrders', ...READ, permission: 'prc.order.read' })
  list(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListProcessingOrdersQuery)) query: z.infer<typeof ListProcessingOrdersQuery>): Promise<Page<ProcessingOrderView>> {
    return this.processing.list(actor, { status: query.status, from: query.from, to: query.to, yieldVarianceFlag: query.yieldVarianceFlag }, query.cursor, query.limit);
  }

  @Post('processing-orders')
  @Operation({ operationId: 'createProcessingOrder', ...WRITE, permission: 'prc.order.create' })
  create(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(ProcessingOrderCreate)) body: z.infer<typeof ProcessingOrderCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProcessingOrderView> {
    return reply(res, this.processing.create(actor, body, key));
  }

  @Get('processing-orders/:id')
  @Operation({ operationId: 'getProcessingOrder', ...READ, permission: 'prc.order.read' })
  get(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<ProcessingOrderView> {
    return this.processing.get(actor, id);
  }

  @Patch('processing-orders/:id')
  @Operation({ operationId: 'updateProcessingOrder', ...WRITE, permission: 'prc.order.create' })
  update(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ProcessingOrderUpdate)) body: z.infer<typeof ProcessingOrderUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProcessingOrderView> {
    return reply(res, this.processing.update(actor, id, body, key));
  }

  @Post('processing-orders/:id/start')
  @Operation({ operationId: 'startProcessingOrder', ...WRITE, permission: 'prc.order.process' })
  start(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<ProcessingOrderView> {
    return reply(res, this.processing.start(actor, id, key));
  }

  @Put('processing-orders/:id/outputs')
  @Operation({ operationId: 'recordProcessingOutputs', ...WRITE, permission: 'prc.order.process' })
  outputs(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ProcessingOutputsReplace)) body: z.infer<typeof ProcessingOutputsReplace>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProcessingOrderView> {
    return reply(res, this.processing.recordOutputs(actor, id, body, key));
  }

  @Post('processing-orders/:id/costs')
  @Operation({ operationId: 'addProcessingCost', ...WRITE, permission: 'prc.order.process' })
  addCost(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ProcessingCostCreate)) body: z.infer<typeof ProcessingCostCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProcessingOrderView> {
    return reply(res, this.processing.addCost(actor, id, body, key));
  }

  @Post('processing-orders/:id/complete')
  @Operation({ operationId: 'completeProcessingOrder', ...WRITE, permission: 'prc.order.process' })
  complete(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<ProcessingOrderView> {
    return reply(res, this.processing.complete(actor, id, key));
  }

  @Post('processing-orders/:id/cancel')
  @Operation({ operationId: 'cancelProcessingOrder', ...WRITE, permission: 'prc.order.create' })
  cancel(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProcessingOrderView | ApprovalPendingView> {
    return reply(res, this.processing.cancel(actor, id, body, key));
  }

  @Get('yield-standards')
  @Operation({ operationId: 'listYieldStandards', ...READ, permission: 'prc.yield_standard.read' })
  listStandards(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<YieldStandardView>> {
    return this.standards.list(actor, query.cursor, query.limit);
  }

  @Post('yield-standards')
  @Operation({ operationId: 'createYieldStandard', ...WRITE, permission: 'prc.yield_standard.manage' })
  createStandard(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(YieldStandardCreate)) body: z.infer<typeof YieldStandardCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<YieldStandardView> {
    return reply(res, this.standards.create(actor, body, key));
  }

  @Patch('yield-standards/:id')
  @Operation({ operationId: 'updateYieldStandard', ...WRITE, permission: 'prc.yield_standard.manage' })
  updateStandard(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(YieldStandardUpdate)) body: z.infer<typeof YieldStandardUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<YieldStandardView> {
    return reply(res, this.standards.update(actor, id, body, key));
  }
}
