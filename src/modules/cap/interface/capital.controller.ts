import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { Capital, type ApprovalPendingView, type CapitalRegisterView, type CapitalTransactionView, type InvestorView, type Page } from '../application/capital';
import { CapitalTransactionCreate, CapitalTransactionPageQuery, IdParam, InvestorCreate, InvestorPageQuery, InvestorUpdate, RegisterQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** The investor register and capital (FR-CAP-001, FR-CAP-003 to FR-CAP-005). The handlers authorise. */
@Controller()
export class CapitalController {
  constructor(@Inject(Capital) private readonly capital: Capital) {}

  @Get('investors')
  @Operation({ operationId: 'listInvestors', ...READ, permission: 'cap.investor.read' })
  listInvestors(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(InvestorPageQuery)) q: z.infer<typeof InvestorPageQuery>): Promise<Page<InvestorView>> {
    return this.capital.listInvestors(actor, { status: q.status ?? null }, q.cursor, q.limit);
  }

  @Post('investors')
  @Operation({ operationId: 'createInvestor', ...WRITE, permission: 'cap.investor.manage' })
  createInvestor(@CurrentActor() actor: Actor | undefined, @Body(zodPipe(InvestorCreate)) body: z.infer<typeof InvestorCreate>, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<InvestorView> {
    return reply(res, this.capital.createInvestor(actor, body, key));
  }

  @Get('investors/:id')
  @Operation({ operationId: 'getInvestor', ...READ, permission: 'cap.investor.read' })
  getInvestor(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<InvestorView> {
    return this.capital.getInvestor(actor, id);
  }

  @Patch('investors/:id')
  @Operation({ operationId: 'updateInvestor', ...WRITE, permission: 'cap.investor.manage' })
  updateInvestor(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(InvestorUpdate)) body: z.infer<typeof InvestorUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvestorView> {
    return reply(res, this.capital.updateInvestor(actor, id, body, key));
  }

  @Get('capital-transactions')
  @Operation({ operationId: 'listCapitalTransactions', ...READ, permission: 'cap.capital.read' })
  listCapitalTransactions(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(CapitalTransactionPageQuery)) q: z.infer<typeof CapitalTransactionPageQuery>): Promise<Page<CapitalTransactionView>> {
    return this.capital.listTransactions(actor, { investorId: q.investorId ?? null, kind: q.kind ?? null, from: q.from ?? null, to: q.to ?? null }, q.cursor, q.limit);
  }

  @Post('capital-transactions')
  @Operation({ operationId: 'recordCapitalTransaction', ...WRITE, permission: 'cap.capital.record' })
  recordCapitalTransaction(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(CapitalTransactionCreate)) body: z.infer<typeof CapitalTransactionCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CapitalTransactionView | ApprovalPendingView> {
    return reply(res, this.capital.record(actor, body, key));
  }

  @Get('capital-transactions/:id')
  @Operation({ operationId: 'getCapitalTransaction', ...READ, permission: 'cap.capital.read' })
  getCapitalTransaction(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<CapitalTransactionView> {
    return this.capital.getTransaction(actor, id);
  }

  @Get('capital/register')
  @Operation({ operationId: 'getCapitalRegister', ...READ, permission: 'cap.capital.read' })
  getCapitalRegister(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(RegisterQuery)) q: z.infer<typeof RegisterQuery>): Promise<CapitalRegisterView> {
    return this.capital.register(actor, q.asOf ?? null, q.cursor, q.limit);
  }
}
