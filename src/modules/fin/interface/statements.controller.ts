import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { FinancialStatements, REPORT_PERMISSION, type FinancialStatementView, type TrialBalanceView } from '../application/statements';
import { BalanceSheetQuery, StatementRangeQuery, TrialBalanceQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;

/** The financial statements (FR-FIN-011 to FR-FIN-013), read only. Parses and delegates; the handler authorises. */
@Controller('finance')
export class StatementsController {
  constructor(@Inject(FinancialStatements) private readonly statements: FinancialStatements) {}

  @Get('trial-balance')
  @Operation({ operationId: 'getTrialBalance', ...READ, permission: REPORT_PERMISSION })
  getTrialBalance(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(TrialBalanceQuery)) query: z.infer<typeof TrialBalanceQuery>): Promise<TrialBalanceView> {
    return this.statements.trialBalance(actor, query);
  }

  @Get('profit-and-loss')
  @Operation({ operationId: 'getProfitAndLoss', ...READ, permission: REPORT_PERMISSION })
  getProfitAndLoss(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(StatementRangeQuery)) query: z.infer<typeof StatementRangeQuery>): Promise<FinancialStatementView> {
    return this.statements.profitAndLoss(actor, query);
  }

  @Get('balance-sheet')
  @Operation({ operationId: 'getBalanceSheet', ...READ, permission: REPORT_PERMISSION })
  getBalanceSheet(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(BalanceSheetQuery)) query: z.infer<typeof BalanceSheetQuery>): Promise<FinancialStatementView> {
    return this.statements.balanceSheet(actor, query);
  }

  @Get('cash-flow')
  @Operation({ operationId: 'getCashFlow', ...READ, permission: REPORT_PERMISSION })
  getCashFlow(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(StatementRangeQuery)) query: z.infer<typeof StatementRangeQuery>): Promise<FinancialStatementView> {
    return this.statements.cashFlow(actor, query);
  }
}
