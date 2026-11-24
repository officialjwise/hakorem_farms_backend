import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Page } from '../application/capital';
import { Financing, type FinancingView } from '../application/financing';
import { InvestorProfiles, type InvestorDocumentView, type InvestorPayoutDetailsView } from '../application/investor-profiles';
import { InvestorReturns, type InvestorReturnsView, type InvestorStatementView } from '../application/investor-returns';
import { AsOfQuery, FinancingCreate, FinancingPageQuery, IdParam, InvestorDocumentCreate, PageQuery, RepaymentCreate, StatementQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Investor documents, payout details, statements, returns, loans and grants (FR-CAP-002, 013 to 015). The handlers authorise. */
@Controller()
export class InvestorBooksController {
  constructor(
    @Inject(InvestorProfiles) private readonly profiles: InvestorProfiles,
    @Inject(InvestorReturns) private readonly returns: InvestorReturns,
    @Inject(Financing) private readonly financing: Financing,
  ) {}

  @Get('investors/:id/documents')
  @Operation({ operationId: 'listInvestorDocuments', ...READ, permission: 'cap.investor.read' })
  listInvestorDocuments(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(PageQuery)) q: z.infer<typeof PageQuery>): Promise<Page<InvestorDocumentView>> {
    return this.profiles.listDocuments(actor, id, q.cursor, q.limit);
  }

  @Post('investors/:id/documents')
  @Operation({ operationId: 'addInvestorDocument', ...WRITE, permission: 'cap.investor.manage' })
  addInvestorDocument(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(InvestorDocumentCreate)) body: z.infer<typeof InvestorDocumentCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvestorDocumentView> {
    return reply(res, this.profiles.addDocument(actor, id, body, key));
  }

  @Get('investors/:id/payout-details')
  @Operation({ operationId: 'getInvestorPayoutDetails', ...READ, permission: 'cap.investor.payout.read' })
  getInvestorPayoutDetails(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<InvestorPayoutDetailsView> {
    return this.profiles.payoutDetails(actor, id);
  }

  @Get('investors/:id/statement')
  @Operation({ operationId: 'getInvestorStatement', ...READ, permission: 'cap.investor.read' })
  getInvestorStatement(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(StatementQuery)) q: z.infer<typeof StatementQuery>): Promise<InvestorStatementView> {
    return this.returns.investorStatement(actor, id, q.from ?? null, q.to ?? null);
  }

  @Get('investors/:id/returns')
  @Operation({ operationId: 'getInvestorReturns', ...READ, permission: 'cap.investor.read' })
  getInvestorReturns(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(AsOfQuery)) q: z.infer<typeof AsOfQuery>): Promise<InvestorReturnsView> {
    return this.returns.investorReturns(actor, id, q.asOf ?? null);
  }

  @Get('capital/returns')
  @Operation({ operationId: 'getOverallReturns', ...READ, permission: 'cap.capital.read' })
  getOverallReturns(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(AsOfQuery)) q: z.infer<typeof AsOfQuery>): Promise<InvestorReturnsView> {
    return this.returns.overallReturns(actor, q.asOf ?? null);
  }

  @Get('financing')
  @Operation({ operationId: 'listFinancing', ...READ, permission: 'cap.financing.read' })
  listFinancing(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(FinancingPageQuery)) q: z.infer<typeof FinancingPageQuery>): Promise<Page<FinancingView>> {
    return this.financing.list(actor, { kind: q.kind ?? null, status: q.status ?? null }, q.cursor, q.limit);
  }

  @Post('financing')
  @Operation({ operationId: 'createFinancing', ...WRITE, permission: 'cap.financing.manage' })
  createFinancing(@CurrentActor() actor: Actor | undefined, @Body(zodPipe(FinancingCreate)) body: z.infer<typeof FinancingCreate>, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<FinancingView> {
    return reply(res, this.financing.create(actor, body, key));
  }

  @Get('financing/:id')
  @Operation({ operationId: 'getFinancing', ...READ, permission: 'cap.financing.read' })
  getFinancing(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<FinancingView> {
    return this.financing.get(actor, id);
  }

  @Post('financing/:id/repayments')
  @Operation({ operationId: 'recordRepayment', ...WRITE, permission: 'cap.financing.manage' })
  recordRepayment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(RepaymentCreate)) body: z.infer<typeof RepaymentCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FinancingView> {
    return reply(res, this.financing.repay(actor, id, body, key));
  }
}
