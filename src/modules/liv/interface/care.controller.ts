import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { AnimalCare } from '../application/animal-care';
import { Animals } from '../application/animals';
import { Batches } from '../application/batches';
import {
  careAnimal,
  careAnswer,
  careBatch,
  careFeedConsumption,
  careHealthEvent,
  careMortalityRecord,
  carePage,
  careRead,
  careSubmission,
  careWrite,
  type CareAnimalView,
  type CareBatchView,
  type CareFeedConsumptionView,
  type CareHealthEventView,
  type CareMortalityRecordView,
} from '../application/care';
import { Feeding, type RationView } from '../application/feeding';
import { HealthRecords } from '../application/health';
import { MortalityRecords, type ApprovalPendingView } from '../application/mortality';
import type { Page } from '../application/support';
import {
  AnimalMove,
  AnimalUpdate,
  BatchCreate,
  BatchUpdate,
  FeedConsumptionCreate,
  HealthEventCreate,
  IdParam,
  ListAnimalsQuery,
  ListBatchesQuery,
  ListHealthEventsQuery,
  ListRationsQuery,
  MortalityRecordCreate,
  ReasonRequest,
  TagParam,
} from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/**
 * The Farm hand's cost-free care operations (owner, 2026-11-15; A-160, ADR-0052): the animal register, the rations, the
 * batches and the health events with their withdrawal holds, read under `liv.care.read`, and the animal work the role
 * records, under the same write permissions as the full operations, each answered in a shape with no cost and no price.
 * The handlers are the full operations' own; only the door differs, so a rule cannot differ between the two.
 */
@Controller('care')
export class CareController {
  constructor(
    @Inject(Animals) private readonly animals: Animals,
    @Inject(AnimalCare) private readonly care: AnimalCare,
    @Inject(HealthRecords) private readonly health: HealthRecords,
    @Inject(MortalityRecords) private readonly mortality: MortalityRecords,
    @Inject(Feeding) private readonly feeding: Feeding,
    @Inject(Batches) private readonly batches: Batches,
  ) {}

  @Get('animals')
  @Operation({ operationId: 'listCareAnimals', ...READ, permission: 'liv.care.read' })
  async listCareAnimals(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListAnimalsQuery)) query: z.infer<typeof ListAnimalsQuery>): Promise<Page<CareAnimalView>> {
    const { cursor, limit, ...filters } = query;
    return carePage(await this.animals.list(actor, filters, cursor, limit, careRead('listCareAnimals')), careAnimal);
  }

  @Get('animal-tags/:tagNo')
  @Operation({ operationId: 'getCareAnimalByTag', ...READ, permission: 'liv.care.read' })
  async getCareAnimalByTag(@CurrentActor() actor: Actor | undefined, @Param('tagNo', zodPipe(TagParam)) tagNo: string): Promise<CareAnimalView> {
    return careAnimal(await this.animals.getByTag(actor, tagNo, careRead('getCareAnimalByTag')));
  }

  @Get('animals/:id')
  @Operation({ operationId: 'getCareAnimal', ...READ, permission: 'liv.care.read' })
  async getCareAnimal(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<CareAnimalView> {
    return careAnimal(await this.animals.get(actor, id, careRead('getCareAnimal')));
  }

  @Patch('animals/:id')
  @Operation({ operationId: 'updateCareAnimal', ...WRITE, permission: 'liv.animal.update' })
  updateCareAnimal(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(AnimalUpdate)) body: z.infer<typeof AnimalUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CareAnimalView> {
    return reply(res, careAnswer(this.care.update(actor, id, body, key, careWrite('updateCareAnimal')), careAnimal));
  }

  @Post('animals/:id/move')
  @Operation({ operationId: 'moveCareAnimal', ...WRITE, permission: 'liv.animal.move' })
  moveCareAnimal(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(AnimalMove)) body: z.infer<typeof AnimalMove>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CareAnimalView> {
    return reply(res, careAnswer(this.care.move(actor, id, body, key, careWrite('moveCareAnimal')), careAnimal));
  }

  @Get('health-events')
  @Operation({ operationId: 'listCareHealthEvents', ...READ, permission: 'liv.care.read' })
  async listCareHealthEvents(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListHealthEventsQuery)) query: z.infer<typeof ListHealthEventsQuery>): Promise<Page<CareHealthEventView>> {
    const { cursor, limit, ...filters } = query;
    return carePage(await this.health.list(actor, filters, cursor, limit, careRead('listCareHealthEvents')), careHealthEvent);
  }

  @Post('health-events')
  @Operation({ operationId: 'recordCareHealthEvent', ...WRITE, permission: 'liv.health.record' })
  recordCareHealthEvent(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(HealthEventCreate)) body: z.infer<typeof HealthEventCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CareHealthEventView> {
    return reply(res, careAnswer(this.health.record(actor, body, key, careWrite('recordCareHealthEvent')), careHealthEvent));
  }

  @Get('health-events/:id')
  @Operation({ operationId: 'getCareHealthEvent', ...READ, permission: 'liv.care.read' })
  async getCareHealthEvent(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<CareHealthEventView> {
    return careHealthEvent(await this.health.get(actor, id, careRead('getCareHealthEvent')));
  }

  @Post('mortality-records')
  @Operation({ operationId: 'reportCareMortality', ...WRITE, permission: 'liv.mortality.report' })
  reportCareMortality(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(MortalityRecordCreate)) body: z.infer<typeof MortalityRecordCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CareMortalityRecordView> {
    return reply(res, careAnswer(this.mortality.report(actor, body, key, careWrite('reportCareMortality')), careMortalityRecord));
  }

  @Post('mortality-records/:id/submit')
  @Operation({ operationId: 'submitCareMortalityRecord', ...WRITE, permission: 'liv.mortality.report' })
  submitCareMortalityRecord(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CareMortalityRecordView | ApprovalPendingView> {
    return reply(res, careAnswer(this.mortality.submit(actor, id, key, careWrite('submitCareMortalityRecord')), careSubmission));
  }

  @Get('rations')
  @Operation({ operationId: 'listCareRations', ...READ, permission: 'liv.care.read' })
  listCareRations(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListRationsQuery)) query: z.infer<typeof ListRationsQuery>): Promise<Page<RationView>> {
    return this.feeding.listRations(actor, query.speciesId, query.cursor, query.limit, careRead('listCareRations'));
  }

  @Post('feed-consumption')
  @Operation({ operationId: 'recordCareFeedConsumption', ...WRITE, permission: 'liv.feed.record' })
  recordCareFeedConsumption(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(FeedConsumptionCreate)) body: z.infer<typeof FeedConsumptionCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CareFeedConsumptionView> {
    return reply(res, careAnswer(this.feeding.record(actor, body, key, careWrite('recordCareFeedConsumption')), careFeedConsumption));
  }

  @Get('batches')
  @Operation({ operationId: 'listCareBatches', ...READ, permission: 'liv.care.read' })
  async listCareBatches(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListBatchesQuery)) query: z.infer<typeof ListBatchesQuery>): Promise<Page<CareBatchView>> {
    const { cursor, limit, ...filters } = query;
    return carePage(await this.batches.list(actor, filters, cursor, limit, careRead('listCareBatches')), careBatch);
  }

  @Post('batches')
  @Operation({ operationId: 'createCareBatch', ...WRITE, permission: 'liv.batch.create' })
  createCareBatch(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(BatchCreate)) body: z.infer<typeof BatchCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CareBatchView> {
    return reply(res, careAnswer(this.batches.create(actor, body, key, careWrite('createCareBatch')), careBatch));
  }

  @Get('batches/:id')
  @Operation({ operationId: 'getCareBatch', ...READ, permission: 'liv.care.read' })
  async getCareBatch(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<CareBatchView> {
    return careBatch(await this.batches.get(actor, id, careRead('getCareBatch')));
  }

  @Patch('batches/:id')
  @Operation({ operationId: 'updateCareBatch', ...WRITE, permission: 'liv.batch.update' })
  updateCareBatch(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(BatchUpdate)) body: z.infer<typeof BatchUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CareBatchView> {
    return reply(res, careAnswer(this.batches.update(actor, id, body, key, careWrite('updateCareBatch')), careBatch));
  }

  @Post('batches/:id/close')
  @Operation({ operationId: 'closeCareBatch', ...WRITE, permission: 'liv.batch.update' })
  closeCareBatch(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CareBatchView> {
    return reply(res, careAnswer(this.batches.close(actor, id, body.reason, key, careWrite('closeCareBatch')), careBatch));
  }
}
