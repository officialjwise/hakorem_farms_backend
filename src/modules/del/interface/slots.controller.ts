import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { Slots, type DeliverySlotView, type Page } from '../application/slots';
import { DeliverySlotPageQuery, IdParam, SlotGenerate, SlotUpdate } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Delivery slots for the back office (FR-DEL-001 without its capacity rule, B07 continued 2). Parses and delegates. */
@Controller('delivery-slots')
export class SlotsController {
  constructor(@Inject(Slots) private readonly slots: Slots) {}

  @Get()
  @Operation({ operationId: 'listDeliverySlots', ...READ, permission: 'del.slot.read' })
  listDeliverySlots(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(DeliverySlotPageQuery)) query: z.infer<typeof DeliverySlotPageQuery>): Promise<Page<DeliverySlotView>> {
    return this.slots.list(actor, query, query.cursor, query.limit);
  }

  @Post('generate')
  @Operation({ operationId: 'generateDeliverySlots', ...WRITE, permission: 'del.slot.manage' })
  generateDeliverySlots(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(SlotGenerate)) body: z.infer<typeof SlotGenerate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ readonly created: number; readonly skippedExisting: number }> {
    return reply(res, this.slots.generate(actor, body, key));
  }

  @Patch(':id')
  @Operation({ operationId: 'updateDeliverySlot', ...WRITE, permission: 'del.slot.manage' })
  updateDeliverySlot(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(SlotUpdate)) body: z.infer<typeof SlotUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliverySlotView> {
    return reply(res, this.slots.update(actor, id, body, key));
  }
}
