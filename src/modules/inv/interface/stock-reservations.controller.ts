import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { Page } from '../application/stock-command';
import { Reservations, type StockReservationView } from '../application/reservations';
import { IdParam, ListStockReservationsQuery, ReasonBody } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/** Stock reservations (FR-INV-021): the list and a release by hand. Reserving is in process only. Parses and delegates. */
@Controller('stock/reservations')
export class StockReservationsController {
  constructor(@Inject(Reservations) private readonly reservations: Reservations) {}

  @Get()
  @Operation({ operationId: 'listStockReservations', ...READ, permission: 'inv.reservation.read' })
  list(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListStockReservationsQuery)) query: z.infer<typeof ListStockReservationsQuery>): Promise<Page<StockReservationView>> {
    const { cursor, limit, ...filters } = query;
    return this.reservations.list(actor, filters, cursor, limit);
  }

  @Post(':id/release')
  @Operation({ operationId: 'releaseStockReservation', ...WRITE, permission: 'inv.reservation.release' })
  async release(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockReservationView> {
    const response = await this.reservations.release(actor, id, body, key);
    res.status(response.status);
    return response.body;
  }
}
