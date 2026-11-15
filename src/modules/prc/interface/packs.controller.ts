import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { Packs, type PackLabelSheetView, type PackView } from '../application/packs';
import { IdParam, LabelPrintRequest, PacksCreate, PageQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Packs and their labels (FR-PRC-009, FR-PRC-010). The controller parses and delegates; the handler authorises and decides. */
@Controller('processing-orders/:id')
export class PacksController {
  constructor(@Inject(Packs) private readonly packs: Packs) {}

  @Get('packs')
  @Operation({ operationId: 'listPacks', ...READ, permission: 'prc.order.read' })
  listPacks(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>,
  ): Promise<{ data: readonly PackView[]; page: { nextCursor: string | null; limit: number; hasMore: boolean } }> {
    return this.packs.list(actor, id, query.cursor, query.limit);
  }

  @Post('packs')
  @Operation({ operationId: 'createPacks', ...WRITE, permission: 'prc.order.process' })
  createPacks(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PacksCreate)) body: z.infer<typeof PacksCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ packs: PackView[] }> {
    return reply(res, this.packs.create(actor, id, body, key));
  }

  @Post('labels')
  @Operation({ operationId: 'printPackLabels', ...WRITE, permission: 'prc.order.process' })
  printPackLabels(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(LabelPrintRequest)) body: z.infer<typeof LabelPrintRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PackLabelSheetView> {
    return reply(res, this.packs.print(actor, id, body, key));
  }
}
