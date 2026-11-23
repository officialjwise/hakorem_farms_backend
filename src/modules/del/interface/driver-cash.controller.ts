import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { DriverCashReconciliations, type DriverCashReconciliationView, type DriverCashSummaryView, type Page } from '../application/driver-cash';
import { CashSummaryQuery, DriverCashReconciliationPageQuery, IdParam } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;

/**
 * A driver's cash (FR-DEL-010, CR-057): the driver's own cash still held, and the driver variance report. The hand-in
 * itself is taken at the till, on the receiving cashier's own open shift (POS's `handInDriverCash`). Parses and delegates.
 */
@Controller()
export class DriverCashController {
  constructor(@Inject(DriverCashReconciliations) private readonly cash: DriverCashReconciliations) {}

  @Get('driver/cash-summary')
  @Operation({ operationId: 'getMyCashSummary', ...READ, permission: 'del.delivery.read.assigned' })
  getMyCashSummary(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(CashSummaryQuery)) query: z.infer<typeof CashSummaryQuery>): Promise<DriverCashSummaryView> {
    return this.cash.summary(actor, query.date);
  }

  @Get('driver-cash-reconciliations')
  @Operation({ operationId: 'listDriverCashReconciliations', ...READ, permission: 'del.cash_reconciliation.read' })
  listDriverCashReconciliations(
    @CurrentActor() actor: Actor | undefined,
    @Query(zodPipe(DriverCashReconciliationPageQuery)) query: z.infer<typeof DriverCashReconciliationPageQuery>,
  ): Promise<Page<DriverCashReconciliationView>> {
    return this.cash.list(actor, { driverId: query.driverId ?? null, from: query.from ?? null, to: query.to ?? null, varianceOnly: query.varianceOnly ?? false }, query.cursor, query.limit);
  }

  @Get('driver-cash-reconciliations/:id')
  @Operation({ operationId: 'getDriverCashReconciliation', ...READ, permission: 'del.cash_reconciliation.read' })
  getDriverCashReconciliation(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<DriverCashReconciliationView> {
    return this.cash.get(actor, id);
  }
}
