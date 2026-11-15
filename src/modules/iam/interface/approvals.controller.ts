import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Page } from '../application/access-admin';
import { ApprovalInbox, type ApprovalRequestView } from '../application/approval-inbox';
import { ApprovalDecision, IdParam, ListApprovalsQuery, ReasonRequest } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** The approval inbox and its decisions (FR-IAM-012, A-122). The controller parses and delegates; ApprovalInbox authorises. */
@Controller('iam/approvals')
export class ApprovalsController {
  constructor(@Inject(ApprovalInbox) private readonly inbox: ApprovalInbox) {}

  @Get()
  @Operation({ operationId: 'listApprovals', ...READ, permission: 'iam.approval.read' })
  listApprovals(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListApprovalsQuery)) query: z.infer<typeof ListApprovalsQuery>): Promise<Page<ApprovalRequestView>> {
    return this.inbox.listApprovals(actor, query, query.cursor, query.limit);
  }

  @Get(':id')
  @Operation({ operationId: 'getApproval', ...READ, permission: 'iam.approval.read' })
  getApproval(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<ApprovalRequestView> {
    return this.inbox.getApproval(actor, id);
  }

  @Post(':id/approve')
  @Operation({ operationId: 'approveRequest', ...WRITE, permission: null, permissionByPolicy: true })
  approveRequest(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ApprovalDecision)) body: z.infer<typeof ApprovalDecision>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalRequestView> {
    return reply(res, this.inbox.approveRequest(actor, id, body.reason, key));
  }

  @Post(':id/reject')
  @Operation({ operationId: 'rejectRequest', ...WRITE, permission: null, permissionByPolicy: true })
  rejectRequest(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalRequestView> {
    return reply(res, this.inbox.rejectRequest(actor, id, body.reason, key));
  }

  @Post(':id/cancel')
  @Operation({ operationId: 'cancelApprovalRequest', ...WRITE, permission: 'iam.approval.cancel.own' })
  cancelApprovalRequest(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalRequestView> {
    return reply(res, this.inbox.cancelApprovalRequest(actor, id, body.reason, key));
  }
}
