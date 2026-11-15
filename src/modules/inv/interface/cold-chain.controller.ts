import { Body, Controller, Get, Inject, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { ColdChain, type TemperatureReadingView } from '../application/cold-chain';
import type { Page } from '../application/stock-command';
import { ListTemperatureReadingsQuery, TemperatureReadingCreate } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/** The cold chain log, whose excursions quarantine what is in the room (FR-INV-007, FR-INV-008). Parses and delegates. */
@Controller('temperature-readings')
export class ColdChainController {
  constructor(@Inject(ColdChain) private readonly coldChain: ColdChain) {}

  @Get()
  @Operation({ operationId: 'listTemperatureReadings', ...READ, permission: 'inv.cold_chain.read' })
  list(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListTemperatureReadingsQuery)) query: z.infer<typeof ListTemperatureReadingsQuery>): Promise<Page<TemperatureReadingView>> {
    const { cursor, limit, ...filters } = query;
    return this.coldChain.list(actor, filters, cursor, limit);
  }

  @Post()
  @Operation({ operationId: 'recordTemperatureReading', ...WRITE, permission: 'inv.cold_chain.record' })
  async record(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(TemperatureReadingCreate)) body: z.infer<typeof TemperatureReadingCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TemperatureReadingView> {
    const response = await this.coldChain.record(actor, body, key);
    res.status(response.status);
    return response.body;
  }
}
