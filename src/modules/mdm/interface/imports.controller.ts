import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { MdmImports, type ImportJobView, type ImportRowErrorView } from '../application/imports';
import type { Page } from '../application/product-catalogue';
import { ExportCreate, IdParam, ImportCreate, ListImportJobsQuery, PageQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Master data imports and exports (FR-MDM-019, FR-MDM-020). The handlers authorise and decide. */
@Controller()
export class ImportsController {
  constructor(@Inject(MdmImports) private readonly imports: MdmImports) {}

  @Get('imports')
  @Operation({ operationId: 'listImportJobs', ...READ, permission: 'mdm.import.read' })
  listImportJobs(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListImportJobsQuery)) query: z.infer<typeof ListImportJobsQuery>): Promise<Page<ImportJobView>> {
    return this.imports.list(actor, { entity: query.entity, direction: query.direction }, query.cursor, query.limit);
  }

  @Post('imports')
  @Operation({ operationId: 'createImportJob', ...WRITE, permission: 'mdm.import.create' })
  createImportJob(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(ImportCreate)) body: z.infer<typeof ImportCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ImportJobView> {
    return reply(res, this.imports.create(actor, body, key));
  }

  @Get('imports/:id')
  @Operation({ operationId: 'getImportJob', ...READ, permission: 'mdm.import.read' })
  getImportJob(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<ImportJobView> {
    return this.imports.get(actor, id);
  }

  @Get('imports/:id/errors')
  @Operation({ operationId: 'listImportErrors', ...READ, permission: 'mdm.import.read' })
  listImportErrors(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<ImportRowErrorView>> {
    return this.imports.errors(actor, id, query.cursor, query.limit);
  }

  @Post('imports/:id/apply')
  @Operation({ operationId: 'applyImportJob', ...WRITE, permission: 'mdm.import.apply' })
  applyImportJob(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<ImportJobView> {
    return reply(res, this.imports.apply(actor, id, key));
  }

  @Post('imports/:id/cancel')
  @Operation({ operationId: 'cancelImportJob', ...WRITE, permission: 'mdm.import.create' })
  cancelImportJob(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<ImportJobView> {
    return reply(res, this.imports.cancel(actor, id, key));
  }

  @Post('exports')
  @Operation({ operationId: 'createExportJob', ...WRITE, permission: 'mdm.export.create' })
  createExportJob(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(ExportCreate)) body: z.infer<typeof ExportCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ImportJobView> {
    return reply(res, this.imports.export(actor, body, key));
  }
}
