import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { ChartOfAccounts, type AccountView } from '../application/chart';
import type { Page } from '../application/periods';
import { AccountCreate, AccountPageQuery, AccountUpdate, IdParam } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** The chart of accounts (FR-FIN-001, FR-FIN-002). Parses and delegates. */
@Controller('finance/accounts')
export class AccountsController {
  constructor(@Inject(ChartOfAccounts) private readonly chart: ChartOfAccounts) {}

  @Get()
  @Operation({ operationId: 'listAccounts', ...READ, permission: 'fin.account.read' })
  listAccounts(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(AccountPageQuery)) query: z.infer<typeof AccountPageQuery>): Promise<Page<AccountView>> {
    return this.chart.list(actor, query, query.cursor, query.limit);
  }

  @Post()
  @Operation({ operationId: 'createAccount', ...WRITE, permission: 'fin.account.manage' })
  createAccount(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(AccountCreate)) body: z.infer<typeof AccountCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountView> {
    return reply(res, this.chart.create(actor, body, key));
  }

  @Patch(':id')
  @Operation({ operationId: 'updateAccount', ...WRITE, permission: 'fin.account.manage' })
  updateAccount(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(AccountUpdate)) body: z.infer<typeof AccountUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountView> {
    return reply(res, this.chart.update(actor, id, body, key));
  }
}
