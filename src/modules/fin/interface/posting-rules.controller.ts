import { Body, Controller, Get, Inject, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Page } from '../application/periods';
import { PostingRules, type AccountDeterminationView, type PostingEventTypeView, type PostingRuleView, type RuleChangePendingView } from '../application/posting-rules';
import { AccountDeterminationCreate, DeterminationPageQuery, EventTypePageQuery, PostingRuleCreate, RulePageQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Posting event types, rules and account determinations (FR-FIN-005), and changes to them under approval. */
@Controller('finance')
export class PostingRulesController {
  constructor(@Inject(PostingRules) private readonly rules: PostingRules) {}

  @Get('posting-event-types')
  @Operation({ operationId: 'listPostingEventTypes', ...READ, permission: 'fin.posting_rule.read' })
  listPostingEventTypes(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(EventTypePageQuery)) query: z.infer<typeof EventTypePageQuery>): Promise<Page<PostingEventTypeView>> {
    return this.rules.eventTypes(actor, query.cursor, query.limit);
  }

  @Get('posting-rules')
  @Operation({ operationId: 'listPostingRules', ...READ, permission: 'fin.posting_rule.read' })
  listPostingRules(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(RulePageQuery)) query: z.infer<typeof RulePageQuery>): Promise<Page<PostingRuleView>> {
    return this.rules.rules(actor, query, query.cursor, query.limit);
  }

  @Post('posting-rules')
  @Operation({ operationId: 'createPostingRule', ...WRITE, permission: 'fin.posting_rule.manage' })
  createPostingRule(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(PostingRuleCreate)) body: z.infer<typeof PostingRuleCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RuleChangePendingView> {
    return reply(res, this.rules.requestRule(actor, body, key));
  }

  @Get('account-determinations')
  @Operation({ operationId: 'listAccountDeterminations', ...READ, permission: 'fin.posting_rule.read' })
  listAccountDeterminations(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(DeterminationPageQuery)) query: z.infer<typeof DeterminationPageQuery>): Promise<Page<AccountDeterminationView>> {
    return this.rules.determinations(actor, query, query.cursor, query.limit);
  }

  @Post('account-determinations')
  @Operation({ operationId: 'createAccountDetermination', ...WRITE, permission: 'fin.posting_rule.manage' })
  createAccountDetermination(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(AccountDeterminationCreate)) body: z.infer<typeof AccountDeterminationCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RuleChangePendingView> {
    return reply(res, this.rules.requestDetermination(actor, body, key));
  }
}
