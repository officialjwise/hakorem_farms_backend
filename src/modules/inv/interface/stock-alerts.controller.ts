import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Page } from '../application/stock-command';
import { StockAlerts, type ReorderRuleView, type StockAlertView } from '../application/stock-alerts';
import { IdParam, ListReorderRulesQuery, ListStockAlertsQuery, ReorderRuleCreate, ReorderRuleUpdate } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Reorder rules and the stock alerts they and the expiry job raise (FR-INV-015, FR-INV-016). Parses and delegates. */
@Controller()
export class StockAlertsController {
  constructor(@Inject(StockAlerts) private readonly alerts: StockAlerts) {}

  @Get('reorder-rules')
  @Operation({ operationId: 'listReorderRules', ...READ, permission: 'inv.reorder_rule.read' })
  listRules(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListReorderRulesQuery)) query: z.infer<typeof ListReorderRulesQuery>): Promise<Page<ReorderRuleView>> {
    const { cursor, limit, ...filters } = query;
    return this.alerts.listRules(actor, filters, cursor, limit);
  }

  @Post('reorder-rules')
  @Operation({ operationId: 'createReorderRule', ...WRITE, permission: 'inv.reorder_rule.manage' })
  createRule(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(ReorderRuleCreate)) body: z.infer<typeof ReorderRuleCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReorderRuleView> {
    return reply(res, this.alerts.createRule(actor, body, key));
  }

  @Patch('reorder-rules/:id')
  @Operation({ operationId: 'updateReorderRule', ...WRITE, permission: 'inv.reorder_rule.manage' })
  updateRule(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReorderRuleUpdate)) body: z.infer<typeof ReorderRuleUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReorderRuleView> {
    return reply(res, this.alerts.updateRule(actor, id, body, key));
  }

  @Get('stock/alerts')
  @Operation({ operationId: 'listStockAlerts', ...READ, permission: 'inv.stock.read' })
  listAlerts(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListStockAlertsQuery)) query: z.infer<typeof ListStockAlertsQuery>): Promise<Page<StockAlertView>> {
    const { cursor, limit, ...filters } = query;
    return this.alerts.listAlerts(actor, filters, cursor, limit);
  }
}
