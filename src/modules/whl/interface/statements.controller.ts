import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { Statements, type Page, type StatementView } from '../application/statements';
import { DocumentSendRequest, IdParam, StatementCreate, StatementPageQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/** Customer statements (FR-WHL-009, B08 continued 2d). The controller parses and delegates; the handlers authorise. */
@Controller()
export class StatementsController {
  constructor(@Inject(Statements) private readonly statements: Statements) {}

  @Get('statements')
  @Operation({ operationId: 'listStatements', ...READ, permission: 'whl.statement.read' })
  listStatements(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(StatementPageQuery)) query: z.infer<typeof StatementPageQuery>): Promise<Page<StatementView>> {
    return this.statements.list(actor, { customerId: query.customerId ?? null, periodEnd: query.periodEnd ?? null }, query.cursor, query.limit);
  }

  @Post('statements')
  @Operation({ operationId: 'createStatement', ...WRITE, permission: 'whl.statement.create' })
  async createStatement(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(StatementCreate)) body: z.infer<typeof StatementCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StatementView> {
    const response = await this.statements.create(actor, body, key);
    res.status(response.status);
    return response.body;
  }

  @Post('statements/:id/send')
  @Operation({ operationId: 'sendStatement', ...WRITE, permission: 'whl.statement.create' })
  async sendStatement(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(DocumentSendRequest)) body: z.infer<typeof DocumentSendRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ readonly status: 'QUEUED'; readonly message: string }> {
    const response = await this.statements.send(actor, id, body, key);
    res.status(response.status);
    return response.body;
  }

  @Get('statements/:id')
  @Operation({ operationId: 'getStatement', ...READ, permission: 'whl.statement.read' })
  getStatement(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StatementView> {
    return this.statements.get(actor, id);
  }
}
