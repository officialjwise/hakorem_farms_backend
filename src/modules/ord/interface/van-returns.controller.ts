import { Body, Controller, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { DeliveryView } from '../../del';
import type { ApprovalPendingView } from '../application/order-reversals';
import { VanReturns } from '../application/van-returns';
import { DeliveryCancelBody, DeliveryWriteOffBody, IdParam, ReturnToStockBody } from './schemas';

const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/** The van's two other ways out (FR-DEL-011, A-360): ORD's, under the deliveries' paths. Parses and delegates. */
@Controller('deliveries')
export class VanReturnsController {
  constructor(@Inject(VanReturns) private readonly vanReturns: VanReturns) {}

  @Post(':id/return-to-stock')
  @Operation({ operationId: 'returnDeliveryToStock', ...WRITE, permission: 'del.delivery.return' })
  async returnDeliveryToStock(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReturnToStockBody)) body: z.infer<typeof ReturnToStockBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryView> {
    const response = await this.vanReturns.returnToStock(actor, id, { returnsLocationId: body.returnsLocationId, note: body.note, refundDestination: body.refundDestination ?? 'ORIGINAL_METHOD' }, key);
    res.status(response.status);
    return response.body;
  }

  @Post(':id/write-off')
  @Operation({ operationId: 'writeOffDelivery', ...WRITE, permission: 'del.delivery.write_off' })
  async writeOffDelivery(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(DeliveryWriteOffBody)) body: z.infer<typeof DeliveryWriteOffBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryView | ApprovalPendingView> {
    const response = await this.vanReturns.writeOff(actor, id, { reasonCode: body.reasonCode, note: body.note ?? null, refundDestination: body.refundDestination ?? 'ORIGINAL_METHOD' }, key);
    res.status(response.status);
    return response.body;
  }

  @Post(':id/cancel')
  @Operation({ operationId: 'cancelDelivery', ...WRITE, permission: 'del.delivery.assign' })
  async cancelDelivery(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(DeliveryCancelBody)) body: z.infer<typeof DeliveryCancelBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryView> {
    const response = await this.vanReturns.cancel(actor, id, { reasonCode: body.reasonCode, note: body.note ?? null, returnsLocationId: body.returnsLocationId, refundDestination: body.refundDestination ?? 'ORIGINAL_METHOD' }, key);
    res.status(response.status);
    return response.body;
  }
}
