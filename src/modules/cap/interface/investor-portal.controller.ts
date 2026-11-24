import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { CapitalTransactionView, Page } from '../application/capital';
import type { InvestorDocumentView } from '../application/investor-profiles';
import { InvestorPortal, type InvestorDistributionLineView, type InvestorPortalSummaryView } from '../application/investor-portal';
import type { InvestorStatementView } from '../application/investor-returns';
import { IdParam, MyStatementQuery, PageQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['INVESTOR'], permission: null, idempotent: false, csrf: false, rateLimit: 'console' } as const;

/** The investor portal (FR-IAM-013, FR-CAP-013): the signed-in investor's own record only. The handlers find it. */
@Controller()
export class InvestorPortalController {
  constructor(@Inject(InvestorPortal) private readonly portal: InvestorPortal) {}

  @Get('investor/me')
  @Operation({ operationId: 'getMyInvestorSummary', ...READ })
  getMyInvestorSummary(@CurrentActor() actor: Actor | undefined): Promise<InvestorPortalSummaryView> {
    return this.portal.summary(actor);
  }

  @Get('investor/capital-transactions')
  @Operation({ operationId: 'listMyCapitalTransactions', ...READ })
  listMyCapitalTransactions(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) q: z.infer<typeof PageQuery>): Promise<Page<CapitalTransactionView>> {
    return this.portal.capitalTransactions(actor, q.cursor, q.limit);
  }

  @Get('investor/distributions')
  @Operation({ operationId: 'listMyDistributions', ...READ })
  listMyDistributions(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) q: z.infer<typeof PageQuery>): Promise<Page<InvestorDistributionLineView>> {
    return this.portal.distributions(actor, q.cursor, q.limit);
  }

  @Get('investor/statement')
  @Operation({ operationId: 'getMyInvestorStatement', ...READ })
  getMyInvestorStatement(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(MyStatementQuery)) q: z.infer<typeof MyStatementQuery>): Promise<InvestorStatementView> {
    return this.portal.statement(actor, q.from, q.to);
  }

  @Get('investor/documents')
  @Operation({ operationId: 'listMyInvestorDocuments', ...READ })
  listMyInvestorDocuments(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) q: z.infer<typeof PageQuery>): Promise<Page<InvestorDocumentView>> {
    return this.portal.documents(actor, q.cursor, q.limit);
  }

  @Post('investor/documents/:id/download')
  @HttpCode(200)
  @Operation({ operationId: 'downloadMyInvestorDocument', ...READ, csrf: true })
  downloadMyInvestorDocument(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<{ readonly url: string; readonly expiresAt: string }> {
    return this.portal.download(actor, id);
  }
}
