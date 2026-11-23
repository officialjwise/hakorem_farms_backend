import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { SalesOrderView } from '../../ord';
import { Quotes, type ApprovalPendingView, type Page, type PublicQuoteView, type QuoteVersionView, type QuoteView } from '../application/quotes';
import { Rfqs, type RfqView } from '../application/rfqs';
import { IdParam, PageQuery, QuoteAcceptanceRecord, QuoteConvert, QuoteCreate, QuoteIssue, QuotePageQuery, QuoteVersionCreate, QuoteVersionUpdate, ReasonRequest, RfqCreate, RfqPageQuery, RfqUpdate } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Requests for quote taken by staff (FR-QUO-002). The controller parses and delegates; the handlers authorise. */
@Controller('rfqs')
export class RfqsController {
  constructor(@Inject(Rfqs) private readonly rfqs: Rfqs) {}

  @Get()
  @Operation({ operationId: 'listRfqs', ...READ, permission: 'quo.rfq.read' })
  listRfqs(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(RfqPageQuery)) q: z.infer<typeof RfqPageQuery>): Promise<Page<RfqView>> {
    return this.rfqs.list(actor, { status: q.status ?? null, source: q.source ?? null, assignedToId: q.assignedToId ?? null }, q.cursor, q.limit);
  }

  @Post()
  @Operation({ operationId: 'createRfq', ...WRITE, permission: 'quo.rfq.create' })
  createRfq(@CurrentActor() actor: Actor | undefined, @Body(zodPipe(RfqCreate)) body: z.infer<typeof RfqCreate>, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<RfqView> {
    return reply(res, this.rfqs.create(actor, body, key));
  }

  @Get(':id')
  @Operation({ operationId: 'getRfq', ...READ, permission: 'quo.rfq.read' })
  getRfq(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<RfqView> {
    return this.rfqs.get(actor, id);
  }

  @Patch(':id')
  @Operation({ operationId: 'updateRfq', ...WRITE, permission: 'quo.rfq.update' })
  updateRfq(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(RfqUpdate)) body: z.infer<typeof RfqUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RfqView> {
    return reply(res, this.rfqs.update(actor, id, body, key));
  }
}

/** Quotes and their versions (FR-QUO-003 to FR-QUO-011). The controller parses and delegates; the handlers authorise. */
@Controller()
export class QuotesController {
  constructor(@Inject(Quotes) private readonly quotes: Quotes) {}

  @Get('quotes')
  @Operation({ operationId: 'listQuotes', ...READ, permission: 'quo.quote.read' })
  listQuotes(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(QuotePageQuery)) q: z.infer<typeof QuotePageQuery>): Promise<Page<QuoteView>> {
    return this.quotes.list(actor, { status: q.status ?? null, customerId: q.customerId ?? null, salespersonId: q.salespersonId ?? null, from: q.from ?? null, to: q.to ?? null }, q.cursor, q.limit);
  }

  @Post('quotes')
  @Operation({ operationId: 'createQuote', ...WRITE, permission: 'quo.quote.create' })
  createQuote(@CurrentActor() actor: Actor | undefined, @Body(zodPipe(QuoteCreate)) body: z.infer<typeof QuoteCreate>, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<QuoteView> {
    return reply(res, this.quotes.create(actor, body, key));
  }

  @Get('quotes/:id')
  @Operation({ operationId: 'getQuote', ...READ, permission: 'quo.quote.read' })
  getQuote(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<QuoteView> {
    return this.quotes.get(actor, id);
  }

  @Get('quotes/:id/versions')
  @Operation({ operationId: 'listQuoteVersions', ...READ, permission: 'quo.quote.read' })
  listQuoteVersions(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(PageQuery)) q: z.infer<typeof PageQuery>): Promise<Page<QuoteVersionView>> {
    return this.quotes.versions(actor, id, q.cursor, q.limit);
  }

  @Post('quotes/:id/versions')
  @Operation({ operationId: 'reviseQuote', ...WRITE, permission: 'quo.quote.create' })
  reviseQuote(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(QuoteVersionCreate)) body: z.infer<typeof QuoteVersionCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteVersionView> {
    return reply(res, this.quotes.revise(actor, id, body, key));
  }

  @Put('quote-versions/:id')
  @Operation({ operationId: 'updateQuoteVersion', ...WRITE, permission: 'quo.quote.create' })
  updateQuoteVersion(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(QuoteVersionUpdate)) body: z.infer<typeof QuoteVersionUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteVersionView> {
    return reply(res, this.quotes.updateVersion(actor, id, body, key));
  }

  @Post('quote-versions/:id/issue')
  @Operation({ operationId: 'issueQuoteVersion', ...WRITE, permission: 'quo.quote.issue' })
  issueQuoteVersion(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(QuoteIssue)) body: z.infer<typeof QuoteIssue>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteVersionView | ApprovalPendingView> {
    return reply(res, this.quotes.issue(actor, id, body, key));
  }

  @Post('quotes/:id/record-acceptance')
  @Operation({ operationId: 'recordQuoteAcceptance', ...WRITE, permission: 'quo.quote.issue' })
  recordQuoteAcceptance(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(QuoteAcceptanceRecord)) body: z.infer<typeof QuoteAcceptanceRecord>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteView> {
    return reply(res, this.quotes.recordAcceptance(actor, id, body, key));
  }

  @Post('quotes/:id/decline')
  @Operation({ operationId: 'declineQuote', ...WRITE, permission: 'quo.quote.issue' })
  declineQuote(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteView> {
    return reply(res, this.quotes.decline(actor, id, body.reason, key));
  }

  @Post('quotes/:id/cancel')
  @Operation({ operationId: 'cancelQuote', ...WRITE, permission: 'quo.quote.issue' })
  cancelQuote(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteView> {
    return reply(res, this.quotes.cancel(actor, id, body.reason, key));
  }

  @Post('quotes/:id/convert')
  @Operation({ operationId: 'convertQuote', ...WRITE, permission: 'quo.quote.convert' })
  convertQuote(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(QuoteConvert)) body: z.infer<typeof QuoteConvert>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SalesOrderView> {
    return reply(res, this.quotes.convert(actor, id, body, key));
  }

  @Post('quote-links/:id/revoke')
  @Operation({ operationId: 'revokeQuoteLink', ...WRITE, permission: 'quo.quote.issue' })
  revokeQuoteLink(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteVersionView> {
    return reply(res, this.quotes.revokeLink(actor, id, body.reason, key));
  }
}

/** A signed-in customer's own quotes (FR-QUO-013, listMyQuotes): the handler finds the customer of the session. */
@Controller('me/quotes')
export class MyQuotesController {
  constructor(@Inject(Quotes) private readonly quotes: Quotes) {}

  @Get()
  @Operation({ operationId: 'listMyQuotes', access: 'SESSION', realms: ['CUSTOMER'], permission: null, idempotent: false, csrf: false, rateLimit: 'console' })
  listMyQuotes(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) q: z.infer<typeof PageQuery>): Promise<Page<PublicQuoteView>> {
    return this.quotes.mine(actor, q.cursor, q.limit);
  }
}
