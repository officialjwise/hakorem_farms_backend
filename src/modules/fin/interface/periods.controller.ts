import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { Periods, type AccountingPeriodView, type Page, type ReopenPendingView } from '../application/periods';
import { IdParam, PeriodPageQuery, ReasonRequest } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Accounting periods: list, lock, close and reopen (FR-FIN-009, FR-FIN-010). Parses and delegates. */
@Controller('finance/periods')
export class PeriodsController {
  constructor(@Inject(Periods) private readonly periods: Periods) {}

  @Get()
  @Operation({ operationId: 'listAccountingPeriods', ...READ, permission: 'fin.period.read' })
  listAccountingPeriods(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PeriodPageQuery)) query: z.infer<typeof PeriodPageQuery>): Promise<Page<AccountingPeriodView>> {
    return this.periods.list(actor, query, query.cursor, query.limit);
  }

  @Post(':id/lock')
  @Operation({ operationId: 'lockAccountingPeriod', ...WRITE, permission: 'fin.period.lock' })
  lockAccountingPeriod(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountingPeriodView> {
    return reply(res, this.periods.lock(actor, id, key));
  }

  @Post(':id/reopen')
  @Operation({ operationId: 'reopenAccountingPeriod', ...WRITE, permission: 'fin.period.reopen' })
  reopenAccountingPeriod(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReopenPendingView> {
    return reply(res, this.periods.requestReopen(actor, id, body.reason, key));
  }

  @Post(':id/close')
  @Operation({ operationId: 'closeAccountingPeriod', ...WRITE, permission: 'fin.period.close' })
  closeAccountingPeriod(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountingPeriodView> {
    return reply(res, this.periods.close(actor, id, key));
  }
}
