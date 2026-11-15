import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { Page } from '../application/product-catalogue';
import { UomConversions, type UomConversionView } from '../application/uom-conversions';
import { ArchiveBody, IdParam, UomConversionCreate, UomConversionPageQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/**
 * A product's alternative units (FR-MDM-003, CR-011, B06u). The controller parses and delegates; the handlers authorise,
 * judge the factor and decide the status.
 */
@Controller('uom-conversions')
export class UomConversionsController {
  constructor(@Inject(UomConversions) private readonly conversions: UomConversions) {}

  @Get()
  @Operation({ operationId: 'listUomConversions', ...READ, permission: 'mdm.product.read' })
  listUomConversions(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(UomConversionPageQuery)) query: z.infer<typeof UomConversionPageQuery>): Promise<Page<UomConversionView>> {
    return this.conversions.list(actor, { productId: query.productId, includeArchived: query.includeArchived }, query.cursor, query.limit);
  }

  @Post()
  @Operation({ operationId: 'createUomConversion', ...WRITE, permission: 'mdm.uom_conversion.create' })
  async createUomConversion(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(UomConversionCreate)) body: z.infer<typeof UomConversionCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UomConversionView> {
    const response = await this.conversions.create(actor, body, key);
    res.status(response.status);
    return response.body;
  }

  @Post(':id/archive')
  @Operation({ operationId: 'archiveUomConversion', ...WRITE, permission: 'mdm.uom_conversion.archive' })
  async archiveUomConversion(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ArchiveBody)) body: z.infer<typeof ArchiveBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UomConversionView> {
    const response = await this.conversions.archive(actor, id, body, key);
    res.status(response.status);
    return response.body;
  }
}
