import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { StockAdjustments, type StockAdjustmentView } from '../application/stock-adjustments';
import type { ApprovalPendingView, Page, StockMovementView } from '../application/stock-command';
import type { MovementTypeRecord } from '../application/stock-documents-store';
import { StockMovements } from '../application/stock-movements';
import { StockTransfers, type StockTransferView } from '../application/stock-transfers';
import {
  IdParam,
  ListStockAdjustmentsQuery,
  ListStockMovementsQuery,
  ListStockTransfersQuery,
  MovementReversal,
  PageQuery,
  ReasonBody,
  StockAdjustmentCreate,
  StockTransferCreate,
  TransferReceive,
} from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Movements and their reversal, transfers and adjustments (FR-INV-001 to FR-INV-004, FR-INV-010 to FR-INV-012). Parses and delegates. */
@Controller()
export class StockControlController {
  constructor(
    @Inject(StockMovements) private readonly movements: StockMovements,
    @Inject(StockTransfers) private readonly transfers: StockTransfers,
    @Inject(StockAdjustments) private readonly adjustments: StockAdjustments,
  ) {}

  @Get('stock/movement-types')
  @Operation({ operationId: 'listMovementTypes', ...READ, permission: 'inv.stock.read' })
  listMovementTypes(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<MovementTypeRecord>> {
    return this.movements.listTypes(actor, query.cursor, query.limit);
  }

  @Get('stock/movements')
  @Operation({ operationId: 'listStockMovements', ...READ, permission: 'inv.movement.read' })
  listMovements(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListStockMovementsQuery)) query: z.infer<typeof ListStockMovementsQuery>): Promise<Page<StockMovementView>> {
    const { cursor, limit, ...filters } = query;
    return this.movements.list(actor, filters, cursor, limit);
  }

  @Get('stock/movements/:id')
  @Operation({ operationId: 'getStockMovement', ...READ, permission: 'inv.movement.read' })
  getMovement(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StockMovementView> {
    return this.movements.get(actor, id);
  }

  @Post('stock/movements/:id/reverse')
  @Operation({ operationId: 'reverseStockMovement', ...WRITE, permission: 'inv.movement.reverse' })
  reverse(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(MovementReversal)) body: z.infer<typeof MovementReversal>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockMovementView | ApprovalPendingView> {
    return reply(res, this.movements.reverse(actor, id, body, key));
  }

  @Get('stock-units/:id/movements')
  @Operation({ operationId: 'listStockUnitMovements', ...READ, permission: 'inv.movement.read' })
  listUnitMovements(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<StockMovementView>> {
    return this.movements.listForUnit(actor, id, query.cursor, query.limit);
  }

  @Get('stock-transfers')
  @Operation({ operationId: 'listStockTransfers', ...READ, permission: 'inv.transfer.read' })
  listTransfers(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListStockTransfersQuery)) query: z.infer<typeof ListStockTransfersQuery>): Promise<Page<StockTransferView>> {
    const { cursor, limit, ...filters } = query;
    return this.transfers.list(actor, filters, cursor, limit);
  }

  @Post('stock-transfers')
  @Operation({ operationId: 'createStockTransfer', ...WRITE, permission: 'inv.transfer.create' })
  createTransfer(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(StockTransferCreate)) body: z.infer<typeof StockTransferCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockTransferView> {
    return reply(res, this.transfers.create(actor, body, key));
  }

  @Get('stock-transfers/:id')
  @Operation({ operationId: 'getStockTransfer', ...READ, permission: 'inv.transfer.read' })
  getTransfer(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StockTransferView> {
    return this.transfers.get(actor, id);
  }

  @Post('stock-transfers/:id/dispatch')
  @Operation({ operationId: 'dispatchStockTransfer', ...WRITE, permission: 'inv.transfer.dispatch' })
  dispatch(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<StockTransferView> {
    return reply(res, this.transfers.dispatch(actor, id, key));
  }

  @Post('stock-transfers/:id/receive')
  @Operation({ operationId: 'receiveStockTransfer', ...WRITE, permission: 'inv.transfer.receive' })
  receive(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(TransferReceive)) body: z.infer<typeof TransferReceive>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockTransferView> {
    return reply(res, this.transfers.receive(actor, id, body, key));
  }

  @Post('stock-transfers/:id/cancel')
  @Operation({ operationId: 'cancelStockTransfer', ...WRITE, permission: 'inv.transfer.create' })
  cancelTransfer(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockTransferView> {
    return reply(res, this.transfers.cancel(actor, id, body, key));
  }

  @Get('stock-adjustments')
  @Operation({ operationId: 'listStockAdjustments', ...READ, permission: 'inv.adjustment.read' })
  listAdjustments(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListStockAdjustmentsQuery)) query: z.infer<typeof ListStockAdjustmentsQuery>): Promise<Page<StockAdjustmentView>> {
    const { cursor, limit, ...filters } = query;
    return this.adjustments.list(actor, filters, cursor, limit);
  }

  @Post('stock-adjustments')
  @Operation({ operationId: 'createStockAdjustment', ...WRITE, permission: 'inv.adjustment.create' })
  createAdjustment(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(StockAdjustmentCreate)) body: z.infer<typeof StockAdjustmentCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockAdjustmentView> {
    return reply(res, this.adjustments.create(actor, body, key));
  }

  @Get('stock-adjustments/:id')
  @Operation({ operationId: 'getStockAdjustment', ...READ, permission: 'inv.adjustment.read' })
  getAdjustment(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StockAdjustmentView> {
    return this.adjustments.get(actor, id);
  }

  @Post('stock-adjustments/:id/submit')
  @Operation({ operationId: 'submitStockAdjustment', ...WRITE, permission: 'inv.adjustment.create' })
  submitAdjustment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockAdjustmentView | ApprovalPendingView> {
    return reply(res, this.adjustments.submit(actor, id, key));
  }
}
