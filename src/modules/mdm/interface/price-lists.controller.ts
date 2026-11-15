import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { PriceListAdmin, type ApprovalPendingView, type PriceListEntryView, type PriceListVersionView, type PriceListView } from '../application/price-lists';
import type { Page } from '../application/product-catalogue';
import { ArchiveBody, IdParam, ListPriceListEntriesQuery, ListPriceListsQuery, PageQuery, PriceListCreate, PriceListEntriesReplace, PriceListUpdate, PriceListVersionCreate } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/**
 * Price lists and their versions (FR-MDM-015). The controller parses and delegates; the handler authorises, does
 * the work and decides the status: 201 on create, 200 on replace, 202 `ApprovalPending` on submit.
 */
@Controller()
export class PriceListsController {
  constructor(@Inject(PriceListAdmin) private readonly admin: PriceListAdmin) {}

  @Post('price-lists')
  @Operation({ operationId: 'createPriceList', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.price_list.create', idempotent: true, csrf: true, rateLimit: 'console' })
  async createPriceList(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(PriceListCreate)) body: z.infer<typeof PriceListCreate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PriceListView> {
    const response = await this.admin.createList(actor, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Get('price-lists/:id')
  @Operation({ operationId: 'getPriceList', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.price_list.read', idempotent: false, csrf: false, rateLimit: 'console' })
  getPriceList(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<PriceListView> {
    return this.admin.getList(actor, id);
  }

  @Post('price-lists/:id/versions')
  @Operation({ operationId: 'createPriceListVersion', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.price_list.update', idempotent: true, csrf: true, rateLimit: 'console' })
  async createPriceListVersion(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PriceListVersionCreate)) body: z.infer<typeof PriceListVersionCreate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PriceListVersionView> {
    const response = await this.admin.createVersion(actor, id, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Get('price-list-versions/:id')
  @Operation({ operationId: 'getPriceListVersion', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.price_list.read', idempotent: false, csrf: false, rateLimit: 'console' })
  getPriceListVersion(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<PriceListVersionView> {
    return this.admin.getVersion(actor, id);
  }

  @Put('price-list-versions/:id/entries')
  @Operation({ operationId: 'replacePriceListEntries', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.price_list.update', idempotent: true, csrf: true, rateLimit: 'console' })
  async replacePriceListEntries(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PriceListEntriesReplace)) body: z.infer<typeof PriceListEntriesReplace>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PriceListVersionView> {
    const response = await this.admin.replaceEntries(actor, id, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Post('price-list-versions/:id/submit')
  @Operation({ operationId: 'submitPriceListVersion', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.price_list.update', idempotent: true, csrf: true, rateLimit: 'console' })
  async submitPriceListVersion(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalPendingView> {
    const response = await this.admin.submit(actor, id, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Get('price-lists')
  @Operation({ operationId: 'listPriceLists', ...READ, permission: 'mdm.price_list.read' })
  listPriceLists(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListPriceListsQuery)) query: z.infer<typeof ListPriceListsQuery>): Promise<Page<PriceListView>> {
    return this.admin.listLists(actor, { kind: query.kind, channel: query.channel }, query.cursor, query.limit);
  }

  @Patch('price-lists/:id')
  @Operation({ operationId: 'updatePriceList', ...WRITE, permission: 'mdm.price_list.update' })
  async updatePriceList(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PriceListUpdate)) body: z.infer<typeof PriceListUpdate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PriceListView> {
    const response = await this.admin.updateList(actor, id, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Post('price-lists/:id/archive')
  @Operation({ operationId: 'archivePriceList', ...WRITE, permission: 'mdm.price_list.archive' })
  async archivePriceList(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ArchiveBody)) body: z.infer<typeof ArchiveBody>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PriceListView> {
    const response = await this.admin.archiveList(actor, id, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Get('price-lists/:id/versions')
  @Operation({ operationId: 'listPriceListVersions', ...READ, permission: 'mdm.price_list.read' })
  listPriceListVersions(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>,
  ): Promise<Page<PriceListVersionView>> {
    return this.admin.listVersions(actor, id, query.cursor, query.limit);
  }

  @Get('price-list-versions/:id/entries')
  @Operation({ operationId: 'listPriceListEntries', ...READ, permission: 'mdm.price_list.read' })
  listPriceListEntries(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Query(zodPipe(ListPriceListEntriesQuery)) query: z.infer<typeof ListPriceListEntriesQuery>,
  ): Promise<Page<PriceListEntryView>> {
    return this.admin.listEntries(actor, id, query.productId, query.cursor, query.limit);
  }
}
