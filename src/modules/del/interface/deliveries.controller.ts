import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { Deliveries, type DeliveryView, type DriverSyncResultView, type Page } from '../application/deliveries';
import { DeliveryFailure, DeliveryPageQuery, DriverSyncBatch, IdParam, OnTheWay, ProofOfDeliveryCreate } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/** Deliveries for the back office (FR-DEL-003, FR-DEL-004). Parses and delegates. */
@Controller('deliveries')
export class DeliveriesController {
  constructor(@Inject(Deliveries) private readonly deliveries: Deliveries) {}

  @Get()
  @Operation({ operationId: 'listDeliveries', ...READ, permission: 'del.delivery.read' })
  listDeliveries(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(DeliveryPageQuery)) query: z.infer<typeof DeliveryPageQuery>): Promise<Page<DeliveryView>> {
    return this.deliveries.list(
      actor,
      { status: query.status ?? null, driverId: query.driverId ?? null, orderId: query.orderId ?? null, zoneId: query.zoneId ?? null, date: query.date ?? null },
      query.cursor,
      query.limit,
    );
  }

  @Get(':id')
  @Operation({ operationId: 'getDelivery', ...READ, permission: 'del.delivery.read' })
  getDelivery(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<DeliveryView> {
    return this.deliveries.get(actor, id);
  }
}

/** The driver's own deliveries (FR-DEL-004, FR-DEL-008, FR-DEL-009). Parses and delegates. */
@Controller('driver/deliveries')
export class DriverDeliveriesController {
  constructor(@Inject(Deliveries) private readonly deliveries: Deliveries) {}

  @Get(':id')
  @Operation({ operationId: 'getMyDelivery', ...READ, permission: 'del.delivery.read.assigned' })
  getMyDelivery(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<DeliveryView> {
    return this.deliveries.getMine(actor, id);
  }

  @Post(':id/proof')
  @Operation({ operationId: 'recordProofOfDelivery', ...WRITE, permission: 'del.proof.create' })
  async recordProofOfDelivery(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ProofOfDeliveryCreate)) body: z.infer<typeof ProofOfDeliveryCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryView> {
    const response = await this.deliveries.recordProof(actor, id, { ...body, codCollectedPesewas: BigInt(body.codCollectedPesewas), capturedAt: new Date(body.capturedAt) }, key);
    res.status(response.status);
    return response.body;
  }

  @Post(':id/on-the-way')
  @Operation({ operationId: 'markOnTheWay', ...WRITE, permission: 'del.delivery.update.assigned' })
  async markOnTheWay(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(OnTheWay)) body: z.infer<typeof OnTheWay>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryView> {
    const response = await this.deliveries.markOnTheWay(actor, id, { occurredAt: new Date(body.occurredAt), etaMinutes: body.etaMinutes }, key);
    res.status(response.status);
    return response.body;
  }

  @Post(':id/fail')
  @Operation({ operationId: 'recordFailedDelivery', ...WRITE, permission: 'del.delivery.update.assigned' })
  async recordFailedDelivery(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(DeliveryFailure)) body: z.infer<typeof DeliveryFailure>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryView> {
    const response = await this.deliveries.recordFailure(actor, id, { ...body, occurredAt: new Date(body.occurredAt) }, key);
    res.status(response.status);
    return response.body;
  }
}

/** The driver's offline queue (CR-057 point 3): exactly once per record by its client id, so no `Idempotency-Key`. */
@Controller('driver/sync')
export class DriverSyncController {
  constructor(@Inject(Deliveries) private readonly deliveries: Deliveries) {}

  @Post()
  @HttpCode(200)
  @Operation({ operationId: 'syncDriverEvents', access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: true, rateLimit: 'console', permission: 'del.proof.create' })
  syncDriverEvents(@CurrentActor() actor: Actor | undefined, @Body(zodPipe(DriverSyncBatch)) body: z.infer<typeof DriverSyncBatch>): Promise<DriverSyncResultView> {
    return this.deliveries.sync(actor, {
      proofs: body.proofs.map((p) => ({ deliveryId: p.deliveryId, proof: { ...p.proof, codCollectedPesewas: BigInt(p.proof.codCollectedPesewas), capturedAt: new Date(p.proof.capturedAt) } })),
      failures: body.failures.map((f) => ({ deliveryId: f.deliveryId, failure: { ...f.failure, occurredAt: new Date(f.failure.occurredAt) } })),
    });
  }
}
