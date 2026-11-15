import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { GoodsReceipts, type GoodsReceiptView, type Page } from '../application/goods-receipts';
import { GoodsReceiptCreate, GoodsReceiptUpdate, IdParam, ListGoodsReceiptsQuery, ReasonBody } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Goods receipts (FR-INV-009). The controller parses and delegates; the handlers authorise and decide. */
@Controller()
export class GoodsReceiptsController {
  constructor(@Inject(GoodsReceipts) private readonly receipts: GoodsReceipts) {}

  @Get('goods-receipts')
  @Operation({ operationId: 'listGoodsReceipts', ...READ, permission: 'inv.goods_receipt.read' })
  list(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListGoodsReceiptsQuery)) query: z.infer<typeof ListGoodsReceiptsQuery>): Promise<Page<GoodsReceiptView>> {
    return this.receipts.list(actor, { status: query.status, supplierId: query.supplierId, purchaseOrderId: query.purchaseOrderId, from: query.from, to: query.to }, query.cursor, query.limit);
  }

  @Post('goods-receipts')
  @Operation({ operationId: 'createGoodsReceipt', ...WRITE, permission: 'inv.goods_receipt.create' })
  create(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(GoodsReceiptCreate)) body: z.infer<typeof GoodsReceiptCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GoodsReceiptView> {
    return reply(res, this.receipts.create(actor, body, key));
  }

  @Get('goods-receipts/:id')
  @Operation({ operationId: 'getGoodsReceipt', ...READ, permission: 'inv.goods_receipt.read' })
  get(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<GoodsReceiptView> {
    return this.receipts.get(actor, id);
  }

  @Patch('goods-receipts/:id')
  @Operation({ operationId: 'updateGoodsReceipt', ...WRITE, permission: 'inv.goods_receipt.create' })
  update(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(GoodsReceiptUpdate)) body: z.infer<typeof GoodsReceiptUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GoodsReceiptView> {
    return reply(res, this.receipts.update(actor, id, body, key));
  }

  @Post('goods-receipts/:id/post')
  @Operation({ operationId: 'postGoodsReceipt', ...WRITE, permission: 'inv.goods_receipt.post' })
  post(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GoodsReceiptView> {
    return reply(res, this.receipts.post(actor, id, key));
  }

  @Post('goods-receipts/:id/cancel')
  @Operation({ operationId: 'cancelGoodsReceipt', ...WRITE, permission: 'inv.goods_receipt.create' })
  cancel(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GoodsReceiptView> {
    return reply(res, this.receipts.cancel(actor, id, body, key));
  }
}
