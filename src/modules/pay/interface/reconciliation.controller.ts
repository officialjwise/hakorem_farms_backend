import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { BreakQueue, type ReconciliationBreakView } from '../application/break-queue';
import type { Page } from '../application/payments';
import { Reconciliation, type BankStatementView, type SettlementReportView } from '../application/reconciliation';
import type { ApprovalPendingView } from '../application/refunds';
import { BankLineMatchBody, BreakPageQuery, BreakResolveBody, IdParam, SettlementImportBody, SettlementPageQuery, StatementImportBody, StatementPageQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Provider settlement reports, bank statements and the break queue (FR-PAY-016, FR-PAY-017, ADR-0065). Parses and delegates. */
@Controller('reconciliation')
export class ReconciliationController {
  constructor(
    @Inject(Reconciliation) private readonly reconciliation: Reconciliation,
    @Inject(BreakQueue) private readonly breaks: BreakQueue,
  ) {}

  @Get('settlement-reports')
  @Operation({ operationId: 'listSettlementReports', ...READ, permission: 'pay.reconciliation.read' })
  listSettlementReports(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(SettlementPageQuery)) q: z.infer<typeof SettlementPageQuery>): Promise<Page<SettlementReportView>> {
    return this.reconciliation.settlements(actor, { status: q.status ?? null, from: q.from ?? null, to: q.to ?? null }, q.cursor, q.limit);
  }

  @Post('settlement-reports')
  @Operation({ operationId: 'importSettlementReport', ...WRITE, permission: 'pay.reconciliation.manage' })
  importSettlementReport(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(SettlementImportBody)) body: z.infer<typeof SettlementImportBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementReportView> {
    return reply(res, this.reconciliation.importSettlement(actor, { provider: body.provider, fileId: body.fileId, bankAccountId: body.bankAccountId ?? null }, key));
  }

  @Get('settlement-reports/:id')
  @Operation({ operationId: 'getSettlementReport', ...READ, permission: 'pay.reconciliation.read' })
  getSettlementReport(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<SettlementReportView> {
    return this.reconciliation.settlement(actor, id);
  }

  @Post('settlement-reports/:id/match')
  @Operation({ operationId: 'matchSettlementReport', ...WRITE, permission: 'pay.reconciliation.manage' })
  matchSettlementReport(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<SettlementReportView> {
    return reply(res, this.reconciliation.matchSettlement(actor, id, key));
  }

  @Get('bank-statements')
  @Operation({ operationId: 'listBankStatements', ...READ, permission: 'pay.reconciliation.read' })
  listBankStatements(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(StatementPageQuery)) q: z.infer<typeof StatementPageQuery>): Promise<Page<BankStatementView>> {
    return this.reconciliation.statements(actor, { bankAccountId: q.bankAccountId ?? null, status: q.status ?? null }, q.cursor, q.limit);
  }

  @Post('bank-statements')
  @Operation({ operationId: 'importBankStatement', ...WRITE, permission: 'pay.reconciliation.manage' })
  importBankStatement(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(StatementImportBody)) body: z.infer<typeof StatementImportBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BankStatementView> {
    return reply(res, this.reconciliation.importStatement(actor, body, key));
  }

  @Get('bank-statements/:id')
  @Operation({ operationId: 'getBankStatement', ...READ, permission: 'pay.reconciliation.read' })
  getBankStatement(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<BankStatementView> {
    return this.reconciliation.statement(actor, id);
  }

  @Post('bank-statements/:id/match')
  @Operation({ operationId: 'matchBankStatement', ...WRITE, permission: 'pay.reconciliation.manage' })
  matchBankStatement(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<BankStatementView> {
    return reply(res, this.reconciliation.matchStatement(actor, id, key));
  }

  @Get('breaks')
  @Operation({ operationId: 'listReconciliationBreaks', ...READ, permission: 'pay.reconciliation.read' })
  listReconciliationBreaks(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(BreakPageQuery)) q: z.infer<typeof BreakPageQuery>): Promise<Page<ReconciliationBreakView>> {
    return this.breaks.list(actor, { status: q.status ?? null, kind: q.kind ?? null }, q.cursor, q.limit);
  }

  @Get('breaks/:id')
  @Operation({ operationId: 'getReconciliationBreak', ...READ, permission: 'pay.reconciliation.read' })
  getReconciliationBreak(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<ReconciliationBreakView> {
    return this.breaks.get(actor, id);
  }

  @Post('breaks/:id/resolve')
  @Operation({ operationId: 'resolveReconciliationBreak', ...WRITE, permission: 'pay.reconciliation.manage' })
  resolveReconciliationBreak(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(BreakResolveBody)) body: z.infer<typeof BreakResolveBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalPendingView> {
    return reply(res, this.breaks.resolve(actor, id, { note: body.note, posting: body.posting ?? 'NONE' }, key));
  }
}

/** One bank statement line matched by hand (`matchBankStatementLine`). */
@Controller('bank-statement-lines')
export class BankStatementLinesController {
  constructor(@Inject(Reconciliation) private readonly reconciliation: Reconciliation) {}

  @Post(':id/match')
  @Operation({ operationId: 'matchBankStatementLine', ...WRITE, permission: 'pay.reconciliation.manage' })
  matchBankStatementLine(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(BankLineMatchBody)) body: z.infer<typeof BankLineMatchBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BankStatementView> {
    return reply(res, this.reconciliation.matchLine(actor, id, { paymentId: body.paymentId ?? null, journalEntryId: body.journalEntryId ?? null }, key));
  }
}
