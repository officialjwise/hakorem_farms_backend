import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { CostingReports, type BreakEvenView, type CostObjectView, type LossReportView, type MarginReportView } from '../application/costing-reports';
import { OverheadAllocations, type OverheadAllocationRunView, type Page } from '../application/overhead-allocations';
import { BreakEvenQuery, IdParam, LossQuery, MarginQuery, ObjectTypeParam, OverheadAllocationCreate, PageQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** CST's HTTP surface (docs/API.md, Costing): cost objects, margins, break-even, losses and allocation runs. */
@Controller()
export class CostingController {
  constructor(
    @Inject(CostingReports) private readonly reports: CostingReports,
    @Inject(OverheadAllocations) private readonly allocations: OverheadAllocations,
  ) {}

  @Get('costing/cost-objects/:objectType/:objectId')
  @Operation({ operationId: 'getCostObject', ...READ, permission: 'cst.cost.read' })
  getCostObject(
    @CurrentActor() actor: Actor | undefined,
    @Param('objectType', zodPipe(ObjectTypeParam)) objectType: z.infer<typeof ObjectTypeParam>,
    @Param('objectId', zodPipe(IdParam)) objectId: string,
  ): Promise<CostObjectView> {
    return this.reports.getCostObject(actor, objectType, objectId);
  }

  @Get('costing/margins')
  @Operation({ operationId: 'listMargins', ...READ, permission: 'cst.margin.read' })
  listMargins(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(MarginQuery)) q: z.infer<typeof MarginQuery>): Promise<MarginReportView> {
    return this.reports.listMargins(actor, q);
  }

  @Get('costing/break-even')
  @Operation({ operationId: 'getBreakEven', ...READ, permission: 'cst.margin.read' })
  getBreakEven(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(BreakEvenQuery)) q: z.infer<typeof BreakEvenQuery>): Promise<BreakEvenView> {
    return this.reports.getBreakEven(actor, q);
  }

  @Get('costing/losses')
  @Operation({ operationId: 'listLosses', ...READ, permission: 'cst.margin.read' })
  listLosses(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(LossQuery)) q: z.infer<typeof LossQuery>): Promise<LossReportView> {
    return this.reports.listLosses(actor, q);
  }

  @Get('costing/overhead-allocations')
  @Operation({ operationId: 'listOverheadAllocations', ...READ, permission: 'cst.allocation.read' })
  listOverheadAllocations(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) q: z.infer<typeof PageQuery>): Promise<Page<OverheadAllocationRunView>> {
    return this.allocations.list(actor, q.cursor, q.limit);
  }

  @Post('costing/overhead-allocations')
  @Operation({ operationId: 'createOverheadAllocation', ...WRITE, permission: 'cst.allocation.manage' })
  createOverheadAllocation(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(OverheadAllocationCreate)) body: z.infer<typeof OverheadAllocationCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OverheadAllocationRunView> {
    return reply(res, this.allocations.create(actor, body, key));
  }

  @Get('costing/overhead-allocations/:id')
  @Operation({ operationId: 'getOverheadAllocation', ...READ, permission: 'cst.allocation.read' })
  getOverheadAllocation(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<OverheadAllocationRunView> {
    return this.allocations.get(actor, id);
  }

  @Post('costing/overhead-allocations/:id/post')
  @Operation({ operationId: 'postOverheadAllocation', ...WRITE, permission: 'cst.allocation.post' })
  postOverheadAllocation(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OverheadAllocationRunView> {
    return reply(res, this.allocations.post(actor, id, key));
  }
}
