import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalPendingView, Page } from '../application/capital';
import { Distributions, type DistributionLineView, type DistributionRunView } from '../application/distributions';
import { IdParam, PaymentCreate, RunCreate, RunPageQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Profit distribution runs (FR-CAP-006 to FR-CAP-012, ADR-0028). The handlers authorise. */
@Controller()
export class DistributionsController {
  constructor(@Inject(Distributions) private readonly distributions: Distributions) {}

  @Get('distribution-runs')
  @Operation({ operationId: 'listDistributionRuns', ...READ, permission: 'cap.distribution.read' })
  listDistributionRuns(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(RunPageQuery)) q: z.infer<typeof RunPageQuery>): Promise<Page<DistributionRunView>> {
    return this.distributions.list(actor, { status: q.status ?? null }, q.cursor, q.limit);
  }

  @Post('distribution-runs')
  @Operation({ operationId: 'createDistributionRun', ...WRITE, permission: 'cap.distribution.create' })
  createDistributionRun(@CurrentActor() actor: Actor | undefined, @Body(zodPipe(RunCreate)) body: z.infer<typeof RunCreate>, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<DistributionRunView> {
    return reply(res, this.distributions.create(actor, body, key));
  }

  @Get('distribution-runs/:id')
  @Operation({ operationId: 'getDistributionRun', ...READ, permission: 'cap.distribution.read' })
  getDistributionRun(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<DistributionRunView> {
    return this.distributions.get(actor, id);
  }

  @Post('distribution-runs/:id/recompute')
  @HttpCode(200)
  @Operation({ operationId: 'recomputeDistributionRun', ...WRITE, permission: 'cap.distribution.create' })
  recomputeDistributionRun(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<DistributionRunView> {
    return reply(res, this.distributions.recompute(actor, id, key));
  }

  @Post('distribution-runs/:id/submit')
  @HttpCode(202)
  @Operation({ operationId: 'submitDistributionRun', ...WRITE, permission: 'cap.distribution.create' })
  submitDistributionRun(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<ApprovalPendingView> {
    return reply(res, this.distributions.submit(actor, id, key));
  }

  @Post('distribution-runs/:id/post')
  @HttpCode(200)
  @Operation({ operationId: 'postDistributionRun', ...WRITE, permission: 'cap.distribution.post' })
  postDistributionRun(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<DistributionRunView> {
    return reply(res, this.distributions.post(actor, id, key));
  }

  @Post('distribution-runs/:id/schedule')
  @HttpCode(200)
  @Operation({ operationId: 'getDistributionSchedule', access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: true, rateLimit: 'console', permission: 'cap.distribution.read' })
  getDistributionSchedule(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<{ readonly url: string; readonly expiresAt: string }> {
    return this.distributions.schedule(actor, id);
  }

  @Post('distribution-lines/:id/payments')
  @Operation({ operationId: 'recordDistributionPayment', ...WRITE, permission: 'cap.distribution.pay' })
  recordDistributionPayment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PaymentCreate)) body: z.infer<typeof PaymentCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DistributionLineView> {
    return reply(res, this.distributions.pay(actor, id, body, key));
  }
}
