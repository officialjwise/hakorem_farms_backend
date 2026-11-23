import { Body, Controller, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { DeliveryView } from '../application/deliveries';
import { Scheduling } from '../application/scheduling';
import { DeliveryAssign, DeliveryReschedule, IdParam } from './schemas';

const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/** A delivery's driver, vehicle and slot after dispatch (FR-DEL-001 to FR-DEL-004, FR-DEL-011, A-362). Parses and delegates. */
@Controller('deliveries')
export class SchedulingController {
  constructor(@Inject(Scheduling) private readonly scheduling: Scheduling) {}

  @Post(':id/assign')
  @Operation({ operationId: 'assignDelivery', ...WRITE, permission: 'del.delivery.assign' })
  async assignDelivery(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(DeliveryAssign)) body: z.infer<typeof DeliveryAssign>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryView> {
    const response = await this.scheduling.assign(actor, id, body, key);
    res.status(response.status);
    return response.body;
  }

  @Post(':id/reschedule')
  @Operation({ operationId: 'rescheduleDelivery', ...WRITE, permission: 'del.delivery.assign' })
  async rescheduleDelivery(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(DeliveryReschedule)) body: z.infer<typeof DeliveryReschedule>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryView> {
    const response = await this.scheduling.reschedule(actor, id, body, key);
    res.status(response.status);
    return response.body;
  }
}
