import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { BankAccounts, type BankAccountView } from '../application/bank-accounts';
import type { Page } from '../application/periods';
import { BankAccountCreate, BankAccountPageQuery, BankAccountUpdate, IdParam } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** The business's bank accounts and wallets (ADR-0057, A-194). Parses and delegates. */
@Controller('finance/bank-accounts')
export class BankAccountsController {
  constructor(@Inject(BankAccounts) private readonly accounts: BankAccounts) {}

  @Get()
  @Operation({ operationId: 'listBankAccounts', ...READ, permission: 'fin.bank_account.read' })
  listBankAccounts(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(BankAccountPageQuery)) query: z.infer<typeof BankAccountPageQuery>): Promise<Page<BankAccountView>> {
    return this.accounts.list(actor, query.cursor, query.limit);
  }

  @Post()
  @Operation({ operationId: 'createBankAccount', ...WRITE, permission: 'fin.bank_account.manage' })
  createBankAccount(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(BankAccountCreate)) body: z.infer<typeof BankAccountCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BankAccountView> {
    return reply(res, this.accounts.create(actor, body, key));
  }

  @Patch(':id')
  @Operation({ operationId: 'updateBankAccount', ...WRITE, permission: 'fin.bank_account.manage' })
  updateBankAccount(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(BankAccountUpdate)) body: z.infer<typeof BankAccountUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BankAccountView> {
    return reply(res, this.accounts.update(actor, id, body, key));
  }
}
