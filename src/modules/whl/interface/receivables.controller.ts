import { Body, Controller, Get, Inject, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { Ageing, type AgeingReportView } from '../application/ageing';
import { BadDebts } from '../application/bad-debts';
import type { ApprovalPendingView } from '../application/business-accounts';
import { Dunning, type DunningLevelView, type DunningNoticeView } from '../application/dunning';
import type { Page } from '../application/statements';
import { AgeingQuery, BadDebtWriteOff, DunningNoticeQuery, DunningPolicyReplace, PageQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/** Receivables ageing, dunning and the bad-debt write-off (FR-WHL-010 to FR-WHL-012, B10 continued 2 and 3). The controller parses and delegates; the handlers authorise. */
@Controller()
export class ReceivablesController {
  constructor(
    @Inject(Ageing) private readonly ageing: Ageing,
    @Inject(Dunning) private readonly dunning: Dunning,
    @Inject(BadDebts) private readonly badDebts: BadDebts,
  ) {}

  @Post('receivables/write-offs')
  @Operation({ operationId: 'writeOffBadDebt', ...WRITE, permission: 'whl.bad_debt.write_off' })
  async writeOffBadDebt(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(BadDebtWriteOff)) body: z.infer<typeof BadDebtWriteOff>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalPendingView> {
    const response = await this.badDebts.writeOff(actor, body, key);
    res.status(response.status);
    return response.body;
  }

  @Get('receivables/ageing')
  @Operation({ operationId: 'getAgeingReport', ...READ, permission: 'whl.ageing.read' })
  getAgeingReport(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(AgeingQuery)) query: z.infer<typeof AgeingQuery>): Promise<AgeingReportView> {
    return this.ageing.report(actor, { asOf: query.asOf ?? null, customerId: query.customerId ?? null, accountManagerId: query.accountManagerId ?? null }, query.cursor, query.limit);
  }

  @Get('dunning-policy')
  @Operation({ operationId: 'listDunningLevels', ...READ, permission: 'whl.dunning.read' })
  listDunningLevels(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<DunningLevelView>> {
    return this.dunning.levels(actor, query.cursor, query.limit);
  }

  @Put('dunning-policy')
  @Operation({ operationId: 'replaceDunningLevels', ...WRITE, permission: 'whl.dunning.manage' })
  async replaceDunningLevels(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(DunningPolicyReplace)) body: z.infer<typeof DunningPolicyReplace>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Page<DunningLevelView>> {
    const response = await this.dunning.replace(actor, body.levels, key);
    res.status(response.status);
    return response.body;
  }

  @Get('dunning-notices')
  @Operation({ operationId: 'listDunningNotices', ...READ, permission: 'whl.dunning.read' })
  listDunningNotices(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(DunningNoticeQuery)) query: z.infer<typeof DunningNoticeQuery>): Promise<Page<DunningNoticeView>> {
    return this.dunning.notices(actor, { customerId: query.customerId ?? null, from: query.from ?? null }, query.cursor, query.limit);
  }
}
