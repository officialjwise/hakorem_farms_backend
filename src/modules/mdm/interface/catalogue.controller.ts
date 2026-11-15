import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { CatalogueAdmin } from '../application/catalogue-admin';
import type { CategoryView, GradeView, SpeciesView, UomView, WeightBandView } from '../application/catalogue-store';
import type { Page } from '../application/product-catalogue';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import {
  ArchiveBody,
  CategoryCreate,
  CategoryUpdate,
  GradeCreate,
  GradeUpdate,
  IdParam,
  PageQuery,
  SpeciesCreate,
  SpeciesPageQuery,
  SpeciesUpdate,
  WeightBandCreate,
  WeightBandUpdate,
} from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/** Sets the stored status (201, 200, or a replay's) and returns the body. */
async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/**
 * Categories, units of measure, species, grades and weight bands (FR-MDM-002, FR-MDM-003, FR-MDM-005). The controller
 * parses and delegates; the handlers authorise, do the work and decide the status.
 */
@Controller()
export class CatalogueController {
  constructor(@Inject(CatalogueAdmin) private readonly admin: CatalogueAdmin) {}

  @Get('categories')
  @Operation({ operationId: 'listCategories', ...READ, permission: 'mdm.category.read' })
  listCategories(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<CategoryView>> {
    return this.admin.listCategories(actor, query.cursor, query.limit);
  }

  @Post('categories')
  @Operation({ operationId: 'createCategory', ...WRITE, permission: 'mdm.category.create' })
  createCategory(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(CategoryCreate)) body: z.infer<typeof CategoryCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CategoryView> {
    return reply(res, this.admin.createCategory(actor, body, key));
  }

  @Get('categories/:id')
  @Operation({ operationId: 'getCategory', ...READ, permission: 'mdm.category.read' })
  getCategory(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<CategoryView> {
    return this.admin.getCategory(actor, id);
  }

  @Patch('categories/:id')
  @Operation({ operationId: 'updateCategory', ...WRITE, permission: 'mdm.category.update' })
  updateCategory(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(CategoryUpdate)) body: z.infer<typeof CategoryUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CategoryView> {
    return reply(res, this.admin.updateCategory(actor, id, body, key));
  }

  @Post('categories/:id/archive')
  @Operation({ operationId: 'archiveCategory', ...WRITE, permission: 'mdm.category.archive' })
  archiveCategory(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ArchiveBody)) body: z.infer<typeof ArchiveBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CategoryView> {
    return reply(res, this.admin.archiveCategory(actor, id, body, key));
  }

  @Get('units-of-measure')
  @Operation({ operationId: 'listUnitsOfMeasure', ...READ, permission: 'mdm.product.read' })
  listUnitsOfMeasure(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<UomView>> {
    return this.admin.listUnits(actor, query.cursor, query.limit);
  }

  @Get('species')
  @Operation({ operationId: 'listSpeciesList', ...READ, permission: 'mdm.species.read' })
  listSpeciesList(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<SpeciesView>> {
    return this.admin.listSpecies(actor, query.cursor, query.limit);
  }

  @Post('species')
  @Operation({ operationId: 'createSpecies', ...WRITE, permission: 'mdm.species.create' })
  createSpecies(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(SpeciesCreate)) body: z.infer<typeof SpeciesCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SpeciesView> {
    return reply(res, this.admin.createSpecies(actor, body, key));
  }

  @Patch('species/:id')
  @Operation({ operationId: 'updateSpecies', ...WRITE, permission: 'mdm.species.update' })
  updateSpecies(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(SpeciesUpdate)) body: z.infer<typeof SpeciesUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SpeciesView> {
    return reply(res, this.admin.updateSpecies(actor, id, body, key));
  }

  @Get('grades')
  @Operation({ operationId: 'listGrades', ...READ, permission: 'mdm.grade.read' })
  listGrades(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(SpeciesPageQuery)) query: z.infer<typeof SpeciesPageQuery>): Promise<Page<GradeView>> {
    return this.admin.listGrades(actor, query.speciesId, query.cursor, query.limit);
  }

  @Post('grades')
  @Operation({ operationId: 'createGrade', ...WRITE, permission: 'mdm.grade.create' })
  createGrade(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(GradeCreate)) body: z.infer<typeof GradeCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GradeView> {
    return reply(res, this.admin.createGrade(actor, body, key));
  }

  @Patch('grades/:id')
  @Operation({ operationId: 'updateGrade', ...WRITE, permission: 'mdm.grade.update' })
  updateGrade(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(GradeUpdate)) body: z.infer<typeof GradeUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GradeView> {
    return reply(res, this.admin.updateGrade(actor, id, body, key));
  }

  @Post('grades/:id/archive')
  @Operation({ operationId: 'archiveGrade', ...WRITE, permission: 'mdm.grade.archive' })
  archiveGrade(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ArchiveBody)) body: z.infer<typeof ArchiveBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GradeView> {
    return reply(res, this.admin.archiveGrade(actor, id, body, key));
  }

  @Get('weight-bands')
  @Operation({ operationId: 'listWeightBands', ...READ, permission: 'mdm.weight_band.read' })
  listWeightBands(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(SpeciesPageQuery)) query: z.infer<typeof SpeciesPageQuery>): Promise<Page<WeightBandView>> {
    return this.admin.listWeightBands(actor, query.speciesId, query.cursor, query.limit);
  }

  @Post('weight-bands')
  @Operation({ operationId: 'createWeightBand', ...WRITE, permission: 'mdm.weight_band.create' })
  createWeightBand(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(WeightBandCreate)) body: z.infer<typeof WeightBandCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WeightBandView> {
    return reply(res, this.admin.createWeightBand(actor, body, key));
  }

  @Patch('weight-bands/:id')
  @Operation({ operationId: 'updateWeightBand', ...WRITE, permission: 'mdm.weight_band.update' })
  updateWeightBand(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(WeightBandUpdate)) body: z.infer<typeof WeightBandUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WeightBandView> {
    return reply(res, this.admin.updateWeightBand(actor, id, body, key));
  }

  @Post('weight-bands/:id/archive')
  @Operation({ operationId: 'archiveWeightBand', ...WRITE, permission: 'mdm.weight_band.archive' })
  archiveWeightBand(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ArchiveBody)) body: z.infer<typeof ArchiveBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WeightBandView> {
    return reply(res, this.admin.archiveWeightBand(actor, id, body, key));
  }
}
