import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { FixedAssets, type DepreciationRunView, type FixedAssetView } from '../application/fixed-assets';
import type { Page } from '../application/periods';
import { DepreciationRunCreate, DepreciationRunPageQuery, FixedAssetCreate, FixedAssetDisposal, FixedAssetPageQuery, FixedAssetUpdate, IdParam } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** The fixed asset register and its disposal (FR-FIN-014, ADR-0059). Parses and delegates. */
@Controller('finance/fixed-assets')
export class FixedAssetsController {
  constructor(@Inject(FixedAssets) private readonly assets: FixedAssets) {}

  @Get()
  @Operation({ operationId: 'listFixedAssets', ...READ, permission: 'fin.fixed_asset.read' })
  listFixedAssets(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(FixedAssetPageQuery)) query: z.infer<typeof FixedAssetPageQuery>): Promise<Page<FixedAssetView>> {
    return this.assets.list(actor, query, query.cursor, query.limit);
  }

  @Post()
  @Operation({ operationId: 'createFixedAsset', ...WRITE, permission: 'fin.fixed_asset.manage' })
  createFixedAsset(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(FixedAssetCreate)) body: z.infer<typeof FixedAssetCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FixedAssetView> {
    return reply(res, this.assets.create(actor, body, key));
  }

  @Get(':id')
  @Operation({ operationId: 'getFixedAsset', ...READ, permission: 'fin.fixed_asset.read' })
  getFixedAsset(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<FixedAssetView> {
    return this.assets.get(actor, id);
  }

  @Patch(':id')
  @Operation({ operationId: 'updateFixedAsset', ...WRITE, permission: 'fin.fixed_asset.manage' })
  updateFixedAsset(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(FixedAssetUpdate)) body: z.infer<typeof FixedAssetUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FixedAssetView> {
    return reply(res, this.assets.update(actor, id, body, key));
  }

  @Post(':id/dispose')
  @Operation({ operationId: 'disposeFixedAsset', ...WRITE, permission: 'fin.fixed_asset.manage' })
  disposeFixedAsset(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(FixedAssetDisposal)) body: z.infer<typeof FixedAssetDisposal>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FixedAssetView> {
    return reply(res, this.assets.dispose(actor, id, body, key));
  }
}

/** Depreciation runs (FR-FIN-015, ADR-0059): calculated by one person, posted by another. Parses and delegates. */
@Controller('finance/depreciation-runs')
export class DepreciationRunsController {
  constructor(@Inject(FixedAssets) private readonly assets: FixedAssets) {}

  @Get()
  @Operation({ operationId: 'listDepreciationRuns', ...READ, permission: 'fin.fixed_asset.read' })
  listDepreciationRuns(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(DepreciationRunPageQuery)) query: z.infer<typeof DepreciationRunPageQuery>): Promise<Page<DepreciationRunView>> {
    return this.assets.listRuns(actor, query.cursor, query.limit);
  }

  @Post()
  @Operation({ operationId: 'createDepreciationRun', ...WRITE, permission: 'fin.fixed_asset.manage' })
  createDepreciationRun(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(DepreciationRunCreate)) body: z.infer<typeof DepreciationRunCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DepreciationRunView> {
    return reply(res, this.assets.createRun(actor, body, key));
  }

  @Get(':id')
  @Operation({ operationId: 'getDepreciationRun', ...READ, permission: 'fin.fixed_asset.read' })
  getDepreciationRun(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<DepreciationRunView> {
    return this.assets.getRun(actor, id);
  }

  @Post(':id/post')
  @Operation({ operationId: 'postDepreciationRun', ...WRITE, permission: 'fin.fixed_asset.manage' })
  postDepreciationRun(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DepreciationRunView> {
    return reply(res, this.assets.postRun(actor, id, key));
  }
}
