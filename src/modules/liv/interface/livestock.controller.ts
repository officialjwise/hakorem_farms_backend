import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { AnimalCare, type AnimalEventView } from '../application/animal-care';
import { Animals, type AnimalView } from '../application/animals';
import { Batches, type BatchView } from '../application/batches';
import { Breeding, type BreedingRecordView } from '../application/breeding';
import { Growth, type GrowthRowView } from '../application/growth';
import { Feeding, type FeedConsumptionView, type RationView } from '../application/feeding';
import { HealthRecords, type HealthEventView } from '../application/health';
import { MortalityRecords, type ApprovalPendingView, type MortalityRecordView } from '../application/mortality';
import type { Page } from '../application/support';
import { Weighing, type WeightBatchView, type WeightRecordView } from '../application/weights';
import {
  AnimalMove,
  AnimalUpdate,
  BatchCreate,
  BatchUpdate,
  BirthRecord,
  BreedingRecordCreate,
  BreedingRecordUpdate,
  ListBatchesQuery,
  ListBreedingRecordsQuery,
  ListGrowthQuery,
  ReasonRequest,
  TimelineQuery,
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
 * The animal register, its edits, moves and timeline, weights and growth, health events, mortality, feed, batches,
 * breeding and births (FR-LIV-001 to FR-LIV-017). The controller parses and delegates; the handlers authorise and
 * decide.
 */
@Controller()
export class LivestockController {
  constructor(
    @Inject(Animals) private readonly animals: Animals,
    @Inject(Weighing) private readonly weighing: Weighing,
    @Inject(HealthRecords) private readonly health: HealthRecords,
    @Inject(MortalityRecords) private readonly mortality: MortalityRecords,
    @Inject(Feeding) private readonly feeding: Feeding,
    @Inject(AnimalCare) private readonly care: AnimalCare,
    @Inject(Batches) private readonly batches: Batches,
    @Inject(Breeding) private readonly breeding: Breeding,
    @Inject(Growth) private readonly growth: Growth,
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

  @Patch('animals/:id')
  @Operation({ operationId: 'updateAnimal', ...WRITE, permission: 'liv.animal.update' })
  updateAnimal(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(AnimalUpdate)) body: z.infer<typeof AnimalUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AnimalView> {
    return reply(res, this.care.update(actor, id, body, key));
  }

  @Get('animals/:id/timeline')
  @Operation({ operationId: 'listAnimalTimeline', ...READ, permission: 'liv.animal.read' })
  listAnimalTimeline(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(TimelineQuery)) query: z.infer<typeof TimelineQuery>): Promise<Page<AnimalEventView>> {
    return this.care.timeline(actor, id, query.cursor, query.limit);
  }

  @Post('animals/:id/move')
  @Operation({ operationId: 'moveAnimal', ...WRITE, permission: 'liv.animal.move' })
  moveAnimal(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(AnimalMove)) body: z.infer<typeof AnimalMove>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AnimalView> {
    return reply(res, this.care.move(actor, id, body, key));
  }

  @Get('livestock/growth')
  @Operation({ operationId: 'listGrowth', ...READ, permission: 'liv.report.read' })
  listGrowth(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListGrowthQuery)) query: z.infer<typeof ListGrowthQuery>): Promise<Page<GrowthRowView>> {
    const { cursor, limit, ...filters } = query;
    return this.growth.list(actor, filters, cursor, limit);
  }

  @Get('batches')
  @Operation({ operationId: 'listBatches', ...READ, permission: 'liv.batch.read' })
  listBatches(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListBatchesQuery)) query: z.infer<typeof ListBatchesQuery>): Promise<Page<BatchView>> {
    const { cursor, limit, ...filters } = query;
    return this.batches.list(actor, filters, cursor, limit);
  }

  @Post('batches')
  @Operation({ operationId: 'createBatch', ...WRITE, permission: 'liv.batch.create' })
  createBatch(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(BatchCreate)) body: z.infer<typeof BatchCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BatchView> {
    return reply(res, this.batches.create(actor, body, key));
  }

  @Get('batches/:id')
  @Operation({ operationId: 'getBatch', ...READ, permission: 'liv.batch.read' })
  getBatch(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<BatchView> {
    return this.batches.get(actor, id);
  }

  @Patch('batches/:id')
  @Operation({ operationId: 'updateBatch', ...WRITE, permission: 'liv.batch.update' })
  updateBatch(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(BatchUpdate)) body: z.infer<typeof BatchUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BatchView> {
    return reply(res, this.batches.update(actor, id, body, key));
  }

  @Post('batches/:id/close')
  @Operation({ operationId: 'closeBatch', ...WRITE, permission: 'liv.batch.update' })
  closeBatch(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BatchView> {
    return reply(res, this.batches.close(actor, id, body.reason, key));
  }

  @Get('breeding-records')
  @Operation({ operationId: 'listBreedingRecords', ...READ, permission: 'liv.breeding.read' })
  listBreedingRecords(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListBreedingRecordsQuery)) query: z.infer<typeof ListBreedingRecordsQuery>): Promise<Page<BreedingRecordView>> {
    const { cursor, limit, ...filters } = query;
    return this.breeding.list(actor, filters, cursor, limit);
  }

  @Post('breeding-records')
  @Operation({ operationId: 'createBreedingRecord', ...WRITE, permission: 'liv.breeding.record' })
  createBreedingRecord(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(BreedingRecordCreate)) body: z.infer<typeof BreedingRecordCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BreedingRecordView> {
    return reply(res, this.breeding.create(actor, body, key));
  }

  @Get('breeding-records/:id')
  @Operation({ operationId: 'getBreedingRecord', ...READ, permission: 'liv.breeding.read' })
  getBreedingRecord(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<BreedingRecordView> {
    return this.breeding.get(actor, id);
  }

  @Patch('breeding-records/:id')
  @Operation({ operationId: 'updateBreedingRecord', ...WRITE, permission: 'liv.breeding.record' })
  updateBreedingRecord(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(BreedingRecordUpdate)) body: z.infer<typeof BreedingRecordUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BreedingRecordView> {
    return reply(res, this.breeding.update(actor, id, body, key));
  }

  @Post('breeding-records/:id/record-birth')
  @Operation({ operationId: 'recordBirth', ...WRITE, permission: 'liv.breeding.record' })
  recordBirth(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(BirthRecord)) body: z.infer<typeof BirthRecord>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BreedingRecordView> {
    return reply(res, this.breeding.recordBirth(actor, id, body, key));
  }

  @Post('breeding-records/:id/fail')
  @Operation({ operationId: 'failBreedingRecord', ...WRITE, permission: 'liv.breeding.record' })
  failBreedingRecord(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BreedingRecordView> {
    return reply(res, this.breeding.fail(actor, id, body.reason, key));
  }
}
