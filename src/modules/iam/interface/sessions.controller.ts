import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { SessionsService, type Page } from '../application/sessions.service';
import type { SessionRecordView } from '../application/session-view';
import { ListSessionsQuery, ReasonRequest, SessionIdParam } from './schemas';

/** The device list and forced logout (`listSessions`, `revokeSession`). */
@Controller('iam/sessions')
export class SessionsController {
  constructor(@Inject(SessionsService) private readonly sessions: SessionsService) {}

  @Get()
  @Operation({
    operationId: 'listSessions',
    access: 'SESSION',
    realms: ['STAFF'],
    permission: 'iam.session.read',
    idempotent: false,
    csrf: false,
    rateLimit: 'console',
  })
  listSessions(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListSessionsQuery)) query: z.infer<typeof ListSessionsQuery>): Promise<Page<SessionRecordView>> {
    return this.sessions.list(actor, query);
  }

  @Post(':id/revoke')
  @HttpCode(204)
  @Operation({
    operationId: 'revokeSession',
    access: 'SESSION',
    realms: ['STAFF'],
    permission: 'iam.session.revoke',
    idempotent: true,
    csrf: true,
    rateLimit: 'console',
  })
  async revokeSession(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(SessionIdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() idempotencyKey: string,
  ): Promise<void> {
    await this.sessions.revoke(actor, id, body.reason, idempotencyKey);
  }
}
