import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { Animals, type AnimalView } from '../application/animals';
import { Feeding, type FeedConsumptionView, type RationView } from '../application/feeding';
import { HealthRecords, type HealthEventView } from '../application/health';
import { MortalityRecords, type ApprovalPendingView, type MortalityRecordView } from '../application/mortality';
import type { Page } from '../application/support';
import { Weighing, type WeightBatchView, type WeightRecordView } from '../application/weights';
import {
  FeedConsumptionCreate,
  HealthEventCreate,
  IdParam,
  ListAnimalsQuery,
  ListFeedConsumptionQuery,
  ListHealthEventsQuery,
  ListMortalityRecordsQuery,
  ListRationsQuery,
  ListWeightRecordsQuery,
  MortalityRecordCreate,
  RationCreate,
  RationUpdate,
  WeightRecordBatch,
} from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/**
 * The animal register, weights, health events, mortality and feed (FR-LIV-001, FR-LIV-004, FR-LIV-007 to FR-LIV-009,
 * FR-LIV-012, FR-LIV-014, FR-LIV-015). The controller parses and delegates; the handlers authorise and decide.
 */
@Controller()
export class LivestockController {
  constructor(
    @Inject(Animals) private readonly animals: Animals,
    @Inject(Weighing) private readonly weighing: Weighing,
    @Inject(HealthRecords) private readonly health: HealthRecords,
    @Inject(MortalityRecords) private readonly mortality: MortalityRecords,
    @Inject(Feeding) private readonly feeding: Feeding,
  ) {}

  @Get('animals')
  @Operation({ operationId: 'listAnimals', ...READ, permission: 'liv.animal.read' })
  listAnimals(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListAnimalsQuery)) query: z.infer<typeof ListAnimalsQuery>): Promise<Page<AnimalView>> {
    const { cursor, limit, ...filters } = query;
    return this.animals.list(actor, filters, cursor, limit);
  }

  @Get('animals/:id')
  @Operation({ operationId: 'getAnimal', ...READ, permission: 'liv.animal.read' })
  getAnimal(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<AnimalView> {
    return this.animals.get(actor, id);
  }

  @Get('weight-records')
  @Operation({ operationId: 'listWeightRecords', ...READ, permission: 'liv.weight.read' })
  listWeightRecords(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListWeightRecordsQuery)) query: z.infer<typeof ListWeightRecordsQuery>): Promise<Page<WeightRecordView>> {
    const { cursor, limit, ...filters } = query;
    return this.weighing.list(actor, filters, cursor, limit);
  }

  @Post('weight-records')
  @Operation({ operationId: 'recordWeights', ...WRITE, permission: 'liv.weight.record' })
  recordWeights(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(WeightRecordBatch)) body: z.infer<typeof WeightRecordBatch>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WeightBatchView> {
    return reply(res, this.weighing.record(actor, body.records, key));
  }

  @Get('health-events')
  @Operation({ operationId: 'listHealthEvents', ...READ, permission: 'liv.health.read' })
  listHealthEvents(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListHealthEventsQuery)) query: z.infer<typeof ListHealthEventsQuery>): Promise<Page<HealthEventView>> {
    const { cursor, limit, ...filters } = query;
    return this.health.list(actor, filters, cursor, limit);
  }

  @Post('health-events')
  @Operation({ operationId: 'recordHealthEvent', ...WRITE, permission: 'liv.health.record' })
  recordHealthEvent(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(HealthEventCreate)) body: z.infer<typeof HealthEventCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthEventView> {
    return reply(res, this.health.record(actor, body, key));
  }

  @Get('health-events/:id')
  @Operation({ operationId: 'getHealthEvent', ...READ, permission: 'liv.health.read' })
  getHealthEvent(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<HealthEventView> {
    return this.health.get(actor, id);
  }

  @Get('mortality-records')
  @Operation({ operationId: 'listMortalityRecords', ...READ, permission: 'liv.mortality.read' })
  listMortalityRecords(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListMortalityRecordsQuery)) query: z.infer<typeof ListMortalityRecordsQuery>): Promise<Page<MortalityRecordView>> {
    const { cursor, limit, ...filters } = query;
    return this.mortality.list(actor, filters, cursor, limit);
  }

  @Post('mortality-records')
  @Operation({ operationId: 'reportMortality', ...WRITE, permission: 'liv.mortality.report' })
  reportMortality(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(MortalityRecordCreate)) body: z.infer<typeof MortalityRecordCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MortalityRecordView> {
    return reply(res, this.mortality.report(actor, body, key));
  }

  @Get('mortality-records/:id')
  @Operation({ operationId: 'getMortalityRecord', ...READ, permission: 'liv.mortality.read' })
  getMortalityRecord(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<MortalityRecordView> {
    return this.mortality.get(actor, id);
  }

  @Post('mortality-records/:id/submit')
  @Operation({ operationId: 'submitMortalityRecord', ...WRITE, permission: 'liv.mortality.report' })
  submitMortalityRecord(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MortalityRecordView | ApprovalPendingView> {
    return reply(res, this.mortality.submit(actor, id, key));
  }

  @Get('rations')
  @Operation({ operationId: 'listRations', ...READ, permission: 'liv.feed.read' })
  listRations(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListRationsQuery)) query: z.infer<typeof ListRationsQuery>): Promise<Page<RationView>> {
    return this.feeding.listRations(actor, query.speciesId, query.cursor, query.limit);
  }

  @Post('rations')
  @Operation({ operationId: 'createRation', ...WRITE, permission: 'liv.feed.manage' })
  createRation(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(RationCreate)) body: z.infer<typeof RationCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RationView> {
    return reply(res, this.feeding.createRation(actor, body, key));
  }

  @Patch('rations/:id')
  @Operation({ operationId: 'updateRation', ...WRITE, permission: 'liv.feed.manage' })
  updateRation(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(RationUpdate)) body: z.infer<typeof RationUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RationView> {
    return reply(res, this.feeding.updateRation(actor, id, body, key));
  }

  @Get('feed-consumption')
  @Operation({ operationId: 'listFeedConsumption', ...READ, permission: 'liv.feed.read' })
  listFeedConsumption(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListFeedConsumptionQuery)) query: z.infer<typeof ListFeedConsumptionQuery>): Promise<Page<FeedConsumptionView>> {
    const { cursor, limit, ...filters } = query;
    return this.feeding.list(actor, filters, cursor, limit);
  }

  @Post('feed-consumption')
  @Operation({ operationId: 'recordFeedConsumption', ...WRITE, permission: 'liv.feed.record' })
  recordFeedConsumption(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(FeedConsumptionCreate)) body: z.infer<typeof FeedConsumptionCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FeedConsumptionView> {
    return reply(res, this.feeding.record(actor, body, key));
  }

  @Get('feed-consumption/:id')
  @Operation({ operationId: 'getFeedConsumption', ...READ, permission: 'liv.feed.read' })
  getFeedConsumption(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<FeedConsumptionView> {
    return this.feeding.get(actor, id);
  }
}
